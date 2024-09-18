import { Dropbox } from "./dropbox";
import { GoogleDrive } from "./googledrive";
import { OneDrive } from "./onedrive";
import { S3 } from "./s3";
import { WebDav } from "./webdav";

export * from "./base";

export const DriveProviders = {
  dropbox: Dropbox,
  googledrive: GoogleDrive,
  onedrive: OneDrive,
  s3: S3,
  webdav: WebDav,
};
