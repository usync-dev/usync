import { OAUTH2_AUTH_ERROR, OAUTH2_NEED_REFRESH, OAUTH2_UNAUTHORIZED, OAuth2Error } from "../common";
import { decodeJwtPayload } from "../util";
import type { IdTokenClaims, OAuth2AuthorizerOptions, TokenData } from "../types";

export abstract class OAuth2Authorizer {
  abstract buildAuthUrl(): Promise<string>;
  abstract finishAuth(url: URL): Promise<string>;
  abstract refreshToken(): Promise<string>;

  protected _accessToken: TokenData | null = null;
  protected _refreshToken: TokenData | null = null;
  protected _idToken: string | null = null;

  public session: { state: string; codeVerifier: string; nonce?: string } | undefined;

  constructor(
    protected options: OAuth2AuthorizerOptions,
    initialData?: {
      accessToken?: TokenData;
      refreshToken?: TokenData;
      session?: { state: string; codeVerifier: string; nonce?: string };
    },
  ) {
    if (initialData) {
      this.setRefreshToken(initialData.refreshToken);
      this.setAccessToken(initialData.accessToken);
      this.session = initialData.session;
    }
  }

  protected _getValidToken(value?: TokenData | null) {
    return value && (!value.expiresAt || Date.now() < value.expiresAt) ? value.token : undefined;
  }

  protected _updateAccessToken(value: TokenData | null) {
    this.setAccessToken(value);
    this.options.onSetAccessToken?.(value);
  }

  protected _updateRefreshToken(value: TokenData | null) {
    this.setRefreshToken(value);
    this.options.onSetRefreshToken?.(value);
  }

  getAccessToken() {
    if (!this._accessToken) throw new OAuth2Error(OAUTH2_UNAUTHORIZED);
    const token = this._getValidToken(this._accessToken);
    if (!token) throw new OAuth2Error(OAUTH2_NEED_REFRESH);
    return token;
  }

  getRefreshToken() {
    const refreshToken = this._getValidToken(this._refreshToken);
    if (!refreshToken) throw new OAuth2Error(OAUTH2_UNAUTHORIZED, "Invalid refresh token");
    return refreshToken;
  }

  setAccessToken(value?: TokenData | null) {
    this._accessToken = value ?? null;
  }

  setRefreshToken(value?: TokenData | null) {
    this._refreshToken = value ?? null;
  }

  getClaims(): IdTokenClaims {
    if (!this._idToken)
      throw new OAuth2Error(OAUTH2_AUTH_ERROR, "OIDC not enabled or claims not available");
    const claims = decodeJwtPayload(this._idToken) as IdTokenClaims;
    if (this.session?.nonce && claims.nonce !== this.session.nonce)
      throw new OAuth2Error(OAUTH2_AUTH_ERROR, "nonce mismatch");
    return claims;
  }
}
