import * as git from "isomorphic-git";
import { MemoryFs } from "./memoryfs";

const ZERO_OID = "0000000000000000000000000000000000000000";
export const REPO_URL = "https://git.example.com/owner/repo.git";
const FLUSH = new TextEncoder().encode("0000");

function enc(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function pkt(value: string | Uint8Array): Uint8Array {
  const data = typeof value === "string" ? enc(value) : value;
  const out = new Uint8Array(4 + data.length);
  out.set(enc((data.length + 4).toString(16).padStart(4, "0")), 0);
  out.set(data, 4);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function bandPackets(payload: Uint8Array, chunkSize = 60000): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    const slice = payload.subarray(i, Math.min(i + chunkSize, payload.length));
    const data = new Uint8Array(slice.length + 1);
    data[0] = 1; // sideband data channel
    data.set(slice, 1);
    chunks.push(pkt(data));
  }
  return chunks;
}

interface PktParseResult {
  lines: (Uint8Array | null)[];
  rest: Uint8Array;
}

function readPktLines(bytes: Uint8Array): PktParseResult {
  const dec = new TextDecoder();
  const lines: (Uint8Array | null)[] = [];
  let i = 0;
  while (i + 4 <= bytes.length) {
    const head = dec.decode(bytes.subarray(i, i + 4));
    if (head === "0000") {
      lines.push(null); // flush
      i += 4;
      continue;
    }
    const size = parseInt(head, 16);
    if (isNaN(size) || size < 4 || i + size > bytes.length) break;
    lines.push(bytes.subarray(i + 4, i + size));
    i += size;
  }
  return { lines, rest: bytes.subarray(i) };
}

interface MockHeaders {
  forEach: (cb: (value: string, key: string) => void) => void;
  get: (name: string) => string | null;
}

interface MockResponse {
  ok: boolean;
  url: string;
  status: number;
  statusText: string;
  headers: MockHeaders;
  blob: () => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>;
}

export class MockGitServer {
  fs = new MemoryFs();
  dir = "/srv";
  gitdir = "/srv/.git";
  branch = "main";
  requests: { method: string; url: string }[] = [];
  lastAuth: string | undefined;
  wants: string[] = [];
  packSeq = 0;
  failNext429 = 0;
  #ready: Promise<void>;

  constructor(initialCommits: { path: string; content: string }[] = []) {
    this.#ready = this.#init(initialCommits);
  }

  async #init(initialCommits: { path: string; content: string }[]) {
    await git.init({
      fs: this.fs as never,
      dir: this.dir,
      gitdir: this.gitdir,
      defaultBranch: this.branch,
    });
    for (const file of initialCommits) {
      await this.#commitFile(file.path, file.content, "server commit");
    }
  }

  get ready(): Promise<void> {
    return this.#ready;
  }

  async resolveRef(ref: string): Promise<string | null> {
    const full = ref.includes("/") || ref === "HEAD" ? ref : `refs/heads/${ref}`;
    try {
      return await git.resolveRef({ fs: this.fs as never, gitdir: this.gitdir, ref: full });
    } catch {
      return null;
    }
  }

  async commitFile(path: string, content: string, message = "server commit") {
    await this.#ready;
    return this.#commitFile(path, content, message);
  }

  async #commitFile(path: string, content: string, message: string) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await this.fs.mkdir(`${this.dir}/${dir}`, { recursive: true });
    await this.fs.writeFile(`${this.dir}/${path}`, content);
    await git.add({ fs: this.fs as never, dir: this.dir, gitdir: this.gitdir, filepath: path });
    await git.commit({
      fs: this.fs as never,
      dir: this.dir,
      gitdir: this.gitdir,
      ref: `refs/heads/${this.branch}`,
      message,
      author: { name: "server", email: "server@git.example.com" },
    });
  }

  async commitCount(): Promise<number> {
    const head = await this.resolveRef(this.branch);
    if (!head) return 0;
    const commits = await git.log({
      fs: this.fs as never,
      dir: this.dir,
      gitdir: this.gitdir,
      ref: this.branch,
    });
    return commits.length;
  }

  fetch = async (input: URL | string, init?: RequestInit): Promise<MockResponse> => {
    await this.#ready;
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.requests.push({ method, url: url.toString() });

    this.lastAuth = new Headers(init?.headers).get("authorization") ?? undefined;
    if (this.failNext429 > 0) {
      this.failNext429 -= 1;
      return this.#response(url, 429, "Too Many Requests", new Uint8Array(), {
        "retry-after": "0.01",
      });
    }
    if (url.pathname.endsWith("/info/refs")) {
      const service = url.searchParams.get("service") || "git-upload-pack";
      return await this.#advertisement(url, service);
    }
    const body = init?.body
      ? new Uint8Array(await (init.body as Blob).arrayBuffer())
      : new Uint8Array();
    if (url.pathname.endsWith("/git-upload-pack")) return await this.#uploadPack(url, body);
    if (url.pathname.endsWith("/git-receive-pack")) return await this.#receivePack(url, body);
    return this.#response(url, 404, "Not Found", enc("repository not found"));
  };

  async #tip(): Promise<string | null> {
    return this.resolveRef(this.branch);
  }

  async #advertisement(url: URL, service: string): Promise<MockResponse> {
    const caps =
      service === "git-upload-pack"
        ? ["multi_ack", "no-done", "side-band-64k", "ofs-delta", "shallow", "agent=mock-git"]
        : ["report-status", "side-band-64k", "no-thin", "ofs-delta", "agent=mock-git"];
    const chunks: Uint8Array[] = [pkt(`# service=${service}\n`), FLUSH];
    const tip = await this.#tip();
    if (!tip) {
      chunks.push(pkt(`${ZERO_OID} capabilities^{}\0${caps.join(" ")}\n`));
    } else {
      chunks.push(
        pkt(`${tip} HEAD\0${[...caps, `symref=HEAD:refs/heads/${this.branch}`].join(" ")}\n`),
      );
      chunks.push(pkt(`${tip} refs/heads/${this.branch}\n`));
    }
    chunks.push(FLUSH);
    return this.#response(
      url,
      200,
      "OK",
      concat(chunks),
      { "content-type": `application/x-${service}-advertisement` },
      "smart http advertisement",
    );
  }

  async #collectOids(tipOid: string): Promise<string[]> {
    const visited = new Set<string>();
    const walk = async (oid: string): Promise<void> => {
      if (visited.has(oid)) return;
      visited.add(oid);
      const { type } = await git.readObject({
        fs: this.fs as never,
        dir: this.dir,
        gitdir: this.gitdir,
        oid,
      });
      if (type === "commit") {
        const { commit } = await git.readCommit({
          fs: this.fs as never,
          dir: this.dir,
          gitdir: this.gitdir,
          oid,
        });
        await walk(commit.tree);
        for (const parent of commit.parent) await walk(parent);
      } else if (type === "tree") {
        const { tree } = await git.readTree({
          fs: this.fs as never,
          dir: this.dir,
          gitdir: this.gitdir,
          oid,
        });
        for (const entry of tree) {
          if (entry.type === "blob") visited.add(entry.oid);
          else if (entry.type === "tree") await walk(entry.oid);
        }
      }
    };
    await walk(tipOid);
    return [...visited];
  }

  async #uploadPack(url: URL, request: Uint8Array): Promise<MockResponse> {
    const { lines } = readPktLines(request);
    for (const line of lines) {
      const text = line ? new TextDecoder().decode(line) : "";
      if (text.startsWith("want ")) this.wants.push(text.slice(5, 45));
    }
    const tip = await this.#tip();
    if (!tip) {
      return this.#response(url, 200, "OK", concat([pkt("NAK\n"), FLUSH]), {
        "content-type": "application/x-git-upload-pack-result",
      });
    }
    const oids = await this.#collectOids(tip);
    const { packfile } = await git.packObjects({
      fs: this.fs as never,
      dir: this.dir,
      gitdir: this.gitdir,
      oids,
      write: false,
    });
    const chunks = [pkt("NAK\n"), ...bandPackets(packfile!)];
    return this.#response(url, 200, "OK", concat(chunks), {
      "content-type": "application/x-git-upload-pack-result",
    });
  }

  async #isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.shift()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      try {
        const { commit } = await git.readCommit({
          fs: this.fs as never,
          dir: this.dir,
          gitdir: this.gitdir,
          oid,
        });
        queue.push(...commit.parent);
      } catch {
        // not a commit (or missing) - stop walking this line
      }
    }
    return false;
  }

  async #receivePack(url: URL, request: Uint8Array): Promise<MockResponse> {
    const { lines, rest } = readPktLines(request);
    const commands: { oldoid: string; oid: string; ref: string }[] = [];
    for (const line of lines) {
      if (!line) break;
      const text = new TextDecoder().decode(line).trim().split("\0")[0];
      const [oldoid, oid, ref] = text.split(" ");
      if (ref) commands.push({ oldoid, oid, ref });
    }
    if (rest.length > 12) {
      const name = `objects/pack/incoming-${this.packSeq}.pack`;
      this.packSeq += 1;
      await this.fs.writeFile(`${this.gitdir}/${name}`, rest);
      await git.indexPack({
        fs: this.fs as never,
        dir: this.gitdir,
        gitdir: this.gitdir,
        filepath: name,
      });
    }
    const report: string[] = ["unpack ok\n"];
    for (const command of commands) {
      if (command.oid === ZERO_OID) {
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      const current = await this.resolveRef(command.ref);
      let ok = true;
      if (current && current !== command.oid) {
        ok = await this.#isAncestor(current, command.oid);
      }
      if (ok) {
        await git.writeRef({
          fs: this.fs as never,
          dir: this.dir,
          gitdir: this.gitdir,
          ref: command.ref,
          value: command.oid,
          force: true,
        });
        report.push(`ok ${command.ref}\n`);
      } else {
        report.push(`NG ${command.ref} non-fast-forward\n`);
      }
    }
    const payload = bandPackets(concat(report.map((line) => pkt(line))));
    return this.#response(url, 200, "OK", concat(payload), {
      "content-type": "application/x-git-receive-pack-result",
    });
  }

  #response(
    url: URL,
    status: number,
    statusText: string,
    bytes: Uint8Array,
    headers: Record<string, string> = {},
    text?: string,
  ): MockResponse {
    const allHeaders: Record<string, string> = { ...headers };
    if (text !== undefined) allHeaders["x-mock-text"] = text;
    return {
      ok: status >= 200 && status < 300,
      url: url.toString(),
      status,
      statusText,
      headers: {
        forEach: (cb) => {
          for (const [key, value] of Object.entries(allHeaders)) cb(value, key);
        },
        get: (name) => allHeaders[name.toLowerCase()] ?? null,
      },
      blob: async () => ({
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer,
      }),
    };
  }
}

export function makeTestBlob(text: string): Blob {
  return new Blob([text]);
}
