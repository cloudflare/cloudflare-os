import { describe, expect, it } from "vitest";
import { shortenAttachmentName } from "./attachmentName";

describe("shortenAttachmentName", () => {
  it("leaves short names alone", () => {
    expect(shortenAttachmentName("notes.pdf")).toBe("notes.pdf");
  });

  it("cuts long names in the middle so the extension survives", () => {
    const shortened = shortenAttachmentName("my-very-long-quarterly-planning-document-final.pdf");
    expect(shortened.endsWith("nal.pdf")).toBe(true);
    expect(shortened).toContain("…");
    expect(shortened.length).toBeLessThanOrEqual(24);
  });
});
