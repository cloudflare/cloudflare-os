import { describe, expect, it } from "vitest";
import { DocumentConversionError, convertToText, documentKind, type ConversionFailureReason } from "../../src/content/index";
import { buildDocx, buildZip, paragraph, run } from "./test-fixtures";

const encode = (text: string) => new TextEncoder().encode(text);

async function expectFailure(promise: Promise<unknown>, reason: ConversionFailureReason): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => error instanceof DocumentConversionError && error.reason === reason);
}

describe("documentKind", () => {
  it.each([
    ["Report.DOCX", undefined, "docx"],
    ["macro.docm", undefined, "docx"],
    ["template.dotx", undefined, "docx"],
    ["deck.pptm", undefined, "pptx"],
    ["deck.potx", undefined, "pptx"],
    ["notes.md", undefined, "markdown"],
    ["data.csv", undefined, "text"],
    ["page.htm", undefined, "html"],
    ["no-extension", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["no-extension", "text/plain; charset=utf-8", "text"],
    ["feed", "application/atom+xml", "text"],
    ["report.docx", "application/octet-stream", "docx"],
  ])("reads %s (%s) as %s", (name, mimeType, kind) => {
    expect(documentKind(name, mimeType)).toBe(kind);
  });

  it.each([["scan.pdf", "application/pdf"], ["budget.xlsx", undefined], ["legacy.doc", "application/msword"], ["photo.png", "image/png"], ["__proto__", undefined]])(
    "has no converter for %s",
    (name, mimeType) => {
      expect(documentKind(name, mimeType)).toBeUndefined();
    },
  );
});

describe("convertToText", () => {
  it("returns null for unsupported files so the caller can fall back", async () => {
    expect(await convertToText({ bytes: encode("%PDF-1.7"), name: "scan.pdf", mimeType: "application/pdf" })).toBeNull();
  });

  it("converts Word documents to Markdown", async () => {
    const bytes = await buildDocx({ body: paragraph(run("Hello"), '<w:pStyle w:val="Heading1"/>') + paragraph(run("World")) });
    expect(await convertToText({ bytes, name: "a.docx" })).toEqual({ format: "markdown", content: "# Hello\n\nWorld", warnings: [], truncated: false });
  });

  it("warns when a document has no text", async () => {
    const result = await convertToText({ bytes: await buildDocx({ body: paragraph("") }), name: "empty.docx" });
    expect(result?.warnings).toEqual(["The document contains no text."]);
  });

  describe("failures", () => {
    it("reports password-protected Office files as encrypted", async () => {
      const compoundFile = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
      await expectFailure(convertToText({ bytes: compoundFile, name: "secret.docx" }), "encrypted");
    });

    it("reports encrypted ZIP entries as encrypted", async () => {
      await expectFailure(convertToText({ bytes: await buildZip([{ name: "word/document.xml", data: "x", flags: 1 }]), name: "a.docx" }), "encrypted");
    });

    it("reports garbage and malformed XML as corrupt", async () => {
      await expectFailure(convertToText({ bytes: encode("definitely not a zip"), name: "a.docx" }), "corrupt");
      const badXml = await buildZip([{ name: "word/document.xml", data: "<w:document><w:body></w:document>" }]);
      await expectFailure(convertToText({ bytes: badXml, name: "a.docx" }), "corrupt");
    });

    it("reports a package without a main part as corrupt", async () => {
      await expectFailure(convertToText({ bytes: await buildZip([{ name: "other.xml", data: "<x/>" }]), name: "a.pptx" }), "corrupt");
    });

    it("reports an oversized entry as too large", async () => {
      const bomb = await buildZip([{ name: "word/document.xml", data: "x", declaredSize: 100 * 1024 * 1024 }]);
      await expectFailure(convertToText({ bytes: bomb, name: "a.docx" }), "too-large");
    });
  });

  describe("plain text", () => {
    it("decodes UTF-8 with or without a BOM", async () => {
      expect((await convertToText({ bytes: encode("﻿café"), name: "a.txt" }))?.content).toBe("café");
      expect((await convertToText({ bytes: encode("café"), name: "a.txt" }))?.content).toBe("café");
    });

    it("decodes UTF-16 by its BOM", async () => {
      const littleEndian = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00, 0x3d, 0xd8, 0x00, 0xde]);
      const bigEndian = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69, 0xd8, 0x3d, 0xde, 0x00]);
      expect((await convertToText({ bytes: littleEndian, name: "a.txt" }))?.content).toBe("hi😀");
      expect((await convertToText({ bytes: bigEndian, name: "a.txt" }))?.content).toBe("hi😀");
    });

    it("replaces invalid bytes", async () => {
      expect((await convertToText({ bytes: new Uint8Array([0x61, 0xff, 0x62]), name: "a.csv" }))?.content).toBe("a�b");
    });

    it("keeps Markdown files as Markdown", async () => {
      expect(await convertToText({ bytes: encode("# Title"), name: "README.md" })).toMatchObject({ format: "markdown", content: "# Title" });
    });

    it("truncates with a notice, without splitting a surrogate pair", async () => {
      const result = await convertToText({ bytes: encode(`abcd😀${"x".repeat(100)}`), name: "a.txt", maxChars: 5 });
      expect(result?.truncated).toBe(true);
      expect(result?.content).toBe("abcd\n\n[Truncated: the content exceeds 5 characters, and the rest is omitted.]");
    });

    it("decodes only as much of a huge file as the budget needs", async () => {
      const result = await convertToText({ bytes: new Uint8Array(10_000_000).fill(0x61), name: "big.log", maxChars: 1000 });
      expect(result?.truncated).toBe(true);
      expect(result?.content.startsWith("a".repeat(1000))).toBe(true);
    });
  });

  describe("HTML", () => {
    it("reduces HTML to text, dropping scripts, styles and comments", async () => {
      const html = `<!DOCTYPE html><html><head><title>T</title><style>p{}</style></head><body>
        <h1>Heading</h1><!-- secret --><p>One &amp; two&nbsp;&#x41;</p><script>alert("x")</script>
        <ul><li>First</li><li>Second</li></ul><table><tr><td>a</td><td>b</td></tr></table></body></html>`;
      expect(await convertToText({ bytes: encode(html), name: "page.html" })).toEqual({
        format: "text",
        content: "Heading\n\nOne & two A\n\n- First\n- Second\n\na b",
        warnings: [],
        truncated: false,
      });
    });

    it("handles unclosed tags and stray angle brackets in linear time", async () => {
      const hostile = `${"<a".repeat(200_000)} 1 < 2 <script>never closed`;
      const started = performance.now();
      const result = await convertToText({ bytes: encode(hostile), name: "x.html" });
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(result?.content).not.toContain("never closed");
    });
  });
});
