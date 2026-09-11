export interface IXMLParser {
  parse(xml: string): any | Promise<any>;
}

export interface IAuthConfig {
  authProvider: "google" | "dropbox" | "microsoft" | "password";
  user: string;
  password?: string;
  serverOptions?: Record<string, unknown>;
}

export interface IDriveConfig {
  driveProvider: "googledrive" | "dropbox" | "onedrive" | "s3" | "webdav" | (string & {});
  auth: IAuthConfig;
}

export interface IRemoteFile {
  id: string;
  name: string;
  size: number;
  kind: "file" | "folder";
  modifiedTime: string;
}

export interface IUserInfo {
  id: string;
  name: string;
  avatar?: string;
}

/**
 * A path object that resolves to an existing file or directory.
 */
export interface EntryRef {
  parent?: undefined;
  id?: string;
  path?: string;
}

/**
 * A path object that resolves to a file or directory from its parent.
 */
export interface ChildRef {
  parent: EntryRef;
  name: string;
}
