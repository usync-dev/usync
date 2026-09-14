import { b64encode, hexEncode } from "@usync/util";

interface FsEntry {
  type: "file" | "dir" | "symlink";
  data: Uint8Array | null;
  target: string;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface FsError extends Error {
  code: string;
  syscall: string;
  path: string;
}

export interface FsStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mode: number;
  type: number;
  ino: number;
  dev: number;
  nlink: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  ctimeMs: number;
  atimeMs: number;
  birthtimeMs: number;
  mtime: Date;
  ctime: Date;
  atime: Date;
}

export type FsEncoding = "utf8" | "utf-8" | "base64" | "hex" | undefined;

/**
 * The filesystem contract of the `Git` drive provider, passed via
 * `DriveContext.fs` to control where repository state lives. Must match
 * isomorphic-git's `FsClient` API, including the POSIX error codes it relies
 * on for control flow.
 */
export interface IGitFs {
  /** Node-style `fs.promises` handle; point it at the same methods. */
  promises: IGitFs;
  /**
   * Discards all repository state, including caller-persisted data. The
   * provider calls it before a fresh clone or a corrupt-cache recovery.
   */
  reset(): void;
  readFile(
    path: string,
    options?: { encoding?: FsEncoding } | FsEncoding,
  ): Promise<Uint8Array | string>;
  writeFile(
    path: string,
    data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
    options?: { encoding?: string } | string,
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number } | number): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FsStats>;
  lstat(path: string): Promise<FsStats>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;

function fsError(code: string, message: string, syscall: string, path: string): FsError {
  const error = new Error(`${code}: ${message}, ${syscall} '${path}'`) as FsError;
  error.code = code;
  error.syscall = syscall;
  error.path = path;
  return error;
}

export function normalizePath(input: string): string {
  const parts = String(input ?? "").split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `/${stack.join("/")}`;
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
}

function toBytes(data: Uint8Array | ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/** Default in-memory `IGitFs` implementation. */
export class MemoryFs implements IGitFs {
  #entries = new Map<string, FsEntry>();
  #nextIno = 1;

  promises: this;

  constructor() {
    this.promises = this;
    this.reset();
  }

  reset(): void {
    this.#entries = new Map();
    this.#nextIno = 1;
    this.#addEntry("/", {
      type: "dir",
      data: null,
      target: "",
      mode: DIR_MODE,
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      ino: this.#nextIno++,
    });
  }

  #addEntry(path: string, entry: FsEntry): FsEntry {
    this.#entries.set(path, entry);
    return entry;
  }

  #raw(path: string): FsEntry | undefined {
    return this.#entries.get(path);
  }

  #resolve(path: string, syscall: string, follow: boolean): FsEntry {
    const segments = path === "/" ? [] : path.slice(1).split("/");
    let current = "/";
    for (let i = 0; i < segments.length; i += 1) {
      const node = this.#raw(current);
      if (!node) throw fsError("ENOENT", "no such file or directory", syscall, path);
      if (node.type !== "dir") {
        throw fsError("ENOTDIR", "not a directory", syscall, path);
      }
      current = joinPath(current, segments[i]);
    }
    let entry = this.#raw(current);
    if (!entry) throw fsError("ENOENT", "no such file or directory", syscall, path);
    let links = 0;
    while (follow && entry.type === "symlink") {
      if (links++ > 10)
        throw fsError("ELOOP", "too many symbolic links encountered", syscall, path);
      const target = normalizePath(joinPath(parentPath(current), entry.target));
      const next = this.#raw(target);
      if (!next) throw fsError("ENOENT", "no such file or directory", syscall, path);
      entry = next;
    }
    return entry;
  }

  #requireParent(path: string, syscall: string): void {
    const parent = parentPath(path);
    const entry = this.#raw(parent);
    if (!entry) throw fsError("ENOENT", "no such file or directory", syscall, path);
    if (entry.type !== "dir") throw fsError("ENOTDIR", "not a directory", syscall, path);
  }

  #childKeys(path: string): string[] {
    const prefix = path === "/" ? "/" : `${path}/`;
    const names: string[] = [];
    for (const key of this.#entries.keys()) {
      if (key === path || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) continue;
      names.push(rest);
    }
    return names;
  }

  async readFile(
    path: string,
    options?: { encoding?: FsEncoding } | FsEncoding,
  ): Promise<Uint8Array | string> {
    if (path === undefined || path === null) {
      throw fsError("ENOENT", "no such file or directory", "open", String(path));
    }
    const normalized = normalizePath(path);
    const entry = this.#resolve(normalized, "open", true);
    if (entry.type === "dir") {
      throw fsError("EISDIR", "illegal operation on a directory", "read", normalized);
    }
    const data = entry.type === "symlink" ? toBytes(entry.target) : entry.data!;
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (!encoding) return new Uint8Array(data);
    if (encoding === "utf8" || encoding === "utf-8") return new TextDecoder().decode(data);
    if (encoding === "base64") return b64encode(data);
    if (encoding === "hex") return hexEncode(data);
    throw fsError(
      "ERR_ENCODING_INVALID_ENCODED_DATA",
      `unknown encoding: ${encoding}`,
      "read",
      normalized,
    );
  }

  async writeFile(
    path: string,
    data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
    _options?: { encoding?: string } | string,
  ): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === "/")
      throw fsError("EISDIR", "illegal operation on a directory", "open", normalized);
    this.#requireParent(normalized, "open");
    const bytes = toBytes(typeof data === "string" ? data : data);
    const existing = this.#raw(normalized);
    if (existing?.type === "dir") {
      throw fsError("EISDIR", "illegal operation on a directory", "open", normalized);
    }
    const now = Date.now();
    if (existing && existing.type === "file") {
      existing.data = new Uint8Array(bytes);
      existing.mtimeMs = now;
      return;
    }
    this.#addEntry(normalized, {
      type: "file",
      data: new Uint8Array(bytes),
      target: "",
      mode: FILE_MODE,
      mtimeMs: now,
      ctimeMs: now,
      ino: this.#nextIno++,
    });
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number } | number,
  ): Promise<void> {
    const normalized = normalizePath(path);
    const recursive = typeof options === "object" && options ? !!options.recursive : false;
    if (normalized === "/") {
      if (recursive) return;
      throw fsError("EEXIST", "file already exists", "mkdir", normalized);
    }
    if (recursive) {
      const segments = normalized.slice(1).split("/");
      let current = "";
      for (const segment of segments) {
        current = `${current}/${segment}`;
        const entry = this.#raw(current);
        if (entry) {
          if (entry.type !== "dir") throw fsError("ENOTDIR", "not a directory", "mkdir", current);
          continue;
        }
        this.#addEntry(current, {
          type: "dir",
          data: null,
          target: "",
          mode: DIR_MODE,
          mtimeMs: Date.now(),
          ctimeMs: Date.now(),
          ino: this.#nextIno++,
        });
      }
      return;
    }
    this.#requireParent(normalized, "mkdir");
    if (this.#raw(normalized)) throw fsError("EEXIST", "file already exists", "mkdir", normalized);
    this.#addEntry(normalized, {
      type: "dir",
      data: null,
      target: "",
      mode: DIR_MODE,
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      ino: this.#nextIno++,
    });
  }

  async rmdir(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === "/") throw fsError("EBUSY", "resource busy or locked", "rmdir", normalized);
    const entry = this.#resolve(normalized, "rmdir", false);
    if (entry.type !== "dir") throw fsError("ENOTDIR", "not a directory", "rmdir", normalized);
    if (this.#childKeys(normalized).length > 0) {
      throw fsError("ENOTEMPTY", "directory not empty", "rmdir", normalized);
    }
    this.#entries.delete(normalized);
  }

  async unlink(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const entry = this.#resolve(normalized, "unlink", false);
    if (entry.type === "dir")
      throw fsError("EISDIR", "illegal operation on a directory", "unlink", normalized);
    this.#entries.delete(normalized);
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean; maxRetries?: number },
  ): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === "/") {
      if (options?.force) return;
      throw fsError("ENOENT", "no such file or directory", "rm", normalized);
    }
    const entry = this.#raw(normalized);
    if (!entry) {
      if (options?.force) return;
      throw fsError("ENOENT", "no such file or directory", "rm", normalized);
    }
    if (entry.type === "dir" && !options?.recursive && this.#childKeys(normalized).length > 0) {
      throw fsError("ENOTEMPTY", "directory not empty", "rm", normalized);
    }
    const prefix = `${normalized}/`;
    for (const key of this.#entries.keys()) {
      if (key === normalized || key.startsWith(prefix)) this.#entries.delete(key);
    }
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);
    const entry = this.#resolve(normalized, "scandir", true);
    if (entry.type !== "dir") throw fsError("ENOTDIR", "not a directory", "scandir", normalized);
    return this.#childKeys(normalized);
  }

  async stat(path: string): Promise<FsStats> {
    return this.#stats(path, true);
  }

  async lstat(path: string): Promise<FsStats> {
    return this.#stats(path, false);
  }

  #stats(path: string, follow: boolean): FsStats {
    const normalized = normalizePath(path);
    const entry = this.#resolve(normalized, "stat", follow);
    const size =
      entry.type === "file"
        ? entry.data!.length
        : entry.type === "symlink"
          ? entry.target.length
          : 0;
    return {
      isFile: () => entry.type === "file",
      isDirectory: () => entry.type === "dir",
      isSymbolicLink: () => entry.type === "symlink",
      size,
      mode: entry.mode,
      type: entry.type === "dir" ? 2 : entry.type === "symlink" ? 10 : 1,
      ino: entry.ino,
      dev: 1,
      nlink: 1,
      uid: 0,
      gid: 0,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
      atimeMs: entry.mtimeMs,
      birthtimeMs: entry.ctimeMs,
      mtime: new Date(entry.mtimeMs),
      ctime: new Date(entry.ctimeMs),
      atime: new Date(entry.mtimeMs),
    };
  }

  async readlink(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const entry = this.#resolve(normalized, "readlink", false);
    if (entry.type !== "symlink")
      throw fsError("EINVAL", "invalid argument", "readlink", normalized);
    return entry.target;
  }

  async symlink(target: string, path: string): Promise<void> {
    void target;
    void path;
    throw fsError("ENOSYS", "function not implemented", "symlink", String(path));
  }

  async chmod(path: string, mode: number): Promise<void> {
    const entry = this.#raw(normalizePath(path));
    if (!entry) throw fsError("ENOENT", "no such file or directory", "chmod", String(path));
    entry.mode = mode;
  }

  async chown(): Promise<void> {
    // no-op
  }
}
