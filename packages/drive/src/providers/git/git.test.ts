// @vitest-environment node
import { describe, expect, it } from "vitest";
import { connectDrive, IRemoteFile } from "../../index";
import { Git } from "./git";
import { MockGitServer, REPO_URL } from "./git-test-server";
import { MemoryFs } from "./memoryfs";

function makeDrive(
  server: MockGitServer,
  serverOptions: Record<string, unknown> = {},
  context: { fs?: MemoryFs } = {},
): Git {
  return new Git(
    {
      authProvider: "password",
      user: "u",
      password: "p",
      serverOptions: {
        url: REPO_URL,
        branch: "main",
        path: "sync",
        flushDelay: 0,
        ...serverOptions,
      },
    },
    { fetch: server.fetch as unknown as typeof fetch, ...context },
  );
}

// Survives every provider operation EXCEPT a filesystem reset (re-clone),
// which makes it a precise probe for "did the provider reuse persisted state".
async function plantCanary(fs: MemoryFs): Promise<void> {
  await fs.writeFile("/repo/.git/canary", "keep-me");
}

async function canaryIntact(fs: MemoryFs): Promise<boolean> {
  try {
    return (await fs.readFile("/repo/.git/canary", "utf8")) === "keep-me";
  } catch {
    return false;
  }
}

async function collect(generator: AsyncGenerator<IRemoteFile[]>) {
  const all: IRemoteFile[] = [];
  for await (const page of generator) all.push(...page);
  return all;
}

function blobOf(text: string): Blob {
  return new Blob([text]);
}

async function textOf(blob: Blob): Promise<string> {
  return blob.text();
}

describe("Git drive provider", () => {
  it("rejects repository urls that are not https", () => {
    const options = { url: "git@github.com:owner/repo.git" };
    expect(() => makeDrive(new MockGitServer(), options)).toThrow(/https/i);
    expect(() =>
      makeDrive(new MockGitServer(), { url: "git://github.com/owner/repo.git" }),
    ).toThrow(/https/i);
    expect(() => makeDrive(new MockGitServer(), { url: "not a url" })).toThrow(/https/i);
  });

  it("connects through connectDrive when registered via options.providers", async () => {
    const server = new MockGitServer();
    const auth = {
      authProvider: "password" as const,
      user: "u",
      password: "p",
      serverOptions: { url: REPO_URL, path: "sync", flushDelay: 0 },
    };
    const drive = await connectDrive(
      { driveProvider: "git", auth },
      {
        providers: { git: Git },
        initialContext: { fetch: server.fetch as unknown as typeof fetch },
      },
    );
    expect(drive).toBeInstanceOf(Git);
    await expect(drive.getAccount()).resolves.toMatchObject({ id: "git", name: "Git" });

    // the main entry point does not bundle git; without registration it is unknown
    await expect(
      connectDrive(
        { driveProvider: "git", auth },
        { initialContext: { fetch: server.fetch as unknown as typeof fetch } },
      ),
    ).rejects.toThrow(/unknown drive provider/i);
  });

  it("lists an empty repository as no entries", async () => {
    const server = new MockGitServer();
    const drive = makeDrive(server);
    await server.commitFile("other.txt", "other"); // remote branch exists, but not our subdir
    const items = await collect(drive.list());
    expect(items).toEqual([]);
    expect(server.requests[0]).toMatchObject({
      method: "GET",
    });
    expect(server.requests[0].url).toContain("/info/refs?service=git-upload-pack");
    expect(server.requests[0].url).toContain("/owner/repo.git/");
    expect(server.lastAuth).toBe(`Basic ${btoa("u:p")}`);
  });

  it("bootstraps a brand new repository, stores content and maps ids", async () => {
    const server = new MockGitServer();
    const drive = makeDrive(server);

    const saved = await drive.put({ path: "a.txt" }, blobOf("hello"));
    expect(saved.id).toMatch(/^[0-9a-f]{40}$/);
    expect(saved.size).toBe(5);
    expect(await server.resolveRef("main")).toMatch(/^[0-9a-f]{40}$/);

    const nested = await drive.put({ path: "docs/b.md" }, blobOf("# doc"));

    const items = await collect(drive.list());
    expect(items.map((item) => item.name).sort()).toEqual(["a.txt", "docs"]);
    const doc = items.find((item) => item.name === "docs");
    expect(doc?.kind).toBe("folder");
    const file = items.find((item) => item.name === "a.txt");
    expect(file?.id).toBe(saved.id);

    const docsList = await collect(drive.list({ path: "docs" }));
    expect(docsList).toHaveLength(1);
    expect(docsList[0]).toMatchObject({ id: nested.id, name: "b.md", size: 5, kind: "file" });

    expect(await textOf(await drive.get({ path: "a.txt" }))).toBe("hello");
    expect(await textOf(await drive.get({ id: saved.id }))).toBe("hello");
    expect(await textOf(await drive.get({ path: "docs/b.md" }))).toBe("# doc");

    const found = await drive.find({ id: nested.id });
    expect(found).toMatchObject({ id: nested.id, name: "b.md", kind: "file", size: 5 });

    const negotiation = server.requests.map((request) => request.url);
    expect(negotiation.some((url) => url.includes("service=git-upload-pack"))).toBe(true);
    expect(negotiation.some((url) => url.includes("/git-upload-pack"))).toBe(true);
    expect(negotiation.some((url) => url.includes("service=git-receive-pack"))).toBe(true);
    expect(negotiation.some((url) => url.includes("/git-receive-pack"))).toBe(true);
  });

  it("keeps writes isolated to the configured path", async () => {
    const server = new MockGitServer([{ path: "root-level.txt", content: "not ours" }]);
    const drive = makeDrive(server);
    await drive.put({ path: "inside.txt" }, blobOf("mine"));
    const items = await collect(drive.list());
    expect(items.map((item) => item.name)).toEqual(["inside.txt"]);
    expect(server.wants.length).toBeGreaterThan(0);
  });

  it("removes files and folders", async () => {
    const server = new MockGitServer();
    const drive = makeDrive(server);
    await drive.put({ path: "a.txt" }, blobOf("a"));
    await drive.put({ path: "docs/b.md" }, blobOf("b"));
    const commitsBefore = await server.commitCount();

    await Promise.all([drive.remove({ path: "a.txt" }), drive.remove({ path: "docs" })]);
    expect(await server.commitCount()).toBe(commitsBefore + 1); // batched into one commit
    expect(await collect(drive.list())).toEqual([]);
  });

  it("batches concurrent writes into a single commit and push", async () => {
    const server = new MockGitServer();
    const drive = makeDrive(server, { flushDelay: 80 });
    await drive.put({ path: "warmup.txt" }, blobOf("w")); // establishes the branch
    const commitsBefore = await server.commitCount();
    const receivesBefore = server.requests.filter((request) =>
      request.url.endsWith("/git-receive-pack"),
    ).length;

    const results = await Promise.all([
      drive.put({ path: "one.txt" }, blobOf("1")),
      drive.put({ path: "two.txt" }, blobOf("2")),
      drive.put({ path: "three.txt" }, blobOf("3")),
    ]);
    expect(results).toHaveLength(3);
    expect(await server.commitCount()).toBe(commitsBefore + 1);
    expect(
      server.requests.filter((request) => request.url.endsWith("/git-receive-pack")).length,
    ).toBe(receivesBefore + 1);
    const items = await collect(drive.list());
    expect(items.map((item) => item.name).sort()).toEqual([
      "one.txt",
      "three.txt",
      "two.txt",
      "warmup.txt",
    ]);
  });

  it("flushes pending writes immediately when requested", async () => {
    const server = new MockGitServer();
    const drive = makeDrive(server, { flushDelay: 60_000 });
    const put = drive.put({ path: "late.txt" }, blobOf("late"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await server.commitCount()).toBe(0); // still waiting for the debounce
    await drive.flush();
    const saved = await put;
    expect(saved.name).toBe("late.txt");
    expect(await server.commitCount()).toBe(1);
  });

  it("flushes a write that is still being staged", async () => {
    const server = new MockGitServer();
    const drive = makeDrive(server, { flushDelay: 60_000 });
    const put = drive.put({ path: "late.txt" }, blobOf("late"));
    await drive.flush();
    const saved = await put;
    expect(saved.name).toBe("late.txt");
    expect(await server.commitCount()).toBe(1);
  });

  it("pushes with the default per-write behaviour when flushDelay is zero", async () => {
    const server = new MockGitServer();
    const drive = makeDrive(server, { flushDelay: 0 });
    await drive.put({ path: "x.txt" }, blobOf("x"));
    await drive.put({ path: "y.txt" }, blobOf("y"));
    expect(await server.commitCount()).toBe(2);
  });

  it("rejects on non-fast-forward pushes and recovers from the remote state", async () => {
    const server = new MockGitServer();
    const fs = new MemoryFs();
    const driveA = makeDrive(server, {}, { fs });
    await driveA.put({ path: "a.txt" }, blobOf("a"));
    await plantCanary(fs);

    // A second client advances the branch behind our back
    const driveB = makeDrive(server);
    await driveB.put({ path: "b.txt" }, blobOf("b"));

    await expect(driveA.put({ path: "c.txt" }, blobOf("c"))).rejects.toThrow();

    // conflict recovery realigns to the remote without wiping the object
    // store, so a persisted cache survives the race
    expect(await canaryIntact(fs)).toBe(true);

    // after the conflict the drive is hard-reset to the remote:
    const items = await collect(driveA.list());
    expect(items.map((item) => item.name).sort()).toEqual(["a.txt", "b.txt"]);

    // and further writes succeed again
    await driveA.put({ path: "d.txt" }, blobOf("d"));
    const after = await collect(driveA.list());
    expect(after.map((item) => item.name).sort()).toEqual(["a.txt", "b.txt", "d.txt"]);
  });

  it("hydrates a caller-persisted fs instead of re-cloning", async () => {
    const server = new MockGitServer();
    const fs = new MemoryFs();
    const driveA = makeDrive(server, {}, { fs });
    await driveA.put({ path: "a.txt" }, blobOf("a"));
    await plantCanary(fs);

    // a brand-new provider instance over the same persisted repo
    const driveB = makeDrive(server, {}, { fs });
    await driveB.put({ path: "b.txt" }, blobOf("b"));

    expect(await canaryIntact(fs)).toBe(true); // driveB hydrated instead of re-cloning
    expect(await textOf(await driveB.get({ path: "a.txt" }))).toBe("a");
    const items = await collect(driveB.list());
    expect(items.map((item) => item.name).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("self-heals an externally evicted fs", async () => {
    const server = new MockGitServer();
    const fs = new MemoryFs();
    const drive = makeDrive(server, {}, { fs });
    await drive.put({ path: "a.txt" }, blobOf("a"));

    fs.reset(); // the caller dropped the persisted state under our feet

    expect(await textOf(await drive.get({ path: "a.txt" }))).toBe("a");
    await drive.put({ path: "b.txt" }, blobOf("b"));
    const items = await collect(drive.list());
    expect(items.map((item) => item.name).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("self-heals individual missing objects", async () => {
    const server = new MockGitServer();
    const fs = new MemoryFs();
    const drive = makeDrive(server, {}, { fs });
    const saved = await drive.put({ path: "a.txt" }, blobOf("a"));

    const dir = saved.id.slice(0, 2);
    const file = saved.id.slice(2);
    await fs.rm(`/repo/.git/objects/${dir}/${file}`, { recursive: true, force: true });

    expect(await textOf(await drive.get({ path: "a.txt" }))).toBe("a");
    expect(await canaryIntact(fs)).toBe(false); // heal went through a clean re-clone
  });

  it("retries on http 429 responses", async () => {
    const server = new MockGitServer([{ path: "sync/pre.txt", content: "pre" }]);
    const drive = makeDrive(server);
    server.failNext429 = 1;
    const items = await collect(drive.list());
    expect(items.map((item) => item.name)).toEqual(["pre.txt"]);
    const infoRequests = server.requests.filter((request) => request.url.includes("/info/refs"));
    expect(infoRequests.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects escaping paths", async () => {
    const server = new MockGitServer();
    const drive = makeDrive(server);
    await expect(drive.put({ path: "../outside.txt" }, blobOf("x"))).rejects.toThrow();
    await expect(
      drive.put({ path: "sync/inside-via-escape.txt" }, blobOf("x")),
    ).resolves.toBeTruthy();
  });

  it("creates folders lazily", async () => {
    const server = new MockGitServer();
    const drive = makeDrive(server);
    const folder = await drive.mkdir({ parent: {}, name: "sub" });
    expect(folder).toMatchObject({ name: "sub", kind: "folder" });
    expect(await collect(drive.list())).toEqual([]); // nothing committed for empty folders
    await drive.put({ parent: { path: "sub" }, name: "f.txt" }, blobOf("f"));
    const items = await collect(drive.list());
    expect(items.map((item) => item.name)).toEqual(["sub"]);
    expect(items[0].kind).toBe("folder");
  });
});
