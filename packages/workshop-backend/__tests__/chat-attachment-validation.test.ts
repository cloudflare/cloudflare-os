import { describe, expect, it } from "vitest";
import {
  assertChatAttachmentSize,
  decodeChatAttachmentText,
  isAllowedChatAttachmentImageMimeType,
  validateChatAttachmentUpload,
} from "../src/chat-attachment-validation.js";

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
