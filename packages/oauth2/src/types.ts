import { OAuth2Authorizers } from "./providers";

export interface TokenData {
  token: string;
  expiresAt?: number;
  scope?: string;
}

export interface IOAuth2Options {
  clientId: string;
  /** clientSecret may be absent for client-side apps. */
  clientSecret?: string;
  redirectUrl: string;
  scope?: string;

  provider?: {
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

  onSetAccessToken?: (value: TokenData | null) => void;
  onSetRefreshToken?: (value: TokenData | null) => void;
}

export interface IOAuth2Account {
  provider: keyof typeof OAuth2Authorizers;
  user: string;
}
