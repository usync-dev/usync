import {
  OAUTH2_NEED_REFRESH,
  OAUTH2_UNAUTHORIZED,
  OAuth2Authorizers,
  OAuth2Error,
  type OAuth2Config,
  type TokenData,
} from "@usync/oauth2";
import { DriveProviders } from "./providers";
import { AuthenticatedDriveBase, type DriveContext } from "./providers/base";
import type { IDriveConfig } from "./types";

export * from "./providers";
export * from "./types";

export interface IOAuth2TokenState {
  accessToken?: TokenData;
  refreshToken?: TokenData;
}

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
  const Drive = DriveProviders[driveConfig.driveProvider];
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
