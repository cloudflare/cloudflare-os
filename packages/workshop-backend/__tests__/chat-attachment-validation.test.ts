import { describe, expect, it } from "vitest";
import {
  assertChatAttachmentSize,
  canInlineChatAttachmentImage,
  decodeChatAttachmentText,
  isAllowedChatAttachmentImageMimeType,
  validateChatAttachmentUpload,
} from "../src/chat-attachment-validation.js";

function imageHeader(format: string, width: number, height: number): {mimeType: string; bytes: Uint8Array} {
  if (format === "jpeg") return {mimeType: "image/jpeg", bytes: Uint8Array.of(
    0xff, 0xd8, 0xff, 0xe1, 0, 4, 0, 0, // Metadata before the progressive frame header.
    0xff, 0xff, 0xc2, 0, 11, 8, height >> 8, height, width >> 8, width, 1, 1, 0x11, 0,
  )};
  const bytes = new Uint8Array(30), view = new DataView(bytes.buffer);
  if (format === "png") {
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    view.setUint32(8, 13); view.setUint32(12, 0x49484452);
    view.setUint32(16, width); view.setUint32(20, height);
    return {mimeType: "image/png", bytes};
  }
  bytes.set(new TextEncoder().encode("RIFF"));
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode(`WEBP${format}`), 8);
  view.setUint32(16, 10, true);
  if (format === "VP8X") {
    for (let i = 0; i < 3; ++i) {
      bytes[24 + i] = (width - 1) >>> (8 * i);
      bytes[27 + i] = (height - 1) >>> (8 * i);
    }
  } else if (format === "VP8L") {
    bytes[20] = 0x2f;
    view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  } else {
    bytes.set([0x9d, 1, 0x2a], 23);
    // Top bits encode scaling, not pixel dimensions.
    view.setUint16(26, width | 0x4000, true); view.setUint16(28, height | 0x8000, true);
  }
  return {mimeType: "image/webp", bytes};
}

describe("canInlineChatAttachmentImage", () => {
  it.each(["png", "jpeg", "VP8X", "VP8L", "VP8 "].flatMap(format => [
    {width: 1, height: 1, allowed: true},
    {width: 8000, height: 1, allowed: true},
    {width: 1, height: 8000, allowed: true},
    {width: 8001, height: 1, allowed: false},
    {width: 1, height: 8001, allowed: false},
  ].map(size => ({format, ...size}))))(
    "$format $width×$height: inline=$allowed", ({format, width, height, allowed}) => {
      const {mimeType, bytes} = imageHeader(format, width, height);
      // Views can start at a nonzero buffer offset (for example, a Node Buffer).
      const padded = new Uint8Array(bytes.length + 7); padded.set(bytes, 7);
      expect(canInlineChatAttachmentImage(mimeType, padded.subarray(7))).toBe(allowed);
    },
  );

  it.each(["png", "jpeg", "VP8X", "VP8L", "VP8 "])("keeps truncated %s dimension metadata workspace-only", format => {
    const {mimeType, bytes} = imageHeader(format, 1, 1);
    const dimensionBytes = format === "png" ? 24 : format === "VP8L" ? 25 : bytes.length;
    expect(canInlineChatAttachmentImage(mimeType, bytes)).toBe(true);
    for (let length = 0; length < dimensionBytes; ++length) {
      expect(canInlineChatAttachmentImage(mimeType, bytes.subarray(0, length))).toBe(false);
    }
  });

  it("does not inline zero-sized, unknown, or malformed image headers", () => {
    for (const format of ["png", "jpeg"]) {
      const {mimeType, bytes} = imageHeader(format, 0, 1);
      expect(canInlineChatAttachmentImage(mimeType, bytes)).toBe(false);
    }
    expect(canInlineChatAttachmentImage("image/gif", new Uint8Array())).toBe(false);
    expect(canInlineChatAttachmentImage("image/jpeg", Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0, 0))).toBe(false);
  });

  it.each(["png", "jpeg", "VP8X", "VP8L", "VP8 "].flatMap(format => [
    {width: 2000, height: 2000, allowed: true},
    {width: 2001, height: 1, allowed: false},
    {width: 1, height: 2001, allowed: false},
  ].map(size => ({format, ...size}))))(
    "many-image request: $format $width×$height: inline=$allowed", ({format, width, height, allowed}) => {
      const {mimeType, bytes} = imageHeader(format, width, height);
      expect(canInlineChatAttachmentImage(mimeType, bytes, 2000)).toBe(allowed);
    },
  );
});

describe("assertChatAttachmentSize", () => {
  it("enforces the per-file byte limit of 4 MiB", () => {
    assertChatAttachmentSize(4 * 1024 * 1024);
    expect(() => assertChatAttachmentSize(4 * 1024 * 1024 + 1))
      .toThrow("Chat attachment is too large.");
  });
});

describe("validateChatAttachmentUpload", () => {
  it.each(["application/zip", "application/octet-stream", "audio/mpeg", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"])(
    "accepts %s as an opaque workspace file", mimeType => {
      const bytes = Uint8Array.of(0, 255, 42);
      expect(validateChatAttachmentUpload({mimeType, content: bytes}).content).toBe(bytes);
    },
  );
  it("normalizes MIME parameters before validation", () => {
    let attachment = validateChatAttachmentUpload({
      mimeType: "text/plain; charset=utf-8",
      content: new Uint8Array([1]),
      name: "notes.txt",
    });

    expect(attachment.mimeType).toBe("text/plain");
  });

  it.each([
    { label: "missing MIME type", mimeType: "", name: undefined },
    { label: "MIME type with a newline", mimeType: "text/plain\r\ninvalid", name: "notes.txt" },
    { label: "empty normalized MIME type", mimeType: ";", name: " \r\n " },
  ])("normalizes $label to octet-stream", ({ mimeType, name }) => {
    let attachment = { mimeType, content: new Uint8Array([1]), name };

    expect(() => validateChatAttachmentUpload(attachment)).not.toThrow();
    expect(attachment.mimeType).toBe("application/octet-stream");
  });

  it("accepts matching JPEG content", () => {
    expect(() => validateChatAttachmentUpload({
      mimeType: "image/jpeg",
      content: new Uint8Array([0xff, 0xd8, 0xff]),
      name: "photo.jpg",
    })).not.toThrow();
  });

  it("accepts matching PNG and WebP content", () => {
    expect(() => validateChatAttachmentUpload({
      mimeType: "image/png",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      name: "photo.png",
    })).not.toThrow();

    expect(() => validateChatAttachmentUpload({
      mimeType: "image/webp",
      content: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      name: "photo.webp",
    })).not.toThrow();
  });

  it("rejects image bytes that do not match their MIME", () => {
    expect(() => validateChatAttachmentUpload({
      mimeType: "image/jpeg",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      name: "photo.jpg",
    })).toThrow("Chat attachment content does not match its MIME type.");
  });

  it("checks the PDF signature independently of model selection", () => {
    // "%PDF-"
    expect(() => validateChatAttachmentUpload({
      mimeType: "application/pdf",
      content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]),
      name: "report.pdf",
    })).not.toThrow();

    expect(() => validateChatAttachmentUpload({
      mimeType: "application/pdf",
      content: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
      name: "report.pdf",
    })).toThrow("Chat attachment content does not match its MIME type.");
  });

  it("rejects WebP headers with a mismatch at every checked byte", () => {
    const validWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

    for (const index of [0, 1, 2, 3, 8, 9, 10, 11]) {
      const invalidWebp = validWebp.slice();
      invalidWebp[index] ^= 0xff;

      expect(() => validateChatAttachmentUpload({
        mimeType: "image/webp",
        content: invalidWebp,
        name: "photo.webp",
      })).toThrow("Chat attachment content does not match its MIME type.");
    }
  });

  it("identifies supported image MIME types", () => {
    expect(isAllowedChatAttachmentImageMimeType("image/png; charset=utf-8")).toBe(true);
    expect(isAllowedChatAttachmentImageMimeType(undefined)).toBe(false);
  });
});

describe("decodeChatAttachmentText", () => {
  it("preserves BOMs and empty text", () => {
    expect(decodeChatAttachmentText("text/plain", Uint8Array.of(239, 187, 191, 65))).toBe("\ufeffA");
    expect(decodeChatAttachmentText("text/plain", new Uint8Array())).toBe("");
  });

  it.each([Uint8Array.of(255, 65), Uint8Array.of(65, 0)])("keeps invalid UTF-8 and NUL-containing text opaque", bytes => {
    expect(decodeChatAttachmentText("text/csv", bytes)).toBeUndefined();
  });

  it("does not infer text for explicitly binary MIME types", () => {
    expect(decodeChatAttachmentText("application/pdf", new TextEncoder().encode("%PDF-1.7"))).toBeUndefined();
  });
});
