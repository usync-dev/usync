import { DropboxAuthorizer } from "./dropbox";
import { GoogleAuthorizer } from "./google";
import { MicrosoftAuthorizer } from "./microsoft";

export * from "./base";
export { DropboxAuthorizer, GoogleAuthorizer, MicrosoftAuthorizer };

export const OAuth2Authorizers = {
  dropbox: DropboxAuthorizer,
  google: GoogleAuthorizer,
  microsoft: MicrosoftAuthorizer,
};
