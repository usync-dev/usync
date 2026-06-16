import { nanoid } from "nanoid";

function b64urlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function getState() {
  return nanoid(8);
}

/**
 * Ref: https://datatracker.ietf.org/doc/html/rfc7636#section-4.1
 * high-entropy cryptographic random STRING using the
 * unreserved characters [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
 * from Section 2.3 of [RFC3986], with a minimum length of 43 characters
 * and a maximum length of 128 characters.
 */
export function getCodeVerifier() {
  return nanoid(64);
}

export function getNonce() {
  return nanoid(32);
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const binary = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const decoded = new TextDecoder("utf-8").decode(bytes);
  return JSON.parse(decoded);
}

export async function getCodeChallenge(codeVerifier: string) {
  const method = "S256";
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const challenge = b64urlEncode(new Uint8Array(buffer));
  return {
    codeChallenge: challenge,
    codeChallengeMethod: method,
  };
}
