import {
  OAUTH2_NEED_REFRESH,
  OAUTH2_UNAUTHORIZED,
  OAuth2Authorizers,
  OAuth2Error,
  type OAuth2Config,
  type TokenData,
} from "@usync/oauth2";
import { AuthenticatedDriveBase, type DriveContext } from "./providers/base";
import { Dropbox } from "./providers/dropbox";
import { GoogleDrive } from "./providers/googledrive";
import { OneDrive } from "./providers/onedrive";
import { S3 } from "./providers/s3";
import { WebDav } from "./providers/webdav";
import type { IAuthConfig, IDriveConfig } from "./types";

export * from "./providers";
export * from "./util/request";
export * from "./types";

export interface IOAuth2TokenState {
  accessToken?: TokenData;
  refreshToken?: TokenData;
}

export interface DriveProviderConstructor {
  new (authConfig: IAuthConfig, context: DriveContext): AuthenticatedDriveBase;
}

/**
 * Providers bundled with the main entry point. Providers with heavier
 * dependencies (e.g. `git` from `@usync/drive/git`) are NOT part of this map
 * and must be registered via `options.providers`.
 */
const builtinProviders: Record<string, DriveProviderConstructor> = {
  googledrive: GoogleDrive,
  dropbox: Dropbox,
  onedrive: OneDrive,
  s3: S3,
  webdav: WebDav,
};

function isAuthError(error: unknown) {
  if (error instanceof OAuth2Error) {
    return error.code === OAUTH2_UNAUTHORIZED || error.code === OAUTH2_NEED_REFRESH;
  }
  if (typeof error === "object" && error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    return status === 401 || status === 403;
  }
  return false;
}

function validateOAuth2Config(raw: unknown, provider: string): OAuth2Config {
  const config = raw as OAuth2Config | undefined;
  if (!config || !config.clientId || !config.redirectUrl)
    throw new Error(`Invalid OAuth2 config for provider: ${provider}`);
  return config as OAuth2Config;
}

export async function connectDrive(
  driveConfig: IDriveConfig,
  options?: {
    /**
     * Provider constructors keyed by `IDriveConfig["driveProvider"]`, e.g.
     * `{ git: Git }` imported from `@usync/drive/git`. Registered providers
     * take precedence over the bundled ones.
     */
    providers?: Record<string, DriveProviderConstructor>;
    initialData?: IOAuth2TokenState;
    initialContext?: DriveContext;
    onUpdateToken?: (data: IOAuth2TokenState) => void;
    onAuthorize?: (url: string) => Promise<string>;
  },
): Promise<AuthenticatedDriveBase> {
  const context: DriveContext = { ...options?.initialContext };
  if (driveConfig.auth.authProvider !== "password") {
    const provider = driveConfig.auth.authProvider;
    const providerConfig = validateOAuth2Config(driveConfig.auth.serverOptions, provider);
    const Authorizer = OAuth2Authorizers[provider];
    const oauthAuthorizer = new Authorizer(
      {
        ...providerConfig,
        onSetAccessToken: (value) => {
          options?.onUpdateToken?.({
            accessToken: value ?? undefined,
          });
        },
        onSetRefreshToken: (value) => {
          options?.onUpdateToken?.({
            refreshToken: value ?? undefined,
          });
        },
      },
      options?.initialData,
    );
    context.authorizer = oauthAuthorizer;
  }
  const Drive =
    options?.providers?.[driveConfig.driveProvider] ?? builtinProviders[driveConfig.driveProvider];
  if (!Drive) throw new Error(`Unknown drive provider: ${driveConfig.driveProvider}`);
  const drive = new Drive(driveConfig.auth, context);
  if (driveConfig.auth.authProvider !== "password") {
    try {
      await drive.getAccount();
    } catch (error) {
      if (!isAuthError(error)) throw error;
      drive.account = undefined;
    }
  }
  return drive;
}
