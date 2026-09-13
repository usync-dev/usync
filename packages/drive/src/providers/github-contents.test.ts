import { describe, expect, it } from "vitest";
import type { IAuthConfig } from "../types";
import { GithubContents, RepoNotFoundError } from "./github-contents";

// Fake `fetch` matching `METHOD path` against canned responses, recording
// every call. No real network.
function makeFakeFetch(
  routes: Record<
    string,
    { status: number; body?: unknown } | ((init: RequestInit) => { status: number; body?: unknown })
  >,
) {
  const calls: { url: string; method: string; body?: unknown; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method || "GET").toUpperCase();
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}${parsed.search}`;
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body, headers });
    const entry = routes[key] ?? routes[`${method} ${parsed.pathname}`];
    if (!entry) {
      throw new Error(`Unhandled fake request: ${key}\nKnown routes: ${Object.keys(routes).join(", ")}`);
    }
    const { status, body: resBody } = typeof entry === "function" ? entry(init || {}) : entry;
    return new Response(resBody != null ? JSON.stringify(resBody) : null, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function makeDrive(fetchImpl: typeof fetch, serverOptions: Record<string, unknown> = {}) {
  const authConfig: IAuthConfig = {
    authProvider: "password",
    user: "",
    password: "test-token",
    serverOptions: { owner: "alice", repo: "scripts", ...serverOptions },
  };
  return new GithubContents(authConfig, { fetch: fetchImpl });
}

describe("GithubContents", () => {
  it("throws if owner/repo are missing", () => {
    const { fetchImpl } = makeFakeFetch({});
    expect(
      () =>
        new GithubContents(
          { authProvider: "password", user: "", password: "t", serverOptions: {} },
          { fetch: fetchImpl },
        ),
    ).toThrow(/owner and repo are required/);
  });

  it("sends the token as `Authorization: token <t>` with cache: no-store, against api.github.com by default", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      "GET /repos/alice/scripts/contents": { status: 200, body: [] },
    });
    const drive = makeDrive(fetchImpl);
    for await (const _batch of drive.list()) break;
    expect(calls[0].url).toBe("https://api.github.com/repos/alice/scripts/contents?ref=main");
    expect(calls[0].headers.get("authorization")).toBe("token test-token");
  });

  it("honors a custom apiBase (e.g. a self-hosted Gitea instance)", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      "GET /api/v1/repos/alice/scripts/contents": { status: 200, body: [] },
    });
    const drive = makeDrive(fetchImpl, { apiBase: "https://code.example.org/api/v1" });
    for await (const _batch of drive.list()) break;
    expect(calls[0].url).toBe("https://code.example.org/api/v1/repos/alice/scripts/contents?ref=main");
  });

  it("lists files, filtering out unsupported entry kinds and mapping dir->folder", async () => {
    const { fetchImpl } = makeFakeFetch({
      "GET /repos/alice/scripts/contents": {
        status: 200,
        body: [
          { name: "foo.user.js", path: "foo.user.js", sha: "sha1", size: 42, type: "file" },
          { name: "sub", path: "sub", sha: "sha2", size: 0, type: "dir" },
          { name: "weird", path: "weird", sha: "sha3", size: 0, type: "submodule" },
        ],
      },
    });
    const drive = makeDrive(fetchImpl);
    const batches: any[] = [];
    for await (const batch of drive.list()) batches.push(...batch);
    expect(batches).toEqual([
      { id: "foo.user.js", name: "foo.user.js", size: 42, kind: "file", modifiedTime: "" },
      { id: "sub", name: "sub", size: 0, kind: "folder", modifiedTime: "" },
    ]);
  });

  it("treats a 404 on an empty-but-existing repo as an empty listing, not an error", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      "GET /repos/alice/scripts/contents": { status: 404, body: { message: "Not Found" } },
      "GET /repos/alice/scripts": { status: 200, body: { full_name: "alice/scripts" } },
    });
    const drive = makeDrive(fetchImpl);
    const batches: any[] = [];
    for await (const batch of drive.list()) batches.push(...batch);
    expect(batches).toEqual([]);
    expect(calls.some((c) => c.url.endsWith("/repos/alice/scripts"))).toBe(true);
  });

  it("throws RepoNotFoundError when the repo itself does not exist", async () => {
    const { fetchImpl } = makeFakeFetch({
      "GET /repos/alice/scripts/contents": { status: 404, body: { message: "Not Found" } },
      "GET /repos/alice/scripts": { status: 404, body: { message: "Not Found" } },
    });
    const drive = makeDrive(fetchImpl);
    await expect(async () => {
      for await (const _batch of drive.list()) break;
    }).rejects.toThrow(RepoNotFoundError);
  });

  it("respects pathPrefix when listing and resolving items", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      "GET /repos/alice/scripts/contents/backup": {
        status: 200,
        body: [{ name: "a.user.js", path: "backup/a.user.js", sha: "s", size: 1, type: "file" }],
      },
    });
    const drive = makeDrive(fetchImpl, { pathPrefix: "backup" });
    const batches: any[] = [];
    for await (const batch of drive.list()) batches.push(...batch);
    expect(calls[0].url).toBe("https://api.github.com/repos/alice/scripts/contents/backup?ref=main");
    expect(batches[0].id).toBe("a.user.js");
  });

  it("round-trips binary content through put()/get() unchanged", async () => {
    const bytes = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x7f]);
    let stored: string | undefined;
    const { fetchImpl } = makeFakeFetch({
      "GET /repos/alice/scripts/contents/blob.bin": () =>
        stored === undefined
          ? { status: 404, body: { message: "Not Found" } }
          : {
              status: 200,
              body: { name: "blob.bin", path: "blob.bin", sha: "s1", size: bytes.length, type: "file", content: stored },
            },
      "PUT /repos/alice/scripts/contents/blob.bin": (init) => {
        stored = (JSON.parse(init.body as string) as { content: string }).content;
        return { status: 201, body: { content: { name: "blob.bin", path: "blob.bin", sha: "s2", size: bytes.length, type: "file" } } };
      },
    });
    const drive = makeDrive(fetchImpl);
    await drive.put({ path: "blob.bin" }, new Blob([bytes]));
    const blob = await drive.get({ path: "blob.bin" });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it("decodes base64 file content (including non-ASCII) in get()", async () => {
    const text = "// hello 世界\nconsole.log(1);";
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    // Real GitHub/Gitea responses wrap base64 with newlines.
    const content = `${btoa(binary).slice(0, 10)}\n${btoa(binary).slice(10)}`;
    const { fetchImpl } = makeFakeFetch({
      "GET /repos/alice/scripts/contents/foo.user.js": {
        status: 200,
        body: { name: "foo.user.js", path: "foo.user.js", sha: "s1", size: text.length, type: "file", content, encoding: "base64" },
      },
    });
    const drive = makeDrive(fetchImpl);
    const blob = await drive.get({ path: "foo.user.js" });
    expect(await blob.text()).toBe(text);
  });

  it("put() creates a new file without a sha when none exists yet, using PUT by default (GitHub)", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      "GET /repos/alice/scripts/contents/new.user.js": { status: 404, body: { message: "Not Found" } },
      "PUT /repos/alice/scripts/contents/new.user.js": {
        status: 201,
        body: { content: { name: "new.user.js", path: "new.user.js", sha: "newsha", size: 3, type: "file" } },
      },
    });
    const drive = makeDrive(fetchImpl);
    const item = await drive.put({ parent: {}, name: "new.user.js" }, new Blob(["abc"]));
    expect(item).toEqual({ id: "new.user.js", name: "new.user.js", size: 3, kind: "file", modifiedTime: "" });
    const putCall = calls.find((c) => c.method === "PUT")!;
    expect(putCall.body).not.toHaveProperty("sha");
  });

  it("put() creates via POST when createMethod is 'post' (Gitea/Forgejo)", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      "GET /repos/alice/scripts/contents/new.user.js": { status: 404, body: { message: "Not Found" } },
      "POST /repos/alice/scripts/contents/new.user.js": {
        status: 201,
        body: { content: { name: "new.user.js", path: "new.user.js", sha: "newsha", size: 3, type: "file" } },
      },
    });
    const drive = makeDrive(fetchImpl, { createMethod: "post" });
    await drive.put({ parent: {}, name: "new.user.js" }, new Blob(["abc"]));
    expect(calls.some((c) => c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("put() always uses PUT (with sha) to update an existing file, regardless of createMethod", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      "GET /repos/alice/scripts/contents/existing.user.js": {
        status: 200,
        body: { name: "existing.user.js", path: "existing.user.js", sha: "oldsha", size: 1, type: "file" },
      },
      "PUT /repos/alice/scripts/contents/existing.user.js": {
        status: 200,
        body: { content: { name: "existing.user.js", path: "existing.user.js", sha: "newsha", size: 3, type: "file" } },
      },
    });
    const drive = makeDrive(fetchImpl, { createMethod: "post" });
    await drive.put({ id: "existing.user.js" }, new Blob(["abc"]));
    const putCall = calls.find((c) => c.method === "PUT")!;
    expect(putCall.body).toMatchObject({ sha: "oldsha" });
  });

  it("put() retries once on a stale-sha 409 conflict, re-reading a fresh sha and succeeding", async () => {
    let getCount = 0;
    let putCount = 0;
    const { fetchImpl, calls } = makeFakeFetch({
      "GET /repos/alice/scripts/contents/race.user.js": () => {
        getCount += 1;
        return {
          status: 200,
          body: { name: "race.user.js", path: "race.user.js", sha: getCount === 1 ? "stale-sha" : "fresh-sha", size: 1, type: "file" },
        };
      },
      "PUT /repos/alice/scripts/contents/race.user.js": () => {
        putCount += 1;
        if (putCount === 1) return { status: 409, body: { message: "race.user.js does not match fresh-sha" } };
        return { status: 200, body: { content: { name: "race.user.js", path: "race.user.js", sha: "newest-sha", size: 3, type: "file" } } };
      },
    });
    const drive = makeDrive(fetchImpl);
    await drive.put({ id: "race.user.js" }, new Blob(["abc"]));
    expect(getCount).toBe(2);
    expect(putCount).toBe(2);
    const putCalls = calls.filter((c) => c.method === "PUT");
    expect(putCalls[0].body).toMatchObject({ sha: "stale-sha" });
    expect(putCalls[1].body).toMatchObject({ sha: "fresh-sha" });
  });

  it("put() surfaces a 409 that persists past the retry, rather than looping or swallowing it", async () => {
    const { fetchImpl } = makeFakeFetch({
      "GET /repos/alice/scripts/contents/stuck.user.js": {
        status: 200,
        body: { name: "stuck.user.js", path: "stuck.user.js", sha: "some-sha", size: 1, type: "file" },
      },
      "PUT /repos/alice/scripts/contents/stuck.user.js": {
        status: 409,
        body: { message: "stuck.user.js does not match some-sha" },
      },
    });
    const drive = makeDrive(fetchImpl);
    await expect(drive.put({ id: "stuck.user.js" }, new Blob(["abc"]))).rejects.toThrow();
  });

  it("remove() looks up the current sha, then deletes with it", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      "GET /repos/alice/scripts/contents/gone.user.js": {
        status: 200,
        body: { name: "gone.user.js", path: "gone.user.js", sha: "deadbeef", size: 1, type: "file" },
      },
      "DELETE /repos/alice/scripts/contents/gone.user.js": { status: 200, body: { commit: {} } },
    });
    const drive = makeDrive(fetchImpl);
    await drive.remove({ path: "gone.user.js" });
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.body).toMatchObject({ sha: "deadbeef" });
  });

  it("remove() retries once on a stale-sha 409 conflict", async () => {
    let getCount = 0;
    let delCount = 0;
    const { fetchImpl } = makeFakeFetch({
      "GET /repos/alice/scripts/contents/gone-race.user.js": () => {
        getCount += 1;
        return {
          status: 200,
          body: { name: "gone-race.user.js", path: "gone-race.user.js", sha: getCount === 1 ? "stale-sha" : "fresh-sha", size: 1, type: "file" },
        };
      },
      "DELETE /repos/alice/scripts/contents/gone-race.user.js": () => {
        delCount += 1;
        return delCount === 1
          ? { status: 409, body: { message: "gone-race.user.js does not match fresh-sha" } }
          : { status: 200, body: { commit: {} } };
      },
    });
    const drive = makeDrive(fetchImpl);
    await drive.remove({ path: "gone-race.user.js" });
    expect(getCount).toBe(2);
    expect(delCount).toBe(2);
  });

  it("mkdir() is unsupported (git hosts have no real empty folders)", async () => {
    const { fetchImpl } = makeFakeFetch({});
    const drive = makeDrive(fetchImpl);
    await expect(drive.mkdir({ parent: {}, name: "x" })).rejects.toThrow();
  });
});
