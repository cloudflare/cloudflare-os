import { describe, expect, it } from "vitest";
import {
  MAX_PREVIEW_TAB_MARKDOWN, PREVIEW_EDIT_CONTEXT, previewTrimPlaceholder, trimDocumentPreviewMarkdown,
} from "../src/docs-preview";

/** `count` numbered paragraphs of filler, each `size` characters plus its blank line. */
function paragraphs(count: number, size = 100): string[] {
  return Array.from({ length: count }, (_, i) => `p${i} `.padEnd(size, "x"));
}

describe("trimDocumentPreviewMarkdown", () => {
  it("returns a tab within the cap whole", () => {
    let markdown = paragraphs(10).join("\n\n") + "\n";
    expect(trimDocumentPreviewMarkdown(markdown, [])).toBe(markdown);
  });

  it("keeps the context around each edit and marks every cut", () => {
    let blocks = paragraphs(6000);
    blocks[1000] = "FIRST EDIT";
    blocks[5000] = "SECOND EDIT";
    let markdown = blocks.join("\n\n") + "\n";
    expect(markdown.length).toBeGreaterThan(MAX_PREVIEW_TAB_MARKDOWN);
    let first = markdown.indexOf("FIRST EDIT");
    let second = markdown.indexOf("SECOND EDIT");

    let trimmed = trimDocumentPreviewMarkdown(markdown, [
      { start: first, end: first + "FIRST EDIT".length },
      { start: second, end: second + "SECOND EDIT".length },
    ]);

    expect(trimmed.length).toBeLessThan(6 * PREVIEW_EDIT_CONTEXT);
    expect(trimmed).toContain("\n\nFIRST EDIT\n\n");
    expect(trimmed).toContain("\n\nSECOND EDIT\n\n");
    // A cut never falls within the context, and lands on a paragraph boundary.
    expect(trimmed).toContain(markdown.slice(first - PREVIEW_EDIT_CONTEXT, first));
    expect(trimmed).toContain(markdown.slice(second, second + PREVIEW_EDIT_CONTEXT));
    let placeholders = trimmed.match(/\*\[[\d,]+ characters of this tab are not shown/g) ?? [];
    expect(placeholders).toHaveLength(3);
    expect(trimmed.split(/\n\n\*\[[^\]]*\]\*\n\n/).every(part => part === "" ||
      markdown.includes(part))).toBe(true);
  });

  it("keeps the beginning of an oversized tab with nothing to anchor", () => {
    let markdown = paragraphs(6000).join("\n\n");
    let trimmed = trimDocumentPreviewMarkdown(markdown, []);
    expect(trimmed.startsWith(markdown.slice(0, 1000))).toBe(true);
    expect(trimmed.length).toBeLessThanOrEqual(MAX_PREVIEW_TAB_MARKDOWN + 200);
    expect(trimmed).toContain(previewTrimPlaceholder(markdown.length - trimmed.indexOf("\n\n*[")));
  });

  it("stops at the cap when the edits' context would exceed it", () => {
    let blocks = paragraphs(20_000);
    let markdown = blocks.join("\n\n");
    let keep = blocks.map((_, i) => i).filter(i => i % 200 === 0).map(i => {
      let start = markdown.indexOf(`p${i} x`);
      return { start, end: start + 10 };
    });
    let trimmed = trimDocumentPreviewMarkdown(markdown, keep);
    expect(trimmed.length).toBeLessThanOrEqual(MAX_PREVIEW_TAB_MARKDOWN + 10_000);
    expect(trimmed).toContain(`p0 x`);
  });
});
