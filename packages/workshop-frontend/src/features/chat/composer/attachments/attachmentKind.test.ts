import { describe, expect, it } from "vitest";
import { attachmentKind } from "./attachmentKind";

describe("attachmentKind", () => {
  it("classifies by MIME type", () => {
    expect(attachmentKind("application/pdf")).toBe("pdf");
    expect(attachmentKind("audio/mpeg")).toBe("audio");
    expect(attachmentKind("video/mp4")).toBe("video");
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("text/csv")).toBe("spreadsheet");
    expect(attachmentKind("text/x-python")).toBe("code");
    expect(attachmentKind("text/plain")).toBe("text");
    expect(attachmentKind(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )).toBe("document");
  });

  it("falls back to the extension for untyped files", () => {
    expect(attachmentKind("application/octet-stream", "Report.PDF")).toBe("pdf");
    expect(attachmentKind("application/octet-stream", "main.rs")).toBe("code");
  });

  it("does not read inherited object properties as extensions", () => {
    for (const extension of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(attachmentKind("application/octet-stream", `file.${extension}`)).toBe("file");
    }
  });

  it("uses the generic kind when nothing matches", () => {
    expect(attachmentKind("application/octet-stream", "mystery")).toBe("file");
    expect(attachmentKind("application/octet-stream", "mystery.xyz")).toBe("file");
    expect(attachmentKind("application/octet-stream")).toBe("file");
  });
});
