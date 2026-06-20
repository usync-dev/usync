import { OAuth2Authorizers } from "./providers";

export interface TokenData {
  token: string;
  expiresAt?: number;
  scope?: string;
}

export interface IdTokenClaims {
  iss?: string;
  sub?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  name?: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
  email_verified?: boolean;
}

export interface OAuth2Config {
  clientId: string;
  /** clientSecret may be absent for client-side apps. */
  clientSecret?: string;
  redirectUrl: string;
  scope?: string;

  provider?: {
    google?: {
      /**
       * Whether your application can refresh access tokens when the user is not present at the browser.
       * See https://developers.google.com/identity/protocols/oauth2/web-server#offline
       *
       * Default as `online`.
       */
      accessType?: "online" | "offline";
      /**
       * A space-delimited, case-sensitive list of prompts to present the user.
       * See https://developers.google.com/identity/openid-connect/openid-connect#prompt
       */
      prompt?: string;
    };
    microsoft?: {
      /**
       * Must match the account type of the application registered in https://portal.azure.com/.
       * `common` for all accounts, `consumers` for personal accounts only.
       *
       * Default as `common`.
       */
      accountType?: "common" | "consumers";
    };
  };
}

export interface OAuth2AuthorizerOptions extends OAuth2Config {
  onSetAccessToken?: (value: TokenData | null) => void;
  onSetRefreshToken?: (value: TokenData | null) => void;
}

export interface IOAuth2Account {
  provider: keyof typeof OAuth2Authorizers;
  user: string;
}
