const { toBase64, toHex } = Uint8Array.prototype;

export function delay(time: number) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

export function b64encode(data: Uint8Array): string {
  if (toBase64) return toBase64.call(data);
  let binary = "";
  for (let cur = 0, len = data.length; cur < len; cur += 9999) {
    binary += String.fromCharCode(
      ...len < 9999 ? data : new Uint8Array(data.buffer, cur, Math.min(len - cur, 9999))
    );
  }
  return btoa(binary);
}

export function b64decode(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function hexEncode(data: Uint8Array): string {
  if (toHex) return toHex.call(data);
  let hex = "";
  for (const byte of data) {
    if (byte < 16) hex += '0';
    hex += byte.toString(16);
  }
  return hex;
}
