import type { ChildRef, EntryRef, IRemoteFile } from "../types";
import { AuthenticatedDriveBase } from "./base";

const FILE_FIELDS = "id,name,size,kind,mimeType,modifiedTime";
const LIST_FIELDS = `files(${FILE_FIELDS}),nextPageToken`;

interface IGoogleDriveEntry {
  kind: string;
  mimeType: string;
  size: string;
  id: string;
  name: string;
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
    const metadata = await this.request<IGoogleDriveEntry>(`files/${id}?fields=${FILE_FIELDS}`, {
      responseType: "json",
    });
    return this.normalizeEntry(metadata);
  }

  private async listFiles(parentId?: string, name?: string, fields?: string, pageToken?: string) {
    const qParts: string[] = [];
    if (parentId) qParts.push(`'${parentId}' in parents`);
    if (name) qParts.push(`name = '${name.replace(/'/g, "\\'")}'`);

    const search = new URLSearchParams({
      spaces: this.rootId,
      fields: fields || "files(id),nextPageToken",
    });
    if (qParts.length) search.set("q", qParts.join(" and "));
    if (pageToken) search.set("pageToken", pageToken);

    return this.request<{ files: IGoogleDriveEntry[]; nextPageToken?: string }>(`files?${search}`, {
      responseType: "json",
    });
  }

  private async resolveId(param: EntryRef) {
    if (param.id) return param.id;
    if (!param.path) return this.rootId;
    const item = await this.find(param);
    return item.id;
  }

  async find(param: EntryRef) {
    if (param.id) return this.stat(param.id);
    if (!param.path) throw new Error("Invalid path");
    const parts = param.path.split("/").filter(Boolean);
    let parentId: string | undefined;
    let item: IGoogleDriveEntry | undefined;
    for (const part of parts) {
      const data = await this.listFiles(parentId, part, `files(${FILE_FIELDS})`);
      item = data.files[0];
      if (!item) throw new Error("Item not found");
      parentId = item.id;
    }
    if (!item) throw new Error("Item not found");
    return this.normalizeEntry(item);
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
      const data = await this.listFiles(parentId, undefined, LIST_FIELDS, pageToken);
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
    let id = "";
    let metadata: Record<string, unknown> = {};
    if (param.parent) {
      const parentId = await this.resolveId(param.parent);
      const existing = await this.listFiles(parentId, param.name, "files(id)");
      if (existing.files.length) {
        id = existing.files[0].id;
      } else {
        metadata = { parents: [parentId], name: param.name };
      }
    } else {
      id = await this.resolveId(param);
    }
    if (!id && !metadata.name) throw new Error("Invalid file name");

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", data);

    const url = id
      ? `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart&fields=${FILE_FIELDS}`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`;
    const result = await this.request<IGoogleDriveEntry>(url, {
      body: form,
      method: id ? "PATCH" : "POST",
      responseType: "json",
    });
    return this.normalizeEntry(result);
  }
}
