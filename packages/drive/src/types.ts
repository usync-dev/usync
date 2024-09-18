export interface IServerConfig {
  redirectUrl: string;
  authProviders: Record<
    string,
    {
      clientId: string;
      clientSecret: string;
      scope?: string;
    }
  >;
}

export interface IAuthConfig {
  authProvider: "google" | "dropbox" | "microsoft" | "password";
  user: string;
  password?: string;
  serverOptions?: Record<string, unknown>;
}

export interface IDriveConfig {
  driveProvider: "googledrive" | "dropbox" | "onedrive" | "s3" | "webdav";
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

export interface IFilePath {
  id?: string;
  path?: string;
}
