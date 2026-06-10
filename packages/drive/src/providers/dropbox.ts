import type { IFilePath, IRemoteFile } from "../types";
import { AuthenticatedDriveBase } from "./base";

interface IDropboxEntry {
  ".tag": "file" | "folder";
  id: string;
  name: string;
  path_lower: string;
  path_display: string;
  is_downloadable?: boolean;
  client_modified?: string;
  server_modified?: string;
  size?: number;
}

const escRE = /[\u007f-\uffff]/g;
const escFunc = (m: string) => `\\u${(m.charCodeAt(0) + 0x10000).toString(16).slice(1)}`;

function jsonStringifySafe(obj: unknown) {
  const string = JSON.stringify(obj);
  return string.replace(escRE, escFunc);
}

export class Dropbox extends AuthenticatedDriveBase {
  private normalizeEntry(item: IDropboxEntry): IRemoteFile {
    return {
      kind: item[".tag"] === "file" ? "file" : "folder",
      id: item.id,
      name: item.name,
      size: item.size || 0,
      modifiedTime: item.server_modified || "",
    };
  }

  private getDropboxPath(param: IFilePath | undefined, allowEmpty: boolean) {
    if (param?.id) return `id:${param.id}`;
    let path = param?.path || "";
    // Path must start with `/`
    if (path[0] !== "/") path = `/${path}`;
    if (path === "/" && !allowEmpty) throw new Error("Invalid path");
    return path;
  }

  async getAccount() {
    const data = await this.request<{
      account_id: string;
      name: {
        given_name: string;
        surname: string;
        familiar_name: string;
        display_name: string;
        abbreviated_name: string;
      };
      email: string;
      profile_photo_url: string;
    }>("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      responseType: "json",
    });
    this.account = {
      id: data.account_id,
      name: data.name.display_name,
      avatar: data.profile_photo_url,
    };
    return this.account;
  }

  async mkdir(param: { parent?: IFilePath; name: string }) {
    const path = [this.getDropboxPath(param.parent, true), param.name].filter(Boolean).join("/");
    const data = await this.request<{
      metadata: Omit<IDropboxEntry, ".tag">;
    }>("https://api.dropboxapi.com/2/files/create_folder_v2", {
      method: "POST",
      json: {
        path,
      },
      responseType: "json",
    });
    return this.normalizeEntry({
      ...data.metadata,
      ".tag": "folder",
    });
  }

  async find(param: IFilePath) {
    const path = this.getDropboxPath(param, false);
    const data = await this.request<IDropboxEntry>(
      "https://api.dropboxapi.com/2/files/get_metadata",
      {
        method: "POST",
        json: {
          path,
        },
        responseType: "json",
      },
    );
    return this.normalizeEntry(data);
  }

  async *list(parent?: IFilePath) {
    const path = parent ? this.getDropboxPath(parent, true) : "/";
    let data = await this.request<{
      cursor: string;
      has_more: boolean;
      entries: IDropboxEntry[];
    }>("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      json: {
        path,
      },
      responseType: "json",
    });
    yield data.entries.map((item) => this.normalizeEntry(item));
    while (data.has_more) {
      data = await this.request("https://api.dropboxapi.com/2/files/list_folder/continue", {
        method: "POST",
        json: {
          cursor: data.cursor,
        },
        responseType: "json",
      });
      yield data.entries.map((item) => this.normalizeEntry(item));
    }
  }

  async get(param: IFilePath) {
    const path = this.getDropboxPath(param, false);
    return this.request<Blob>("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        "Dropbox-API-Arg": jsonStringifySafe({
          path,
        }),
      },
      responseType: "blob",
    });
  }

  async remove(param: IFilePath) {
    const path = this.getDropboxPath(param, false);
    await this.request("https://api.dropboxapi.com/2/files/delete", {
      method: "POST",
      json: {
        path,
      },
      responseType: "json",
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
      param.name && !param.id
        ? [this.getDropboxPath(param.parent, true), param.name].filter(Boolean).join("/")
        : this.getDropboxPath(param, true);
    if (!path) throw new Error("Invalid path");
    const metadata = await this.request<Omit<IDropboxEntry, ".tag">>(
      "https://content.dropboxapi.com/2/files/upload",
      {
        method: "POST",
        headers: {
          "Dropbox-API-Arg": jsonStringifySafe({
            path,
            mode: "overwrite",
          }),
          "Content-Type": "application/octet-stream",
        },
        body: data,
        responseType: "json",
      },
    );
    return this.normalizeEntry({
      ...metadata,
      ".tag": "file",
    });
  }
}
