import { b64encode, simpleRequest } from "../request";
import type { IAuthConfig, IFilePath, IRemoteFile } from "../types";
import { XMLParser } from "../xmlparser";
import {
  AuthenticatedDriveBase,
  type DriveContext,
  type IRequestFunction,
  type ITypedRequestOptions,
  withDelay,
} from "./base";

export interface IWebDavAuthInfo {
  anonymous?: boolean;
  user?: string;
  password?: string;
  serverOptions: {
    baseUrl: string;
    id?: string;
    name?: string;
    avatar?: string;
  };
}

export class WebDav extends AuthenticatedDriveBase {
  constructor(authConfig: IAuthConfig, context: DriveContext) {
    super(authConfig, context);
    let baseUrl = authConfig.serverOptions?.baseUrl as string;
    if (!baseUrl) throw new Error("baseUrl is required");
    if (!baseUrl.endsWith("/")) baseUrl += "/";
    this.baseUrl = baseUrl;
  }

  initRequest() {
    let request: IRequestFunction = <T>(url: string, options: ITypedRequestOptions) => {
      const { responseType, headers: inputHeaders, ...rest } = options;
      const headers = new Headers(inputHeaders);
      const { serverOptions = {}, user, password } = this.authConfig;
      if (serverOptions && !serverOptions.anonymous) {
        const auth = b64encode(new TextEncoder().encode(`${user}:${password}`));
        headers.set("authorization", `Basic ${auth}`);
      }
      if (url.startsWith("/")) url = `.${url}`;
      return simpleRequest(new URL(url, this.baseUrl), {
        // Bypass login CSRF protection in NextCloud by not sending cookies
        credentials: "omit",
        ...rest,
        headers,
      })[responseType]() as Promise<T>;
    };
    request = withDelay(request);
    return request;
  }

  async getAccount() {
    const { serverOptions = {} } = this.authConfig;
    this.account = {
      id: `${serverOptions.id || "webdav"}`,
      name: `${serverOptions.name || "WebDav"}`,
      avatar: `${serverOptions.avatar || ""}`,
    };
    return this.account;
  }

  private getWebDavPath(param: IFilePath | undefined, allowEmpty: boolean) {
    let path = param?.path || param?.id || "";
    if (path[0] === "/") path = path.slice(1);
    if (!path && !allowEmpty) throw new Error("Invalid path");
    return path;
  }

  private getFullUrl(url: string) {
    return new URL(url, this.baseUrl).href;
  }

  async mkdir(param: { parent?: IFilePath; name: string }) {
    const path = [this.getWebDavPath(param.parent, true), param.name].filter(Boolean).join("/");
    await this.request(path, {
      method: "MKCOL",
      responseType: "blob",
    });
    const item: IRemoteFile = {
      id: this.getFullUrl(path),
      name: param.name,
      size: 0,
      kind: "folder",
      modifiedTime: new Date().toISOString(),
    };
    return item;
  }

  private async propFind(path: string) {
    const parser = this.context?.xmlParser || new XMLParser();
    const xml = await this.request<string>(path, {
      method: "PROPFIND",
      headers: {
        depth: "1",
      },
      responseType: "text",
    });
    const doc = await parser.parse(xml);
    let response = doc["multistatus"]["response"] as any[];
    if (!Array.isArray(response)) response = response ? [response] : [];
    return response.map((item: any): IRemoteFile => {
      const prop = item["propstat"]["prop"];
      const isDir = prop["resourcetype"]?.["collection"];
      return {
        id: this.getFullUrl(item["href"]),
        name: prop["displayname"],
        kind: isDir ? "folder" : "file",
        size: isDir ? 0 : prop["getcontentlength"],
        modifiedTime: new Date(prop["getlastmodified"]).toISOString(),
      };
    });
  }

  async find(param: IFilePath) {
    const path = this.getWebDavPath(param, false);
    const fullUrl = this.getFullUrl(path);
    const items = await this.propFind(path);
    const item = items.find((item) => item.id === fullUrl);
    if (!item) throw new Error("Item not found");
    return item;
  }

  async *list(parent?: IFilePath) {
    const path = this.getWebDavPath(parent, true);
    const fullUrl = this.getFullUrl(path);
    let items = await this.propFind(path);
    items = items.filter((item) => item.id !== fullUrl);
    yield items;
  }

  async get(param: IFilePath) {
    const path = this.getWebDavPath(param, false);
    return this.request<Blob>(path, { responseType: "blob" });
  }

  async remove(param: IFilePath) {
    const path = this.getWebDavPath(param, false);
    await this.request(path, {
      method: "DELETE",
      responseType: "blob",
    });
  }

  async put(
    param: IFilePath & {
      parent?: IFilePath;
      name?: string;
    },
    data: Blob,
  ) {
    const path =
      this.getWebDavPath(param, true) ||
      [this.getWebDavPath(param.parent, true), param.name || ""].filter(Boolean).join("/");
    if (!path) throw new Error("Invalid path");
    await this.request(path, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: data,
      responseType: "blob",
    });
    const item: IRemoteFile = {
      id: this.getFullUrl(path),
      name: path.slice(path.lastIndexOf("/") + 1),
      size: data.size,
      kind: "file",
      modifiedTime: new Date().toISOString(),
    };
    return item;
  }
}
