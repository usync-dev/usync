import * as git from "isomorphic-git";

import type { ChildRef, EntryRef, IAuthConfig, IRemoteFile } from "../../types";
import { b64encode } from "@usync/util";
import { SimpleRequestError } from "../../util";
import {
  AuthenticatedDriveBase,
  type DriveContext,
  type IRequestFunction,
  type ITypedRequestOptions,
  withDelay,
} from "../base";
import type { IGitFs } from "./memoryfs";
import { MemoryFs } from "./memoryfs";

export interface IGitServerOptions {
  /** HTTPS clone url, e.g. `https://host/user/repo.git` */
  url: string;
  /** Branch to sync with, defaults to `main` */
  branch?: string;
  /** Sub directory holding the synced files, defaults to the repo root */
  path?: string;
  /** Debounce in ms for batching writes into one commit+push, defaults to 2000 */
  flushDelay?: number;
  /** Commit author email, defaults to `<user>@usync.invalid` */
  email?: string;
  /** Talk to the remote without credentials */
  anonymous?: boolean;
  id?: string;
  name?: string;
  avatar?: string;
}

interface GitHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: AsyncIterable<Uint8Array> | Uint8Array;
  signal?: AbortSignal;
}

interface GitHttpResponse {
  url: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: Uint8Array[];
}

interface GitTreeEntry {
  mode: number;
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

interface DeferredBatch {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface ResolvedEntry {
  path: string;
  oid: string;
  kind: "file" | "folder";
}

const DEFAULT_COMMIT_DELAY = 2000;
const OID_RE = /^[0-9a-f]{40}$/;

function cleanRepoPath(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    for (const segment of part.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (!segments.length) throw new Error("Invalid path");
        segments.pop();
        continue;
      }
      segments.push(segment);
    }
  }
  return segments.join("/");
}

async function collectBytes(
  body: AsyncIterable<Uint8Array | ArrayBufferView> | Uint8Array,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const push = (chunk: Uint8Array | ArrayBufferView) => {
    const bytes =
      chunk instanceof Uint8Array ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer);
    chunks.push(bytes);
    size += bytes.length;
  };
  if (body instanceof Uint8Array) {
    push(body);
  } else {
    for await (const chunk of body) push(chunk);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function isMissingRepoError(error: unknown): boolean {
  const err = error as { name?: string; data?: { statusCode?: number } };
  if (
    err?.name === "NotFoundError" ||
    err?.name === "EmptyServerResponseError" ||
    err?.name === "MergeBaseNotFound" ||
    err?.name === "UnknownTransportError"
  ) {
    return true;
  }
  if (err?.name === "HttpError" && err.data?.statusCode === 404) return true;
  return false;
}

function isCorruptRepoError(error: unknown): boolean {
  const err = error as { name?: string; code?: string };
  return (
    err?.name === "MissingObjectError" ||
    err?.name === "InternalError" ||
    err?.name === "NoRefspecError" ||
    err?.code === "ENOENT" ||
    err?.code === "ENOPKG"
  );
}

function isPushConflictError(error: unknown): boolean {
  const err = error as { name?: string; message?: string; data?: { reason?: string } };
  if (err?.name === "PushRejectedError") return err.data?.reason !== "tag-exists";
  if (err?.name === "GitPushError") {
    return /fast.?forward|stale|behind|missing|non-existent/i.test(err.message || "");
  }
  if (err?.name === "NotFoundError" || err?.name === "MissingObjectError") return true;
  return false;
}

/**
 * Syncs against any git repository over smart-HTTP. Writes are batched into a
 * commit+push after a debounce delay; conflicts are thrown to the consumer.
 * Repository state lives in `context.fs` (`IGitFs`, in-memory by default) —
 * pass a persistent one to cache the clone across sessions. The remote branch
 * is the source of truth; corrupt state self-heals by re-cloning.
 */
export class Git extends AuthenticatedDriveBase {
  constructor(authConfig: IAuthConfig, context?: DriveContext) {
    super(authConfig, context);
    const options = (authConfig.serverOptions ?? {}) as unknown as IGitServerOptions;
    this.#repoUrl = Git.#normalizeRepoUrl(options.url);
    this.#branch = cleanRepoPath(options.branch || "main");
    this.#headRef = `refs/heads/${this.#branch}`;
    this.#rootPath = cleanRepoPath(options.path || "");
    this.#email = options.email || "";
    this.#flushDelay =
      typeof options.flushDelay === "number" && options.flushDelay >= 0
        ? options.flushDelay
        : DEFAULT_COMMIT_DELAY;
    this.#gitHttp = { request: (request) => this.#gitRequest(request) };
    if (context?.fs) this.#fs = context.fs;
  }

  static #normalizeRepoUrl(url: string): string {
    if (typeof url !== "string" || !url.trim()) {
      throw new Error("A git repository url is required");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(
        `Invalid git repository url "${url}": the Git drive only supports https:// clone urls`,
      );
    }
    if (parsed.protocol !== "https:") {
      throw new Error(
        `Invalid git repository url "${url}": the Git drive only supports https:// clone urls`,
      );
    }
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/") {
      throw new Error(`Invalid git repository url "${url}": missing repository path`);
    }
    if (!/\.git$/i.test(pathname)) parsed.pathname = `${pathname}.git`;
    return parsed.toString();
  }

  #fs: IGitFs = new MemoryFs();
  #dir = "/repo";
  #gitdir = "/repo/.git";
  #repoUrl = "";
  #branch = "main";
  #headRef = "refs/heads/main";
  #rootPath = "";
  #email = "";
  #flushDelay = DEFAULT_COMMIT_DELAY;
  #gitHttp!: { request(request: GitHttpRequest): Promise<GitHttpResponse> };
  #ready = false;
  #lock: Promise<unknown> = Promise.resolve();
  #batch: DeferredBatch | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pendingPush = false;

  initRequest(): IRequestFunction {
    let request: IRequestFunction = async <T>(url: string, options: ITypedRequestOptions) => {
      const { responseType: _responseType, headers: inputHeaders, ...rest } = options;
      const headers = new Headers(inputHeaders);
      const { user, password, serverOptions } = this.authConfig;
      if (!(serverOptions as IGitServerOptions | undefined)?.anonymous && user) {
        const auth = b64encode(new TextEncoder().encode(`${user}:${password ?? ""}`));
        headers.set("authorization", `Basic ${auth}`);
      }
      const response = await (this.context?.fetch ?? fetch)(new URL(url), {
        // The remote is authenticated by the Authorization header only
        credentials: "omit",
        ...rest,
        headers,
      });
      const blob = await response.blob();
      if (!response.ok) {
        throw new SimpleRequestError(
          response.statusText || `HTTP ${response.status}`,
          { url, method: rest.method || "GET" },
          response,
          { response, blob },
        );
      }
      return { response, blob } as unknown as T;
    };
    request = withDelay(request);
    return request;
  }

  async getAccount() {
    const serverOptions = (this.authConfig.serverOptions ?? {}) as unknown as IGitServerOptions;
    this.account = {
      id: `${serverOptions.id || "git"}`,
      name: `${serverOptions.name || "Git"}`,
      avatar: `${serverOptions.avatar || ""}`,
    };
    return this.account;
  }

  /** Push everything staged so far without waiting for the debounce delay. */
  async flush(): Promise<void> {
    // the lock queues behind any in-flight staging so its batch is registered
    // before we decide there is nothing to drain
    await this.#withLock(() => this.#drain(), false);
  }

  async *list(parent?: EntryRef): AsyncGenerator<IRemoteFile[]> {
    yield await this.#withLock(async () => {
      await this.#ensureRepo();
      await this.#refreshRemote();
      const path =
        parent?.id && OID_RE.test(parent.id) && !parent.path
          ? ((await this.#findByOid(parent.id))?.path ?? "")
          : this.#userPath(parent);
      return await this.#listPath(path);
    });
  }

  async find(param: EntryRef): Promise<IRemoteFile> {
    return this.#withLock(async () => {
      await this.#ensureRepo();
      await this.#refreshRemote();
      const entry = await this.#resolveEntry(param);
      if (!entry) throw new Error("Item not found");
      return await this.#entryToItem(entry);
    });
  }

  async get(param: EntryRef): Promise<Blob> {
    return this.#withLock(async () => {
      await this.#ensureRepo();
      await this.#refreshRemote();
      const entry = await this.#resolveEntry(param);
      if (!entry || entry.kind !== "file") throw new Error("Item not found");
      const { blob } = await git.readBlob({
        fs: this.#fs as never,
        dir: this.#dir,
        gitdir: this.#gitdir,
        oid: entry.oid,
      });
      return new Blob([new Uint8Array(blob)]);
    });
  }

  async mkdir(param: ChildRef): Promise<IRemoteFile> {
    return this.#withLock(async () => {
      await this.#ensureRepo();
      await this.#refreshRemote();
      const path = await this.#refPath(param);
      if (path && (await this.#resolveByPath(path))) throw new Error("Item already exists");
      return {
        id: path || "/",
        name: param.name,
        size: 0,
        kind: "folder",
        modifiedTime: new Date().toISOString(),
      };
    });
  }

  async remove(param: EntryRef): Promise<void> {
    const batch = await this.#withLock(async () => {
      await this.#ensureRepo();
      const path = await this.#refPath(param);
      if (!path) throw new Error("Invalid path");
      const rel = this.#repoPath(path, false);
      try {
        await git.remove({
          fs: this.#fs as never,
          dir: this.#dir,
          gitdir: this.#gitdir,
          filepath: rel,
        });
      } catch (error) {
        if ((error as { name?: string })?.name !== "NotFoundError") throw error;
      }
      await this.#fs.rm(`${this.#dir}/${rel}`, { recursive: true, force: true });
      return this.#scheduleFlush();
    });
    await batch.promise;
  }

  async put(param: EntryRef | ChildRef, data: Blob): Promise<IRemoteFile> {
    // enter the lock before any await so flush() queues behind this write's
    // staging and cannot conclude there is nothing to drain
    const [batch, stagedPath, oid, size] = await this.#withLock(async () => {
      const bytes = new Uint8Array(await data.arrayBuffer());
      const { oid } = await git.hashBlob({ object: bytes });
      await this.#ensureRepo();
      const path = await this.#refPath(param);
      if (!path) throw new Error("Invalid path");
      const rel = this.#repoPath(path, false);
      await this.#fs.mkdir(this.#parentDir(rel), { recursive: true });
      await this.#fs.writeFile(`${this.#dir}/${rel}`, bytes);
      await git.add({
        fs: this.#fs as never,
        dir: this.#dir,
        gitdir: this.#gitdir,
        filepath: rel,
        force: true,
      });
      return [this.#scheduleFlush(), path, oid, bytes.length] as const;
    });
    await batch.promise;
    return {
      id: oid,
      name: "name" in param ? param.name : path_basename(stagedPath),
      size,
      kind: "file",
      modifiedTime: new Date().toISOString(),
    };
  }

  #parentDir(rel: string): string {
    const dir = `${this.#dir}/${rel}`;
    return dir.slice(0, dir.lastIndexOf("/")) || this.#dir;
  }

  #userPath(param?: EntryRef): string {
    const raw = param?.path ?? (param?.id && !OID_RE.test(param.id) ? param.id : "") ?? "";
    return cleanRepoPath(raw.replace(/^\/+/, ""));
  }

  async #refPath(param: EntryRef | ChildRef): Promise<string> {
    if ("name" in param && "parent" in param) {
      const base = await this.#refPath(param.parent);
      return cleanRepoPath(base, param.name);
    }
    const ref = param as EntryRef;
    const path = this.#userPath(ref);
    if (path) return path;
    if (ref.id && OID_RE.test(ref.id)) {
      const found = await this.#findByOid(ref.id);
      if (!found) throw new Error("Item not found");
      return found.path;
    }
    return "";
  }

  #repoPath(path: string, allowRoot: boolean): string {
    const rel = cleanRepoPath(this.#rootPath, path);
    if (!rel) {
      if (allowRoot) return "";
      throw new Error("Invalid path");
    }
    if (this.#rootPath && rel !== this.#rootPath && !rel.startsWith(`${this.#rootPath}/`)) {
      throw new Error("Invalid path");
    }
    return rel;
  }

  async #withLock<T>(fn: () => Promise<T>, heal = true): Promise<T> {
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      if (!heal) return await fn();
      try {
        return await fn();
      } catch (error) {
        if (!isCorruptRepoError(error)) throw error;
        // the fs may have been evicted or corrupted externally; retry from a
        // fresh clone
        this.#ready = false;
        this.#fs.reset();
        return fn();
      }
    } finally {
      release();
    }
  }

  #scheduleFlush(): DeferredBatch {
    if (!this.#batch) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      promise.catch(() => {});
      this.#batch = { promise, resolve, reject };
      this.#timer = setTimeout(() => {
        void this.#withLock(() => this.#drain(), false);
      }, this.#flushDelay);
    }
    return this.#batch;
  }

  /** Commit and push the pending batch; must run under the lock. */
  async #drain(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const batch = this.#batch;
    this.#batch = null;
    if (!batch && !this.#pendingPush) return;
    try {
      await this.#commitAndPush();
      batch?.resolve();
    } catch (error) {
      if (batch) batch.reject(error);
      else throw error;
    }
  }

  async #ensureRepo(): Promise<void> {
    if (this.#ready) return;
    if (await this.#hydrate()) return;
    this.#fs.reset();
    try {
      await git.clone({
        fs: this.#fs as never,
        http: this.#gitHttp as never,
        dir: this.#dir,
        gitdir: this.#gitdir,
        url: this.#repoUrl,
        ref: this.#branch,
        singleBranch: true,
      });
    } catch (error) {
      if (!isMissingRepoError(error)) throw error;
      // empty remote (or missing branch): start ready to make the first push
      await this.#initEmptyRepo();
    }
    this.#ready = true;
  }

  /**
   * Validates a persisted fs so a warm start can skip re-cloning. Anything
   * suspicious returns false, falling back to a clean re-clone.
   */
  async #hydrate(): Promise<boolean> {
    try {
      const head = await git.resolveRef({
        fs: this.#fs as never,
        dir: this.#dir,
        gitdir: this.#gitdir,
        ref: this.#headRef,
      });
      const { commit } = await git.readCommit({
        fs: this.#fs as never,
        dir: this.#dir,
        gitdir: this.#gitdir,
        oid: head,
      });
      const { tree } = await git.readTree({
        fs: this.#fs as never,
        dir: this.#dir,
        gitdir: this.#gitdir,
        oid: commit.tree,
      });
      if (tree.length > 0) {
        // A persisted `.git` without the matching index/worktree state would
        // make later commits silently drop existing files.
        const files = await git.listFiles({
          fs: this.#fs as never,
          dir: this.#dir,
          gitdir: this.#gitdir,
        });
        if (!files.length) return false;
      }
      this.#ready = true;
      return true;
    } catch {
      return false;
    }
  }

  async #initEmptyRepo(): Promise<void> {
    this.#fs.reset();
    await git.init({
      fs: this.#fs as never,
      dir: this.#dir,
      gitdir: this.#gitdir,
      defaultBranch: this.#branch,
    });
    await git.addRemote({
      fs: this.#fs as never,
      dir: this.#dir,
      gitdir: this.#gitdir,
      remote: "origin",
      url: this.#repoUrl,
      force: true,
    });
  }

  async #refreshRemote(): Promise<void> {
    if (this.#batch || this.#pendingPush) return;
    try {
      const result = await git.fetch({
        fs: this.#fs as never,
        http: this.#gitHttp as never,
        dir: this.#dir,
        gitdir: this.#gitdir,
        url: this.#repoUrl,
        ref: this.#headRef,
        remote: "origin",
        remoteRef: this.#headRef,
        singleBranch: true,
      });
      const fetchHead = (result as { fetchHead?: string | null })?.fetchHead;
      if (fetchHead) {
        await git.writeRef({
          fs: this.#fs as never,
          dir: this.#dir,
          gitdir: this.#gitdir,
          ref: this.#headRef,
          value: fetchHead,
          force: true,
        });
      }
    } catch (error) {
      if (!isMissingRepoError(error)) throw error;
    }
  }

  async #commitAndPush(): Promise<void> {
    const name = this.authConfig.user || "usync";
    const email = this.#email || `${name}@usync.invalid`;
    try {
      await git.commit({
        fs: this.#fs as never,
        dir: this.#dir,
        gitdir: this.#gitdir,
        ref: this.#headRef,
        message: "Update via usync",
        author: { name, email },
        disallowEmpty: true,
      });
    } catch (error) {
      if (isCorruptRepoError(error)) {
        this.#fs.reset();
        this.#ready = false;
      }
      if ((error as { name?: string })?.name !== "EmptyCommitError") throw error;
      if (!this.#pendingPush) return;
    }
    this.#pendingPush = true;
    try {
      await git.push({
        fs: this.#fs as never,
        http: this.#gitHttp as never,
        dir: this.#dir,
        gitdir: this.#gitdir,
        url: this.#repoUrl,
        ref: this.#headRef,
        remote: "origin",
        remoteRef: this.#headRef,
      });
      this.#pendingPush = false;
    } catch (error) {
      if (isPushConflictError(error)) {
        // the remote moved: realign to it (keeping the object store) and let
        // the consumer decide what wins
        this.#pendingPush = false;
        try {
          await this.#recoverToRemote();
        } catch {
          this.#fs.reset();
          this.#ready = false;
        }
      }
      throw error;
    }
  }

  async #recoverToRemote(): Promise<void> {
    await this.#refreshRemote();
    const head = await this.#resolveHead();
    if (!head) {
      this.#fs.reset();
      this.#ready = false;
      return;
    }
    // Hard-reset index and worktree to the remote head, otherwise the losing
    // batch's staged state leaks into the next commit.
    await git.checkout({
      fs: this.#fs as never,
      dir: this.#dir,
      gitdir: this.#gitdir,
      ref: this.#headRef,
      force: true,
    });
  }

  async #resolveHead(): Promise<string | null> {
    try {
      const result = await git.resolveRef({
        fs: this.#fs as never,
        gitdir: this.#gitdir,
        ref: this.#headRef,
      });
      return typeof result === "string" ? result : ((result as { oid?: string })?.oid ?? null);
    } catch (error) {
      if ((error as { name?: string })?.name === "NotFoundError") return null;
      throw error;
    }
  }

  async #headTree(): Promise<{ tree: string; timestamp: number } | null> {
    const head = await this.#resolveHead();
    if (!head) return null;
    const { commit } = await git.readCommit({
      fs: this.#fs as never,
      dir: this.#dir,
      gitdir: this.#gitdir,
      oid: head,
    });
    return { tree: commit.tree, timestamp: commit.author.timestamp };
  }

  async #readTree(oid: string): Promise<GitTreeEntry[]> {
    const { tree } = await git.readTree({
      fs: this.#fs as never,
      dir: this.#dir,
      gitdir: this.#gitdir,
      oid,
    });
    return tree as unknown as GitTreeEntry[];
  }

  async #walkTree(treeOid: string, segments: string[]): Promise<GitTreeEntry | null> {
    let currentOid = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = await this.#readTree(currentOid);
      const found = entries.find((entry) => entry.path === segments[i]);
      if (!found) return null;
      if (i < segments.length - 1 && found.type !== "tree") return null;
      currentOid = found.oid;
    }
    return { mode: 0, path: segments[segments.length - 1] ?? "", oid: currentOid, type: "tree" };
  }

  async #resolveByPath(path: string): Promise<ResolvedEntry | null> {
    const head = await this.#headTree();
    if (!head) return null;
    const rel = this.#repoPath(path, true);
    const segments = rel ? rel.split("/") : [];
    if (!segments.length) {
      return { path: "", oid: head.tree, kind: "folder" };
    }
    let currentOid = head.tree;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = await this.#readTree(currentOid);
      const found = entries.find((entry) => entry.path === segments[i]);
      if (!found) return null;
      if (i < segments.length - 1 && found.type !== "tree") return null;
      currentOid = found.oid;
      if (i === segments.length - 1) {
        return {
          path,
          oid: found.oid,
          kind: found.type === "tree" ? "folder" : "file",
        };
      }
    }
    return null;
  }

  async #findByOid(oid: string): Promise<ResolvedEntry | null> {
    const head = await this.#headTree();
    if (!head) return null;
    const rel = this.#repoPath("", true);
    const rootSegments = rel ? rel.split("/") : [];
    const root = rootSegments.length ? await this.#walkTree(head.tree, rootSegments) : null;
    const rootOid = rootSegments.length ? root?.oid : head.tree;
    if (!rootOid) return null;
    const search = async (treeOid: string, prefix: string): Promise<ResolvedEntry | null> => {
      const entries = await this.#readTree(treeOid);
      for (const entry of entries) {
        const path = cleanRepoPath(prefix, entry.path);
        if (entry.oid === oid) {
          return { path, oid: entry.oid, kind: entry.type === "tree" ? "folder" : "file" };
        }
        if (entry.type === "tree") {
          const found = await search(entry.oid, path);
          if (found) return found;
        }
      }
      return null;
    };
    return search(rootOid, "");
  }

  async #resolveEntry(param: EntryRef): Promise<ResolvedEntry | null> {
    const path = this.#userPath(param);
    if (path) return await this.#resolveByPath(path);
    if (param.id && OID_RE.test(param.id)) return await this.#findByOid(param.id);
    return null;
  }

  async #entryToItem(entry: ResolvedEntry): Promise<IRemoteFile> {
    const head = await this.#headTree();
    let size = 0;
    if (entry.kind === "file") {
      const { blob } = await git.readBlob({
        fs: this.#fs as never,
        dir: this.#dir,
        gitdir: this.#gitdir,
        oid: entry.oid,
      });
      size = blob.length;
    }
    return {
      id: entry.oid,
      name: path_basename(entry.path),
      size,
      kind: entry.kind,
      modifiedTime: head ? new Date(head.timestamp * 1000).toISOString() : "",
    };
  }

  async #listPath(path: string): Promise<IRemoteFile[]> {
    const head = await this.#headTree();
    if (!head) return [];
    const rel = this.#repoPath(path, true);
    const segments = rel ? rel.split("/") : [];
    let dirOid = head.tree;
    if (segments.length) {
      const dir = await this.#walkTree(head.tree, segments);
      if (!dir) return [];
      dirOid = dir.oid;
    }
    const modifiedTime = new Date(head.timestamp * 1000).toISOString();
    const entries = await this.#readTree(dirOid);
    const items: IRemoteFile[] = [];
    for (const entry of entries) {
      if (entry.type === "commit") continue; // gitlink / submodule
      const kind = entry.type === "tree" ? "folder" : "file";
      let size = 0;
      if (kind === "file") {
        const { blob } = await git.readBlob({
          fs: this.#fs as never,
          dir: this.#dir,
          gitdir: this.#gitdir,
          oid: entry.oid,
        });
        size = blob.length;
      }
      items.push({
        id: entry.oid,
        name: entry.path,
        size,
        kind,
        modifiedTime,
      });
    }
    return items;
  }

  async #gitRequest(request: GitHttpRequest): Promise<GitHttpResponse> {
    const body = request.body ? await collectBytes(request.body) : undefined;
    try {
      const { response, blob } = await this.request<{ response: Response; blob: Blob }>(
        request.url,
        {
          method: request.method,
          headers: request.headers,
          body: body ? new Blob([new Uint8Array(body)]) : undefined,
          responseType: "blob",
          signal: request.signal,
        } as ITypedRequestOptions,
      );
      return await toGitHttpResponse(request.url, response, blob);
    } catch (error) {
      const e = error as SimpleRequestError & { cause?: { response?: Response; blob?: Blob } };
      const response = e.response ?? e.cause?.response;
      if (response) {
        const blob = e.cause?.blob ?? (await response.blob().catch(() => undefined));
        return await toGitHttpResponse(request.url, response, blob);
      }
      throw error;
    }
  }
}

async function toGitHttpResponse(
  url: string,
  response: Response,
  blob: Blob | undefined,
): Promise<GitHttpResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  });
  const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
  return {
    url: response.url || url,
    statusCode: response.status,
    statusMessage: response.statusText,
    headers,
    body: [bytes],
  };
}

function path_basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
