import { OAUTH2_AUTH_ERROR, OAuth2Error } from "../common.ts";
import { getCodeChallenge, getCodeVerifier, getState } from "../util.ts";
import { OAuth2Authorizer } from "./base.ts";

const DROPBOX_URL_AUTHORIZE = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_URL_TOKEN = "https://api.dropbox.com/oauth2/token";

export class DropboxAuthorizer extends OAuth2Authorizer {
  private session: { state: string; codeVerifier: string } | undefined;

  /**
   * Ref: https://www.dropbox.com/developers/documentation/http/documentation
   */
  static Scopes = {
    account: "account_info.read",
  };

  async buildAuthUrl() {
    this.session = {
      state: getState(),
      codeVerifier: getCodeVerifier(),
    };
    const { codeChallenge, codeChallengeMethod } = await getCodeChallenge(
      this.session.codeVerifier,
    );
    const url = new URL(DROPBOX_URL_AUTHORIZE);
    Object.entries({
      client_id: this.options.clientId,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      redirect_uri: this.options.redirectUrl,
      response_type: "code",
      token_access_type: "offline",
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
    const res = await fetch(DROPBOX_URL_TOKEN, {
      method: "POST",
      body: payload,
    });
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type: "bearer";
      scope: string;
      refresh_token: string;
      account_id: string;
      uid: string;
    };
    if (!res.ok) throw { status: res.status, data };
    if (!data.refresh_token)
      throw new OAuth2Error(OAUTH2_AUTH_ERROR, "Failed to get refresh_token");
    this._updateRefreshToken({
      token: data.refresh_token,
      scope: data.scope,
    });
    this._updateAccessToken({
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
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
    }).forEach(([key, value]) => {
      if (value != null) payload.append(key, value);
    });
    const res = await fetch(DROPBOX_URL_TOKEN, {
      method: "POST",
      body: payload,
    });
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type: "bearer";
    };
    if (!res.ok) throw { status: res.status, data };
    this._updateAccessToken({
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
    return data.access_token;
  }
}
