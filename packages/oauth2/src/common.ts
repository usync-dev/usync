export const OAUTH2_NEED_REFRESH = 1;
export const OAUTH2_AUTH_ERROR = 2;
export const OAUTH2_UNAUTHORIZED = 3;

export class OAuth2Error extends Error {
  constructor(
    public code: number,
    message?: string,
  ) {
    super(message || `OAuth2Error: code=${code}`);
  }
}
