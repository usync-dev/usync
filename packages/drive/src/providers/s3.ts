// Adapted from https://github.com/violentmonkey/violentmonkey/pull/2521
// by @Arlind-dev

// References:
// - https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// - https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
import { simpleRequest } from "../request";
import type { IFilePath, IRemoteFile, IUserInfo } from "../types";
import { XMLParser } from "../xmlparser";
import {
  type IRequestFunction,
  type ITypedRequestOptions,
  AuthenticatedDriveBase,
  withDelay,
} from "./base";

interface IS3ServerOptions {
  bucket?: string;
  endpoint?: string;
  prefix?: string;
  region?: string;
  avatar?: string;
  name?: string;
}

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const encoder = new TextEncoder();

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function encodeSegment(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
}

function toHex(data: Uint8Array) {
  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256hex(data: string | Blob | ArrayBuffer | Uint8Array<ArrayBuffer>) {
  let buffer: ArrayBuffer;
  if (typeof data === "string") {
    buffer = encoder.encode(data).buffer;
  } else if (data instanceof Blob) {
    buffer = await data.arrayBuffer();
  } else if (data instanceof Uint8Array) {
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else {
    buffer = data;
  }
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return toHex(new Uint8Array(hash));
}

async function hmacSha256(key: string | Uint8Array<ArrayBuffer>, data: string) {
  const keyData = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}

async function getSigningKey(secretKey: string, datestamp: string, region: string) {
  let key = await hmacSha256(`AWS4${secretKey}`, datestamp);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, "s3");
  return hmacSha256(key, "aws4_request");
}

function normalizeEndpoint(endpoint: string) {
  if (!endpoint.includes("://")) return `https://${endpoint}`;
  return endpoint;
}

function trimPrefix(prefix: string) {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function normalizeKey(key: string) {
  return key.replace(/^\/+/, "").replace(/\/+$/, "");
}

function splitFullKey(fullKey: string) {
  return normalizeKey(fullKey).split("/").filter(Boolean);
}

function getLastName(key: string) {
  const normalized = normalizeKey(key);
  const last = normalized.split("/").pop();
  return last || "";
}

async function parseListResponse(parser: XMLParser, xml: string) {
  const doc = (await parser.parse(xml)) as {
    ListBucketResult?: {
      Contents?:
        | {
            Key?: string;
            LastModified?: string;
            Size?: string | number;
          }
        | Array<{
            Key?: string;
            LastModified?: string;
            Size?: string | number;
          }>;
      CommonPrefixes?:
        | {
            Prefix?: string;
          }
        | Array<{
            Prefix?: string;
          }>;
      NextContinuationToken?: string;
    };
  };
  const result = doc.ListBucketResult || {};
  const contents = toArray(result.Contents).map((item) => ({
    key: item.Key || "",
    lastModified: item.LastModified || "",
    size: Number(item.Size || 0),
  }));
  const commonPrefixes = toArray(result.CommonPrefixes).map((item) => item.Prefix || "");
  return {
    contents,
    commonPrefixes,
    nextContinuationToken: result.NextContinuationToken || "",
  };
}

async function signS3Request({
  method,
  endpoint,
  path,
  query,
  accessKeyId,
  secretAccessKey,
  region,
  body,
}: {
  method: string;
  endpoint: string;
  path: string;
  query: string[][];
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  body?: BodyInit | null;
}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const datestamp = amzDate.slice(0, 8);
  const canonicalUri = `/${splitFullKey(path).map(encodeSegment).join("/")}`;
  const canonicalQuery = [...query]
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? (aValue < bValue ? -1 : aValue > bValue ? 1 : 0) : aKey < bKey ? -1 : 1,
    )
    .map(([key, value]) => `${encodeSegment(key)}=${encodeSegment(value)}`)
    .join("&");
  const url = `${endpoint.replace(/\/$/, "")}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  const payloadHash = body
    ? await sha256hex(body as Blob | string | ArrayBuffer | Uint8Array<ArrayBuffer>)
    : EMPTY_HASH;
  const headers = {
    host: new URL(url).host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name as keyof typeof headers]}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${datestamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256hex(canonicalRequest),
  ].join("\n");
  const signingKey = await getSigningKey(secretAccessKey, datestamp, region);
  const signature = toHex(await hmacSha256(signingKey, stringToSign));
  return {
    url,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export class S3 extends AuthenticatedDriveBase {
  private getOptions(): Required<
    Pick<IS3ServerOptions, "bucket" | "endpoint" | "prefix" | "region">
  > & {
    accessKeyId: string;
    secretAccessKey: string;
    name: string;
    avatar: string;
  } {
    const serverOptions = (this.authConfig.serverOptions || {}) as IS3ServerOptions;
    const bucket = serverOptions.bucket?.trim() || "";
    const endpoint = normalizeEndpoint(serverOptions.endpoint?.trim() || "");
    const prefix = trimPrefix(serverOptions.prefix?.trim() || "");
    const region = serverOptions.region?.trim() || "us-east-1";
    const accessKeyId = this.authConfig.user?.trim() || "";
    const secretAccessKey = this.authConfig.password?.trim() || "";
    const name = serverOptions.name?.trim() || bucket || "S3";
    const avatar = serverOptions.avatar?.trim() || "";
    return {
      bucket,
      endpoint,
      prefix,
      region,
      accessKeyId,
      secretAccessKey,
      name,
      avatar,
    };
  }

  private getRootPrefix() {
    const { prefix } = this.getOptions();
    return prefix ? `${prefix}/` : "";
  }

  private resolveKey(param: IFilePath | undefined) {
    const key = param?.id || param?.path || "";
    return normalizeKey(key);
  }

  private resolveFullKey(param: IFilePath | undefined) {
    return `${this.getRootPrefix()}${this.resolveKey(param)}`.replace(/\/+$/, "");
  }

  private normalizeFile(
    key: string,
    size: number,
    lastModified: string,
    kind: "file" | "folder",
  ): IRemoteFile {
    return {
      id: normalizeKey(key).replace(/\/+$/, ""),
      name: getLastName(key),
      size,
      kind,
      modifiedTime: lastModified,
    };
  }

  initRequest() {
    const request: IRequestFunction = async <T>(url: string, options: ITypedRequestOptions) => {
      const { responseType, headers: inputHeaders, body, ...rest } = options;
      const opts = this.getOptions();
      if (!opts.bucket || !opts.endpoint || !opts.accessKeyId || !opts.secretAccessKey) {
        throw new Error("Invalid S3 configuration");
      }
      const parsed = new URL(url, opts.endpoint);
      const query = Array.from(parsed.searchParams.entries());
      const { url: signedUrl, headers } = await signS3Request({
        method: (rest.method || "GET").toUpperCase(),
        endpoint: opts.endpoint,
        path: parsed.pathname,
        query,
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        region: opts.region,
        body: body as BodyInit | null | undefined,
      });
      const requestHeaders = new Headers(inputHeaders);
      for (const [name, value] of Object.entries(headers)) {
        requestHeaders.set(name, value);
      }
      const response = simpleRequest(new URL(signedUrl), {
        ...rest,
        headers: requestHeaders,
        body,
      });
      return (await response[responseType]()) as Promise<T>;
    };
    return withDelay(request);
  }

  async getAccount(): Promise<IUserInfo> {
    const opts = this.getOptions();
    this.account = {
      id: opts.bucket,
      name: opts.name,
      avatar: opts.avatar || undefined,
    };
    return this.account;
  }

  async mkdir(_param: { parent?: IFilePath; name: string }): Promise<IRemoteFile> {
    throw new Error("Not supported");
  }

  async find(param: IFilePath) {
    const key = this.resolveKey(param);
    if (!key) throw new Error("Invalid path");
    let item: IRemoteFile | undefined;
    const parts = key.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const parent = item?.kind === "folder" ? { id: item.id } : undefined;
      item = undefined;
      for await (const children of this.list(parent)) {
        const child = children.find((child) => child.name === parts[i]);
        if (child) {
          item = child;
          break;
        }
      }
    }
    if (!item) throw new Error("Item not found");
    return item;
  }

  async *list(parent?: IFilePath) {
    const parser = this.context?.xmlParser || new XMLParser();
    const opts = this.getOptions();
    const rootPrefix = this.getRootPrefix();
    const parentKey = parent ? this.resolveKey(parent) : "";
    const prefix = `${rootPrefix}${parentKey ? `${parentKey}/` : ""}`;
    let continuationToken = "";
    do {
      const query = new URLSearchParams({
        "list-type": "2",
        delimiter: "/",
        prefix,
      });
      if (continuationToken) query.set("continuation-token", continuationToken);
      const { url, headers } = await signS3Request({
        method: "GET",
        endpoint: opts.endpoint,
        path: opts.bucket,
        query: Array.from(query.entries()),
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        region: opts.region,
      });
      const xml = await simpleRequest(new URL(url), {
        headers,
      }).text();
      const page = await parseListResponse(parser, xml);
      const items: IRemoteFile[] = [];
      for (const entry of page.contents) {
        const key = normalizeKey(entry.key);
        if (!key.startsWith(prefix)) continue;
        const relativeKey = key.slice(prefix.length);
        if (!relativeKey) continue;
        items.push(this.normalizeFile(relativeKey, entry.size, entry.lastModified, "file"));
      }
      for (const commonPrefix of page.commonPrefixes) {
        const key = normalizeKey(commonPrefix);
        if (!key.startsWith(prefix)) continue;
        const relativeKey = key.slice(prefix.length);
        if (!relativeKey) continue;
        items.push(this.normalizeFile(relativeKey, 0, "", "folder"));
      }
      yield items;
      continuationToken = page.nextContinuationToken;
    } while (continuationToken);
  }

  async get(param: IFilePath) {
    const key = this.resolveFullKey(param);
    const opts = this.getOptions();
    const { url, headers } = await signS3Request({
      method: "GET",
      endpoint: opts.endpoint,
      path: `${opts.bucket}/${key}`,
      query: [],
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
    });
    return simpleRequest(new URL(url), {
      headers,
    }).blob();
  }

  async remove(param: IFilePath) {
    const key = this.resolveFullKey(param);
    const opts = this.getOptions();
    const { url, headers } = await signS3Request({
      method: "DELETE",
      endpoint: opts.endpoint,
      path: `${opts.bucket}/${key}`,
      query: [],
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
    });
    await simpleRequest(new URL(url), {
      method: "DELETE",
      headers,
    }).blob();
  }

  async put(
    param: IFilePath & {
      parent?: IFilePath;
      name?: string;
    },
    data: Blob,
  ) {
    const parentKey = this.resolveFullKey(param.parent);
    const key = param.name
      ? `${parentKey ? `${parentKey}/` : this.getRootPrefix()}${param.name}`
      : this.resolveFullKey(param);
    if (!key) throw new Error("Invalid file name");
    const opts = this.getOptions();
    const fullKey = `${opts.bucket}/${key}`;
    const { url, headers } = await signS3Request({
      method: "PUT",
      endpoint: opts.endpoint,
      path: fullKey,
      query: [],
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
      body: data,
    });
    await simpleRequest(new URL(url), {
      method: "PUT",
      headers,
      body: data,
    }).blob();
    return this.normalizeFile(
      key,
      data.size,
      new Date().toISOString(),
      key.endsWith("/") ? "folder" : "file",
    );
  }
}
