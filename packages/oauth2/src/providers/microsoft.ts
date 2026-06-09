import { OAUTH2_AUTH_ERROR, OAuth2Error } from "../common.ts";
import { getCodeChallenge, getCodeVerifier, getState } from "../util.ts";
import { OAuth2Authorizer } from "./base.ts";

/**
 * Ref: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 */
export class MicrosoftAuthorizer extends OAuth2Authorizer {
  static Scopes = {
    /** Ref: https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth */
    imap: "offline_access https://outlook.office.com/IMAP.AccessAsUser.All",
    onedrive: "openid profile Files.ReadWrite.AppFolder offline_access",
  };

  private oauth2Url(path: string) {
    const tenant = this.options.provider?.microsoft?.accountType ?? "common";
    const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/${path}`;
    return url;
  }

  async buildAuthUrl() {
    this.session = {
      state: getState(),
      codeVerifier: getCodeVerifier(),
    };
    const { codeChallenge, codeChallengeMethod } = await getCodeChallenge(
      this.session.codeVerifier,
    );
    const url = new URL(this.oauth2Url("authorize"));
    Object.entries({
      client_id: this.options.clientId,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      redirect_uri: this.options.redirectUrl,
      response_mode: "query",
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
      scope: this.options.scope,
    }).forEach(([key, value]) => {
      if (value != null) payload.append(key, value);
    });
    const res = await fetch(this.oauth2Url("token"), {
      method: "POST",
      body: payload,
    });
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type: "Bearer";
      scope: string;
      refresh_token: string;
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
      scope: this.options.scope,
    }).forEach(([key, value]) => {
      if (value != null) payload.append(key, value);
    });
    const res = await fetch(this.oauth2Url("token"), {
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
