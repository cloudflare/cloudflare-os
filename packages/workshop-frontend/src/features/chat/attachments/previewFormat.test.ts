import { describe, expect, it } from "vitest";
import { looksLikeText, previewFormat } from "./previewFormat";

const OCTETS = "application/octet-stream";

describe("previewFormat", () => {
  it("separates the formats one attachment kind covers", () => {
    expect(previewFormat("text/csv", "people.csv")).toBe("delimited");
    expect(previewFormat(OCTETS, "people.tsv")).toBe("delimited");
    expect(previewFormat(OCTETS, "budget.xlsx")).toBe("workbook");
    expect(previewFormat("text/markdown", "notes.md")).toBe("markdown");
    expect(previewFormat("text/plain", "notes.txt")).toBe("text");
    expect(previewFormat("application/json", "data.json")).toBe("text");
  });

  it("previews only the Office formats the browser can read", () => {
    expect(previewFormat(OCTETS, "report.docx")).toBe("document");
    expect(previewFormat(OCTETS, "deck.pptx")).toBe("slides");
    expect(previewFormat("application/msword", "report.doc")).toBeUndefined();
    expect(previewFormat("application/vnd.ms-excel", "budget.xls")).toBeUndefined();
    expect(previewFormat("application/vnd.ms-powerpoint", "deck.ppt")).toBeUndefined();
  });

  it("previews only the images a browser decodes", () => {
    expect(previewFormat("image/png", "shot.png")).toBe("image");
    expect(previewFormat("image/svg+xml", "logo.svg")).toBe("image");
    expect(previewFormat("image/heic", "photo.heic")).toBeUndefined();
  });

  it("has nothing for archives and unknown files", () => {
    expect(previewFormat("application/zip", "bundle.zip")).toBeUndefined();
    expect(previewFormat(OCTETS, "mystery")).toBeUndefined();
  });
});

describe("looksLikeText", () => {
  it("accepts UTF-8, including a character cut at the sampled boundary", () => {
    expect(looksLikeText(new TextEncoder().encode("FROM node:22\nRUN true\n"))).toBe(true);
    expect(looksLikeText(new TextEncoder().encode("a".repeat(8191) + "é"))).toBe(true);
  });

  it("rejects binary content", () => {
    expect(looksLikeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false);
  });

  it("goes by an exact type before the coarse kind, which takes any text type for plain text", () => {
    expect(previewFormat("text/tab-separated-values", "data.tsv")).toBe("delimited");
    expect(previewFormat("text/tab-separated-values", "export")).toBe("delimited");
    expect(previewFormat("text/x-markdown", "notes")).toBe("markdown");
    expect(previewFormat("text/plain", "people.csv")).toBe("delimited");
  });

  it("has no preview for audio or video, which can only be downloaded", () => {
    expect(previewFormat("audio/mpeg", "song.mp3")).toBeUndefined();
    expect(previewFormat("video/mp4", "clip.mp4")).toBeUndefined();
  });
});
