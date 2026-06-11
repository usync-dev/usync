import { describe, expect, it } from "vitest";
import { XMLParser } from "./xmlparser";

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
});

describe("XMLParser", () => {
  describe("basic elements", () => {
    it("parses simple text element", () => {
      expect(parser.parse("<name>hello</name>")).toEqual({ name: "hello" });
    });

    it("parses numeric text element", () => {
      expect(parser.parse("<size>1234</size>")).toEqual({ size: 1234 });
    });

    it("parses zero as number", () => {
      expect(parser.parse("<size>0</size>")).toEqual({ size: 0 });
    });

    it("parses empty element", () => {
      expect(parser.parse("<empty/>")).toEqual({ empty: {} });
      expect(parser.parse("<empty></empty>")).toEqual({ empty: {} });
    });

    it("parses nested elements", () => {
      const xml = `<root><a>1</a><b>2</b></root>`;
      expect(parser.parse(xml)).toEqual({ root: { a: 1, b: 2 } });
    });
  });

  describe("attributes", () => {
    it("parses attributes with @ prefix", () => {
      const xml = `<item id="42" name="foo"/>`;
      expect(parser.parse(xml)).toEqual({ item: { "@id": "42", "@name": "foo" } });
    });
  });

  describe("namespace prefix removal", () => {
    it("strips namespace prefixes from tag names", () => {
      const xml = `<D:multistatus xmlns:D="DAV:"><D:response>ok</D:response></D:multistatus>`;
      const result = parser.parse(xml);
      expect(result).toHaveProperty("multistatus");
      expect(result.multistatus).toHaveProperty("response");
    });

    it("preserves prefixes when removeNSPrefix is false", () => {
      const strict = new XMLParser({ removeNSPrefix: false });
      const xml = `<D:root xmlns:D="DAV:"><D:child>text</D:child></D:root>`;
      const result = strict.parse(xml);
      expect(result).toHaveProperty("D:root");
      expect(result["D:root"]).toHaveProperty("D:child");
    });
  });

  describe("attributes disabled", () => {
    it("ignores attributes when ignoreAttributes is true", () => {
      const strict = new XMLParser({ ignoreAttributes: true });
      const xml = `<item id="42"><name>foo</name></item>`;
      const result = strict.parse(xml);
      expect(result.item).not.toHaveProperty("@id");
      expect(result).toEqual({ item: { name: "foo" } });
    });
  });

  describe("arrays", () => {
    it("returns array for repeated sibling elements", () => {
      const xml = `<root><item>a</item><item>b</item><item>c</item></root>`;
      const result = parser.parse(xml);
      expect(result.root.item).toEqual(["a", "b", "c"]);
    });

    it("does not wrap single element in array", () => {
      const xml = `<root><item>a</item></root>`;
      const result = parser.parse(xml);
      expect(result.root.item).toBe("a");
    });
  });

  describe("XML declarations and comments", () => {
    it("strips XML declaration", () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?><root>ok</root>`;
      expect(parser.parse(xml)).toEqual({ root: "ok" });
    });

    it("strips comments", () => {
      const xml = `<root><!-- comment --><child>text</child></root>`;
      expect(parser.parse(xml)).toEqual({ root: { child: "text" } });
    });
  });

  describe("WebDAV PROPFIND response", () => {
    it("parses a real PROPFIND response", () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/test/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Test</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>Mon, 12 Jun 2023 10:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/test/file.txt</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>file.txt</D:displayname>
        <D:getcontentlength>1234</D:getcontentlength>
        <D:getlastmodified>Mon, 12 Jun 2023 11:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

      const doc = parser.parse(xml);
      let response = doc["multistatus"]["response"];
      if (!Array.isArray(response)) response = response ? [response] : [];

      expect(response).toHaveLength(2);

      const folder = response[0];
      expect(folder["href"]).toBe("/test/");
      const fProp = folder["propstat"]["prop"];
      expect(fProp["displayname"]).toBe("Test");
      expect(fProp["resourcetype"]?.["collection"]).toEqual({});
      expect(new Date(fProp["getlastmodified"]).toISOString()).toBe("2023-06-12T10:00:00.000Z");

      const file = response[1];
      expect(file["href"]).toBe("/test/file.txt");
      const pProp = file["propstat"]["prop"];
      expect(pProp["displayname"]).toBe("file.txt");
      expect(pProp["getcontentlength"]).toBe(1234);
    });
  });

  describe("S3 ListBucket response", () => {
    it("parses a real ListBucket response", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents>
    <Key>photos/cat.jpg</Key>
    <LastModified>2023-06-12T10:00:00.000Z</LastModified>
    <Size>12345</Size>
  </Contents>
  <Contents>
    <Key>photos/dog.jpg</Key>
    <LastModified>2023-06-12T11:00:00.000Z</LastModified>
    <Size>67890</Size>
  </Contents>
  <CommonPrefixes>
    <Prefix>photos/cats/</Prefix>
  </CommonPrefixes>
  <NextContinuationToken>abc123</NextContinuationToken>
</ListBucketResult>`;

      const doc = parser.parse(xml);
      const result = doc["ListBucketResult"];

      expect(result["Contents"]).toHaveLength(2);
      expect(result["Contents"][0]["Key"]).toBe("photos/cat.jpg");
      expect(result["Contents"][0]["Size"]).toBe(12345);
      expect(result["Contents"][1]["Key"]).toBe("photos/dog.jpg");

      expect(result["CommonPrefixes"]["Prefix"]).toBe("photos/cats/");
      expect(result["NextContinuationToken"]).toBe("abc123");
    });

    it("handles single Contents element (not array)", () => {
      const xml = `<ListBucketResult>
  <Contents>
    <Key>file.txt</Key>
    <Size>100</Size>
  </Contents>
</ListBucketResult>`;

      const doc = parser.parse(xml);
      const contents = doc["ListBucketResult"]["Contents"];
      expect(contents["Key"]).toBe("file.txt");
      expect(contents["Size"]).toBe(100);
    });

    it("handles xmlns attribute on root", () => {
      const xml = `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Contents>
    <Key>file.txt</Key>
    <Size>100</Size>
  </Contents>
</ListBucketResult>`;

      const doc = parser.parse(xml);
      const result = doc["ListBucketResult"];
      expect(result).not.toHaveProperty("@xmlns");
      expect(result["Contents"]["Key"]).toBe("file.txt");
    });

    it("handles prefixed namespaces on elements", () => {
      const xml = `<s3:ListBucketResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/">
  <s3:Contents>
    <s3:Key>file.txt</s3:Key>
    <s3:Size>100</s3:Size>
  </s3:Contents>
</s3:ListBucketResult>`;

      const doc = parser.parse(xml);
      const result = doc["ListBucketResult"];
      expect(result).not.toHaveProperty("@xmlns:s3");
      expect(result["Contents"]["Key"]).toBe("file.txt");
      expect(result["Contents"]["Size"]).toBe(100);
    });
  });
});
