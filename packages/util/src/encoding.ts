export function b64encodeModern(data: Uint8Array): string | undefined {
  return data.toBase64?.();
}

export function b64encodeFallback(data: Uint8Array): string {
  return btoa(toBinaryString(data));
}

export function b64encode(data: Uint8Array): string {
  return b64encodeModern(data) ?? b64encodeFallback(data);
}

export function b64decodeModern(data: string): Uint8Array<ArrayBuffer> | undefined {
  return Uint8Array.fromBase64?.(data);
}

export function b64decodeFallback(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function b64decode(data: string): Uint8Array<ArrayBuffer> {
  return b64decodeModern(data) ?? b64decodeFallback(data);
}

export function b64urlEncodeModern(data: Uint8Array): string | undefined {
  return data.toBase64?.({ alphabet: "base64url", omitPadding: true });
}

export function b64urlEncodeFallback(data: Uint8Array): string {
  return btoa(toBinaryString(data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlEncode(data: Uint8Array): string {
  return b64urlEncodeModern(data) ?? b64urlEncodeFallback(data);
}

export function b64urlDecodeModern(data: string): Uint8Array<ArrayBuffer> | undefined {
  return Uint8Array.fromBase64?.(data.replace(/\+/g, "-").replace(/\//g, "_"), {
    alphabet: "base64url",
  });
}

export function b64urlDecodeFallback(data: string): Uint8Array<ArrayBuffer> {
  return b64decodeFallback(data.replace(/-/g, "+").replace(/_/g, "/"));
}

export function b64urlDecode(data: string): Uint8Array<ArrayBuffer> {
  return b64urlDecodeModern(data) ?? b64urlDecodeFallback(data);
}

export function hexEncodeModern(data: Uint8Array): string | undefined {
  return data.toHex?.();
}

export function hexEncodeFallback(data: Uint8Array): string {
  let hex = "";
  for (const byte of data) {
    if (byte < 16) hex += "0";
    hex += byte.toString(16);
  }
  return hex;
}

export function hexEncode(data: Uint8Array): string {
  return hexEncodeModern(data) ?? hexEncodeFallback(data);
}

function toBinaryString(data: Uint8Array): string {
  let binary = "";
  for (let cur = 0; cur < data.length; cur += 9999) {
    binary += String.fromCharCode(...data.subarray(cur, cur + 9999));
  }
  return binary;
}
