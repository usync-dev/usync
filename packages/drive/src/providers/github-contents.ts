// GitHub's "contents API" — also implemented by GHES, Gitea, and Forgejo.
// Host independence comes from `apiBase`; see createMethod for the one
// place their behavior actually diverges.
// Reference: https://docs.github.com/en/rest/repos/contents
import type { ChildRef, EntryRef, IAuthConfig, IRemoteFile } from "../types";
import { b64decode, b64encode, simpleRequest, SimpleRequestError } from "../util";
import {
  AuthenticatedDriveBase,
  type DriveContext,
  type IRequestFunction,
  type ITypedRequestOptions,
  withDelay,
} from "./base";

/**
 * Limits inherited from the underlying contents API: `list()` returns at
 * most 1000 entries per directory (not paginated), and `get()` can only
 * read files up to 1 MB.
 */
export interface IGithubContentsServerOptions {
  /** Default: GitHub.com's API. Override for GHES/Gitea/Forgejo. */
  apiBase?: string;
  owner?: string;
  repo?: string;
  /** Default: "main". */
  branch?: string;
  /** Folder inside the repo files are stored under. Default: repo root. */
  pathPrefix?: string;
  /**
   * GitHub accepts PUT for both create and update. Gitea/Forgejo require
   * POST to create a file (PUT there requires an existing `sha`) — set to
   * "post" for those hosts. Default: "put".
   */
  createMethod?: "put" | "post";
  name?: string;
  avatar?: string;
}

export class RepoNotFoundError extends Error {
  constructor(owner: string, repo: string) {
    super(
      `Repository "${owner}/${repo}" was not found, or the token does not have access to it. ` +
        `Create the repository first, then make sure the token can read and write its contents.`,
    );
    this.name = "RepoNotFoundError";
  }
}

interface IContentsItem {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "symlink" | "submodule";
  content?: string;
  encoding?: string;
}

const DEFAULT_API_BASE = "https://api.github.com";

function isNotFound(err: unknown): err is SimpleRequestError {
  return err instanceof SimpleRequestError && err.response?.status === 404;
}

function isShaConflict(err: unknown): err is SimpleRequestError {
  return err instanceof SimpleRequestError && err.response?.status === 409;
}

export class GithubContents extends AuthenticatedDriveBase {
  constructor(authConfig: IAuthConfig, context?: DriveContext) {
    super(authConfig, context);
    const { owner, repo } = this.getOptions();
    if (!owner || !repo) throw new Error("owner and repo are required");
  }

  private getOptions() {
    const serverOptions = (this.authConfig.serverOptions || {}) as IGithubContentsServerOptions;
    const apiBase = (serverOptions.apiBase?.trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
    const owner = serverOptions.owner?.trim() || "";
    const repo = serverOptions.repo?.trim() || "";
    const branch = serverOptions.branch?.trim() || "main";
    const pathPrefix = (serverOptions.pathPrefix || "").replace(/^\/+|\/+$/g, "");
    const createMethod = serverOptions.createMethod === "post" ? "post" : "put";
    const token = this.authConfig.password?.trim() || "";
    const name = serverOptions.name?.trim() || (owner && repo ? `${owner}/${repo}` : "GitHub");
    const avatar = serverOptions.avatar?.trim() || "";
    return { apiBase, owner, repo, branch, pathPrefix, createMethod, token, name, avatar };
  }

  initRequest() {
    const request: IRequestFunction = <T>(url: string, options: ITypedRequestOptions) => {
      const { responseType, headers: inputHeaders, ...rest } = options;
      const { apiBase, token } = this.getOptions();
      const headers = new Headers(inputHeaders);
      headers.set("accept", "application/json");
      if (token) headers.set("authorization", `token ${token}`);
      return simpleRequest(
        new URL(url, `${apiBase}/`),
        // put()/remove() re-read `sha` right before writing to avoid a
        // stale-sha conflict; a cached GET would defeat that.
        { cache: "no-store", ...rest, headers },
        this.context?.fetch,
      )[responseType]() as Promise<T>;
    };
    return withDelay(request);
  }

  async getAccount() {
    const { owner, repo, name, avatar } = this.getOptions();
    this.account = { id: `${owner}/${repo}`, name, avatar: avatar || undefined };
    return this.account;
  }

  async mkdir(_param: ChildRef): Promise<IRemoteFile> {
    // Git hosts have no real empty folders; nothing to create.
    throw new Error("Not supported");
  }

  private joinPath(...parts: (string | undefined)[]) {
    return parts
      .map((part) => (part || "").replace(/^\/+|\/+$/g, ""))
      .filter(Boolean)
      .join("/");
  }

  private resolvePath(param: EntryRef | undefined) {
    const { pathPrefix } = this.getOptions();
    return this.joinPath(pathPrefix, param?.id ?? param?.path ?? "");
  }

  private contentsUrl(path: string) {
    const { owner, repo } = this.getOptions();
    const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return `repos/${owner}/${repo}/contents${encoded ? `/${encoded}` : ""}`;
  }

  private refQuery() {
    return `?ref=${encodeURIComponent(this.getOptions().branch)}`;
  }

  private normalizeItem(item: IContentsItem): IRemoteFile {
    return {
      id: item.name,
      name: item.name,
      size: item.size,
      kind: item.type === "dir" ? "folder" : "file",
      modifiedTime: "",
    };
  }

  private async checkRepoExists() {
    const { owner, repo } = this.getOptions();
    try {
      await this.request(`repos/${owner}/${repo}`, { responseType: "json" });
    } catch (err) {
      if (isNotFound(err)) throw new RepoNotFoundError(owner, repo);
      throw err;
    }
  }

  async find(param: EntryRef) {
    const path = this.resolvePath(param);
    try {
      const data = await this.request<IContentsItem | IContentsItem[]>(
        `${this.contentsUrl(path)}${this.refQuery()}`,
        { responseType: "json" },
      );
      if (Array.isArray(data)) throw new Error("Item not found");
      return this.normalizeItem(data);
    } catch (err) {
      if (isNotFound(err)) await this.checkRepoExists();
      throw err;
    }
  }

  async *list(parent?: EntryRef) {
    const path = this.resolvePath(parent);
    let data: IContentsItem | IContentsItem[];
    try {
      data = await this.request<IContentsItem | IContentsItem[]>(
        `${this.contentsUrl(path)}${this.refQuery()}`,
        { responseType: "json" },
      );
    } catch (err) {
      // A 404 here is ambiguous (missing repo vs. an empty path); disambiguate.
      if (isNotFound(err)) {
        await this.checkRepoExists();
        yield [];
        return;
      }
      throw err;
    }
    const items = Array.isArray(data) ? data : [data];
    // GitHub/Gitea cap a directory listing at 1000 entries; not paginated.
    yield items
      .filter((item) => item.type === "file" || item.type === "dir")
      .map((item) => this.normalizeItem(item));
  }

  async get(param: EntryRef) {
    const path = this.resolvePath(param);
    // GitHub/Gitea cap file content returned via this endpoint at 1 MB.
    const data = await this.request<IContentsItem | IContentsItem[]>(
      `${this.contentsUrl(path)}${this.refQuery()}`,
      { responseType: "json" },
    );
    if (Array.isArray(data) || data.type !== "file" || data.content == null) {
      throw new Error("Not a file");
    }
    return new Blob([b64decode(data.content)]);
  }

  async remove(param: EntryRef) {
    const path = this.resolvePath(param);
    const { branch } = this.getOptions();
    for (let attempt = 0; ; attempt++) {
      const existing = await this.request<IContentsItem | IContentsItem[]>(
        `${this.contentsUrl(path)}${this.refQuery()}`,
        { responseType: "json" },
      );
      if (Array.isArray(existing)) throw new Error("Cannot remove a directory");
      try {
        await this.request(this.contentsUrl(path), {
          method: "DELETE",
          responseType: "json",
          json: { message: `Delete ${path}`, sha: existing.sha, branch },
        });
        return;
      } catch (err) {
        if (attempt === 0 && isShaConflict(err)) continue;
        throw err;
      }
    }
  }

  async put(param: EntryRef | ChildRef, data: Blob) {
    const { branch, createMethod } = this.getOptions();
    const path = param.parent
      ? this.joinPath(this.resolvePath(param.parent), param.name)
      : this.resolvePath(param);
    if (!path) throw new Error("Invalid path");
    const content = b64encode(new Uint8Array(await data.arrayBuffer()));
    for (let attempt = 0; ; attempt++) {
      let sha: string | undefined;
      try {
        const existing = await this.request<IContentsItem | IContentsItem[]>(
          `${this.contentsUrl(path)}${this.refQuery()}`,
          { responseType: "json" },
        );
        if (!Array.isArray(existing)) sha = existing.sha;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      // GitHub uses PUT for both create and update; Gitea/Forgejo need
      // createMethod: "post" to create (their PUT requires a sha).
      const method = sha ? "PUT" : createMethod.toUpperCase();
      try {
        const result = await this.request<{ content: IContentsItem }>(this.contentsUrl(path), {
          method,
          responseType: "json",
          json: {
            message: `${sha ? "Update" : "Add"} ${path}`,
            content,
            branch,
            ...(sha ? { sha } : {}),
          },
        });
        return this.normalizeItem(result.content);
      } catch (err) {
        if (attempt === 0 && isShaConflict(err)) continue;
        throw err;
      }
    }
  }
}
