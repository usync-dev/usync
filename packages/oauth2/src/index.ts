import { OAUTH2_NEED_REFRESH, OAUTH2_UNAUTHORIZED, OAuth2Error } from "./common";
import { OAuth2Authorizer, OAuth2Authorizers } from "./providers";
import type { IOAuth2Account, IOAuth2Options } from "./types";

export * from "./common";
export * from "./providers";
export * from "./types";

export function getAuthorizer(options: IOAuth2Options, auth: IOAuth2Account) {
  return new OAuth2Authorizers[auth.provider](options);
}

export async function ensureAccessToken(
  authorizer: OAuth2Authorizer,
  handleOAuth2?: (url: string) => Promise<string>,
) {
  let accessToken: string;
  try {
    accessToken = authorizer.getAccessToken();
  } catch (err) {
    if (!(err instanceof OAuth2Error)) {
      throw err;
    }
    switch (err.code) {
      case OAUTH2_UNAUTHORIZED: {
        if (!handleOAuth2) throw err;
        const url = await authorizer.buildAuthUrl();
        const authorizedUrl = await handleOAuth2(url);
        accessToken = await authorizer.finishAuth(new URL(authorizedUrl));
        break;
      }
      case OAUTH2_NEED_REFRESH: {
        accessToken = await authorizer.refreshToken();
        break;
      }
      default: {
        throw err;
      }
    }
  }
  return accessToken;
}
