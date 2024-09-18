import type { IFilePath, IRemoteFile, IUserInfo } from "../types";
import { AuthenticatedDriveBase } from "./base";

export interface IOneDriveItem {
  id: string;
  name: string;
  size: number;
  lastModifiedDateTime: string;
  "@microsoft.graph.downloadUrl": string;
}

export class OneDrivePath {
  components: string[] = [];

  append(component: string, isPath: boolean) {
    if (!component.length) throw new Error("Invalid path component");
    // Path component must start with `/`
    if (isPath && component[0] !== "/") component = `/${component}`;
    if (this.components.length % 2 > 0 === !isPath) {
      const last = this.components.pop()!;
      this.components.push(last + component);
    } else {
      this.components.push(component);
    }
  }

  toString() {
    return this.components.join(":");
  }
}

export class OneDrive extends AuthenticatedDriveBase {
  baseUrl = "https://graph.microsoft.com/v1.0/";

  root = "me/drive/special/approot"; // or 'me/drive/root' for a personal drive

  async getAccount(): Promise<IUserInfo> {
    const data = await this.request<{
      givenname: string;
      familyname: string;
      locale: string;
      picture: string;
      sub: string;
    }>("/oidc/userinfo", { responseType: "json" });
    this.account = {
      id: data.sub,
      name: data.givenname + " " + data.familyname,
      avatar: data.picture,
    };
    return this.account;
  }

  private normalizeEntry(item: IOneDriveItem): IRemoteFile {
    return {
      id: item.id,
      name: item.name,
      size: item.size,
      kind: "file",
      modifiedTime: item.lastModifiedDateTime,
    };
  }

  private getOneDrivePath(
    param: (IFilePath & { parent?: IFilePath }) | undefined,
    allowEmpty: boolean,
  ) {
    const odPath = new OneDrivePath();
    if (param?.id) {
      odPath.append(`me/drive/items/${param.id}`, false);
    } else {
      if (param?.parent?.id) {
        odPath.append(`me/drive/items/${param.parent.id}`, false);
      } else {
        odPath.append(this.root, false);
        if (param?.parent?.path) odPath.append(param.parent.path, true);
      }
      let path = param?.path || "";
      if (path[0] === "/") path = path.slice(1);
      if (path) odPath.append(path, true);
      if (!path && !allowEmpty) {
        throw new Error("Invalid path");
      }
    }
    return odPath;
  }

  async mkdir(param: { parent?: IFilePath; name: string }) {
    const odPath = this.getOneDrivePath(param.parent, true);
    odPath.append("/children", false);
    const item = await this.request<IOneDriveItem>(odPath.toString(), {
      method: "POST",
      json: {
        name: param.name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      },
      responseType: "json",
    });
    return this.normalizeEntry(item);
  }

  async find(param: IFilePath) {
    const odPath = this.getOneDrivePath(param, false);
    const data = await this.request<IOneDriveItem>(odPath.toString(), {
      responseType: "json",
    });
    return this.normalizeEntry(data);
  }

  async *list(parent?: IFilePath) {
    const odPath = this.getOneDrivePath(parent, true);
    odPath.append("/children", false);
    let url = odPath.toString();
    while (url) {
      const data = await this.request<{
        value: IOneDriveItem[];
        "@odata.nextLink"?: string;
      }>(url, { responseType: "json" });
      url = data["@odata.nextLink"] || "";
      yield data.value.map((item) => this.normalizeEntry(item));
    }
  }

  async get(param: IFilePath) {
    const odPath = this.getOneDrivePath(param, false);
    odPath.append("/content", false);
    return this.request<Blob>(odPath.toString(), { responseType: "blob" });
  }

  async remove(param: IFilePath) {
    const odPath = this.getOneDrivePath(param, false);
    // Returns 204
    await this.request(odPath.toString(), {
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
    const odPath = this.getOneDrivePath(param, false);
    odPath.append("/content", false);
    const item = await this.request<IOneDriveItem>(odPath.toString(), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: data,
      responseType: "json",
    });
    return this.normalizeEntry(item);
  }
}
