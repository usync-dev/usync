import { ensureAccessToken, OAuth2Authorizer } from "@usync/oauth2";
import { type IRequestOptions, simpleRequest, SimpleRequestError } from "../request";
import type { IAuthConfig, IFilePath, IRemoteFile, IUserInfo } from "../types";
import { delay } from "../util";
import type { XMLParser } from "../xmlparser";

export type ITypedRequestOptions = IRequestOptions & {
  responseType: "json" | "blob" | "text";
};
export type IRequestFunction = <T>(url: string, options: ITypedRequestOptions) => Promise<T>;

export function withDelay(request: IRequestFunction) {
  let delayTime = 0;
  return async <T>(url: string, options: ITypedRequestOptions) => {
    let time = delayTime;
    let error: any;
    for (let attempts = 5; attempts > 0; attempts -= 1) {
      await delay(time);
      try {
        const res = await request<T>(url, options);
        delayTime >>= 1;
        return res;
      } catch (err) {
        error = err;
        if (err instanceof SimpleRequestError && err.response?.status === 429) {
          const retryAfter = err.response.headers.get("retry-after");
          const serverDelay =
            retryAfter &&
            (isNaN(+retryAfter) ? new Date(retryAfter).getTime() - Date.now() : +retryAfter * 1000);
          if (serverDelay) {
            time = serverDelay;
          } else {
            time = Math.max(1000, time * 2);
            delayTime = time;
          }
        } else {
          break;
        }
      }
    }
    throw error;
  };
}

export function withToken(
  authorizer: OAuth2Authorizer,
  handleOAuth2?: (url: string) => Promise<string>,
) {
  if (!authorizer) throw new Error("Invalid authorizer");
  return (request: IRequestFunction) =>
    async <T>(url: string, options: ITypedRequestOptions) => {
      const { headers: inputHeaders, ...rest } = options;
      const headers = new Headers(inputHeaders);
      const accessToken = await ensureAccessToken(authorizer, handleOAuth2);
      headers.set("authorization", `Bearer ${accessToken}`);
      return await request<T>(url, {
        ...rest,
        headers,
      });
    };
}

export abstract class DriveBase {
  abstract mkdir(param: { parent?: IFilePath; name: string }): Promise<IRemoteFile>;
  abstract find(param: IFilePath): Promise<IRemoteFile>;
  abstract list(parent?: IFilePath): AsyncGenerator<IRemoteFile[]>;
  abstract get(param: IFilePath): Promise<Blob>;
  abstract remove(param: IFilePath): Promise<void>;
  abstract put(
    param: IFilePath & {
      parent?: IFilePath;
      name?: string;
    },
    data: Blob,
  ): Promise<IRemoteFile>;
}

export interface DriveContext {
  authorizer?: OAuth2Authorizer;
  xmlParser?: XMLParser;
}

export abstract class AuthenticatedDriveBase extends DriveBase {
  baseUrl: string | undefined;
  request: IRequestFunction;
  account: IUserInfo | undefined;

  constructor(
    protected authConfig: IAuthConfig,
    protected context?: DriveContext,
  ) {
    super();
    this.request = this.initRequest();
  }

  initRequest() {
    let request: IRequestFunction = async <T>(url: string, options: ITypedRequestOptions) => {
      const { responseType, ...rest } = options;
      return (await simpleRequest(new URL(url, this.baseUrl), rest)[responseType]()) as Promise<T>;
    };
    const authorizer = this.context?.authorizer;
    if (!authorizer) throw new Error("OAuth2 authorizer is not available");
    request = withToken(authorizer)(request);
    request = withDelay(request);
    return request;
  }

  abstract getAccount(): Promise<IUserInfo>;
}
