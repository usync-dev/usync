import type { ChildRef, EntryRef, IRemoteFile } from "../types";
import { AuthenticatedDriveBase } from "./base";

interface IGoogleDriveEntry {
  kind: string;
  mimeType: string;
  size: string;
  id: string;
  name: string;
  createdTime: string;
  modifiedTime: string;
}

export class GoogleDrive extends AuthenticatedDriveBase {
  baseUrl = "https://www.googleapis.com/drive/v3/";

  rootId = "appDataFolder";

  async getAccount() {
    const data = await this.request<{
      id: string;
      name: string;
      picture: string;
    }>("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      responseType: "json",
    });
    this.account = {
      id: data.id,
      name: data.name,
      avatar: data.picture,
    };
    return this.account;
  }

  private normalizeEntry(item: IGoogleDriveEntry): IRemoteFile {
    return {
      kind: item.kind.endsWith("#file") ? "file" : "folder",
      id: item.id,
      name: item.name,
      size: Number(item.size),
      modifiedTime: item.modifiedTime,
    };
  }

  private async stat(id: string) {
    const metadata = await this.request<IGoogleDriveEntry>(
      `files/${id}?fields=id,name,size,kind,mimeType,modifiedTime`,
      { responseType: "json" },
    );
    return this.normalizeEntry(metadata);
  }

  private async resolveId(param: EntryRef) {
    if (param.id) return param.id;
    if (!param.path) return this.rootId;
    const item = await this.find(param);
    return item.id;
  }

  async find(param: EntryRef) {
    if (param.id) return this.stat(param.id);
    let item: IRemoteFile | undefined;
    if (!param.path) throw new Error("Invalid path");
    const parts = param.path.split("/").filter(Boolean);
    for (const part of parts) {
      const parent = item;
      item = undefined;
      for await (const children of this.list(parent && { id: parent.id })) {
        const child = children.find((item) => item.name === part);
        if (child) {
          item = child;
          break;
        }
      }
    }
    if (!item) throw new Error("Item not found");
    return item;
  }

  async mkdir(param: ChildRef) {
    const parentId = param.parent && (await this.resolveId(param.parent));
    const metadata = await this.request<IGoogleDriveEntry>("files", {
      method: "POST",
      json: {
        name: param.name,
        parents: [parentId || this.rootId],
        mimeType: "application/vnd.google-apps.folder",
      },
      responseType: "json",
    });
    return this.normalizeEntry(metadata);
  }

  async *list(parent?: EntryRef) {
    const parentId = parent && (await this.resolveId(parent));
    let pageToken = "";
    while (true) {
      const search = new URLSearchParams({
        spaces: this.rootId,
        fields: "files(id,name,size,kind,mimeType,createdTime,modifiedTime),nextPageToken",
        pageToken,
        ...(parentId && {
          q: `'${parentId}' in parents`,
        }),
      });
      const data = await this.request<{
        nextPageToken?: string;
        files: IGoogleDriveEntry[];
      }>(`files?${search}`, { responseType: "json" });
      yield data.files.map((item) => this.normalizeEntry(item));
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
  }

  async get(param: EntryRef) {
    const id = await this.resolveId(param);
    return await this.request<Blob>(`files/${id}?alt=media`, {
      responseType: "blob",
    });
  }

  async remove(param: EntryRef) {
    const id = await this.resolveId(param);
    // Returns 204
    await this.request(`files/${id}`, {
      method: "DELETE",
      responseType: "blob",
    });
  }

  async put(param: EntryRef | ChildRef, data: Blob) {
    const pathInfo: { name: string; parents?: string[] } = {
      name: "",
    };
    let id = "";
    if (param.parent) {
      pathInfo.parents = [await this.resolveId(param.parent)];
      pathInfo.name = param.name;
    } else {
      id = await this.resolveId(param);
    }
    if (!id && !pathInfo.name) throw new Error("Invalid file name");
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(pathInfo)], { type: "application/json" }));
    form.append("file", data);
    const url = id
      ? `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart&fields=id,name,size,kind,mimeType,modifiedTime`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,kind,mimeType,modifiedTime";
    const metadata = await this.request<IGoogleDriveEntry>(url, {
      body: form,
      method: id ? "PATCH" : "POST",
      responseType: "json",
    });
    return this.normalizeEntry(metadata);
  }
}
