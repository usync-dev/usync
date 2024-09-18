export type IRequestOptions = RequestInit & {
  json?: unknown;
};

export class SimpleRequestError extends Error {
  request: { url: string; method: string };
  response?: Response;
  declare cause: unknown;

  constructor(message: string, request: { url: string; method: string }, response?: Response, cause?: unknown) {
    super(message);
    this.request = request;
    this.response = response;
    this.cause = cause;
  }
}

export function simpleRequest(url: URL, options?: IRequestOptions) {
  const { json, ...fetchOptions } = options || {};
  const method = fetchOptions.method || "GET";
  const info = { url: url.toString(), method };
  const headers = new Headers(fetchOptions.headers);

  if (json != null) {
    fetchOptions.body = JSON.stringify(json);
    headers.set("content-type", "application/json");
  }

  async function execute<R>(reader: (response: Response) => Promise<R>): Promise<R> {
    let response: Response | undefined;
    try {
      response = await fetch(url, { ...fetchOptions, headers });
      const result = await reader(response);
      if (!response.ok) throw new SimpleRequestError(response.statusText, info, response, result);
      return result;
    } catch (error) {
      if (error instanceof SimpleRequestError) throw error;
      throw new SimpleRequestError((error as any)?.message || `${error}`, info, response, error);
    }
  }

  return {
    blob: () => execute((r) => r.blob()),
    json: <T = unknown>() => execute((r) => r.json() as Promise<T>),
    text: () => execute((r) => r.text()),
  };
}

export function b64encode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
