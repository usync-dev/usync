import { OAUTH2_AUTH_ERROR, OAuth2Error } from "../common.ts";
import { getCodeChallenge, getCodeVerifier, getNonce, getState } from "../util.ts";
import { OAuth2Authorizer } from "./base.ts";

const GOOGLE_URL_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_URL_TOKEN = "https://oauth2.googleapis.com/token";

/**
 * Ref: https://developers.google.com/identity/protocols/oauth2/web-server
 */
export class GoogleAuthorizer extends OAuth2Authorizer {
  /**
   * Ref: https://developers.google.com/identity/protocols/oauth2/scopes
   */
  static Scopes = {
    account: "https://www.googleapis.com/auth/userinfo.profile",
    "drive.appdata": "https://www.googleapis.com/auth/drive.appdata",
    imap: "https://mail.google.com/",
  };

  protected get isOidc(): boolean {
    return this.options.scope?.split(/\s+/).includes("openid") ?? false;
  }

  async buildAuthUrl() {
    this.session = {
      state: getState(),
      codeVerifier: getCodeVerifier(),
      ...(this.isOidc ? { nonce: getNonce() } : {}),
    };
    const { codeChallenge, codeChallengeMethod } = await getCodeChallenge(
      this.session.codeVerifier,
    );
    const url = new URL(GOOGLE_URL_AUTHORIZE);
    Object.entries({
      access_type: this.options.provider?.google?.accessType,
      client_id: this.options.clientId,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      include_granted_scopes: "true",
      nonce: this.session.nonce,
      prompt: this.options.provider?.google?.prompt,
      redirect_uri: this.options.redirectUrl,
      response_type: "code",
      scope: this.options.scope,
      state: this.session.state,
    }).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
    return url.href;
  }

  async finishAuth(url: URL) {
    if (!this.session || this.session.state !== url.searchParams.get("state"))
      throw new OAuth2Error(OAUTH2_AUTH_ERROR, `state doesn't match`);
    const code = url.searchParams.get("code");
    if (!code) throw new OAuth2Error(OAUTH2_AUTH_ERROR, "Invalid code");
    const payload = new URLSearchParams();
    Object.entries({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      code,
      code_verifier: this.session.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: this.options.redirectUrl,
    }).forEach(([key, value]) => {
      if (value != null) payload.append(key, value);
    });
    const res = await fetch(GOOGLE_URL_TOKEN, {
      method: "POST",
      body: payload,
    });
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type: "Bearer";
      scope: string;
      refresh_token: string;
      id_token?: string;
    };
    if (!res.ok) throw { status: res.status, data };
    if (data.refresh_token) {
      this._updateRefreshToken({
        token: data.refresh_token,
        scope: data.scope,
      });
    }
    this._updateAccessToken({
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
    if (this.isOidc) {
      if (!data.id_token)
        throw new OAuth2Error(OAUTH2_AUTH_ERROR, "OIDC enabled but no id_token returned");
      this._idToken = data.id_token;
    }
    return data.access_token;
  }

  async refreshToken() {
    const payload = new URLSearchParams();
    const refreshToken = this.getRefreshToken();
    Object.entries({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: this.options.scope,
    }).forEach(([key, value]) => {
      if (value != null) payload.append(key, value);
    });
    const res = await fetch(GOOGLE_URL_TOKEN, {
      method: "POST",
      body: payload,
    });
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type: "Bearer";
      scope: string;
    };
    if (!res.ok) throw { status: res.status, data };
    this._updateAccessToken({
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
    return data.access_token;
  }
}
