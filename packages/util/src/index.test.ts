import { describe, expect, it } from "vitest";
import * as usyncUtil from ".";
import {
  b64decodeFallback,
  b64decodeModern,
  b64encodeFallback,
  b64encodeModern,
  b64urlDecodeFallback,
  b64urlDecodeModern,
  b64urlEncodeFallback,
  b64urlEncodeModern,
  hexEncodeFallback,
  hexEncodeModern,
} from "./encoding";

function randomBytes(len: number): Uint8Array {
  const data = new Uint8Array(len);
  for (let i = 0; i < len; i++) data[i] = Math.floor(Math.random() * 256);
  return data;
}

function offsetView(len: number, offset: number): Uint8Array {
  const buf = new Uint8Array(len + offset);
  crypto.getRandomValues(buf);
  return new Uint8Array(buf.buffer, offset, len);
}

function ref(data: Uint8Array, encoding: "base64" | "base64url" | "hex"): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(encoding);
}

const corpus = [
  new Uint8Array(0),
  new Uint8Array([0]),
  new Uint8Array([0, 1, 15, 16, 255]),
  randomBytes(100),
  randomBytes(9998),
  randomBytes(9999),
  randomBytes(10000),
  randomBytes(20000),
  offsetView(20000, 7),
  offsetView(3, 13),
];

describe("b64encode", () => {
  it("modern and fallback agree on all inputs", () => {
    for (const data of corpus) {
      expect(b64encodeModern(data)).toBe(b64encodeFallback(data));
      expect(b64encodeModern(data)).toBe(ref(data, "base64"));
    }
  });

  it("encodes known values", () => {
    expect(usyncUtil.b64encode(new Uint8Array(0))).toBe("");
    expect(usyncUtil.b64encode(new TextEncoder().encode("hello world"))).toBe("aGVsbG8gd29ybGQ=");
  });
});

describe("b64decode", () => {
  it("modern and fallback agree, and both round-trip", () => {
    for (const data of corpus) {
      const encoded = b64encodeFallback(data);
      expect(Array.from(b64decodeModern(encoded)!)).toEqual(Array.from(data));
      expect(Array.from(b64decodeFallback(encoded))).toEqual(Array.from(data));
    }
  });

  it("decodes unpadded and whitespace input like atob does", () => {
    const expected = Array.from(new TextEncoder().encode("hello world"));
    for (const input of ["aGVsbG8gd29ybGQ", "aGVsbG8g\nd29ybGQ="]) {
      expect(Array.from(usyncUtil.b64decode(input))).toEqual(expected);
    }
  });
});

describe("b64urlEncode", () => {
  it("modern and fallback agree on all inputs", () => {
    for (const data of corpus) {
      expect(b64urlEncodeModern(data)).toBe(b64urlEncodeFallback(data));
      expect(b64urlEncodeModern(data)).toBe(ref(data, "base64url"));
    }
  });
});

describe("b64urlDecode", () => {
  it("modern and fallback agree, and both round-trip", () => {
    for (const data of corpus) {
      const encoded = b64urlEncodeFallback(data);
      expect(Array.from(b64urlDecodeModern(encoded)!)).toEqual(Array.from(data));
      expect(Array.from(b64urlDecodeFallback(encoded))).toEqual(Array.from(data));
    }
  });

  it("accepts the standard base64 alphabet too", () => {
    const expected = Array.from([0, 255, 128]);
    expect(Array.from(usyncUtil.b64urlDecode("AP+A"))).toEqual(expected);
    expect(Array.from(usyncUtil.b64urlDecode("AP-A"))).toEqual(expected);
  });
});

describe("hexEncode", () => {
  it("modern and fallback agree on all inputs", () => {
    for (const data of corpus) {
      expect(hexEncodeModern(data)).toBe(hexEncodeFallback(data));
      expect(hexEncodeModern(data)).toBe(ref(data, "hex"));
    }
  });

  it("pads low bytes", () => {
    expect(usyncUtil.hexEncode(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });
});

describe("public surface", () => {
  it("exports only the optimized functions", () => {
    expect(Object.keys(usyncUtil).sort()).toEqual([
      "b64decode",
      "b64encode",
      "b64urlDecode",
      "b64urlEncode",
      "hexEncode",
    ]);
  });
});
