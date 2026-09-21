import { describe, expect, it } from "vitest";
import {
  computeReplaceOperations, docTabToMarkdown, markdownToDocRequests,
} from "../src/markdown-converter";
import type { Segment } from "../src/markdown-converter";
import { BULLET_LIST, buildTab } from "./doc-fixture";

/** A segment with a document counterpart, as opposed to a Markdown-syntax-only one. */
type ContentSegment = Exclude<Segment, { syntaxOnly: true }>;

const isContent = (seg: Segment): seg is ContentSegment => !("syntaxOnly" in seg);

const TAB_ID = "tab-1";

/**
 * The document text as Google stores it, aligned so that a string index equals a doc index: index
 * 0 is the section break, and run text begins at 1.
 */
function docText(runs: string[]): string {
  return "\u0000" + runs.join("");
}

/** Every `Location`/`Range` object nested anywhere inside a batchUpdate request. */
function coordinates(requests: unknown[]): Record<string, unknown>[] {
  let found: Record<string, unknown>[] = [];
  let visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "location" || key === "range") found.push(nested as Record<string, unknown>);
      visit(nested);
    }
  };
  visit(requests);
  return found;
}

describe("docTabToMarkdown", () => {
  it("renders headings, inline styles, links and bullets", () => {
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Title\n"], namedStyleType: "HEADING_1" },
      { runs: ["Sub\n"], namedStyleType: "HEADING_2" },
      { runs: [
        "Hello ",
        { text: "bold", style: { bold: true } },
        " and ",
        { text: "it", style: { italic: true } },
        " and ",
        { text: "link", style: { link: { url: "https://e.com" } } },
        ".\n",
      ] },
      { runs: ["one\n"], bullet: { listId: "L1", nestingLevel: 0 } },
      { runs: ["two\n"], bullet: { listId: "L1", nestingLevel: 0 } },
    ], BULLET_LIST));

    expect(snapshot.markdown).toBe(
      "# Title\n\n## Sub\n\nHello **bold** and *it* and [link](https://e.com).\n\n- one\n- two\n");
  });

  it("carries the tab's identity, position and body end index through", () => {
    let snapshot = docTabToMarkdown({
      ...buildTab([{ runs: ["abc\n"] }]),
      tabId: "metrics",
      title: "Metrics",
      parentTabId: "details",
      index: 1,
      nestingLevel: 2,
    });
    expect(snapshot).toMatchObject({
      tabId: "metrics", title: "Metrics", parentTabId: "details", index: 1, nestingLevel: 2,
    });
    // Section break (1) + "abc\n" (4).
    expect(snapshot.bodyEndIndex).toBe(5);
  });
});

// These are what keeps an edit from landing on the wrong characters. A content segment claims a
// 1:1 mapping between Markdown and document indices, and computeReplaceOperations trusts it.
describe("source map invariants", () => {
  let snapshot = docTabToMarkdown(buildTab([
    { runs: ["Title\n"], namedStyleType: "HEADING_1" },
    { runs: [
      "Hello ",
      { text: "bold", style: { bold: true } },
      " and ",
      { text: "link", style: { link: { url: "https://e.com" } } },
      ".\n",
    ] },
    { runs: ["one\n"], bullet: { listId: "L1", nestingLevel: 0 } },
  ], BULLET_LIST));
  let text = docText(["Title\n", "Hello ", "bold", " and ", "link", ".\n", "one\n"]);
  let segments = snapshot.sourceMap.blocks.flatMap(b => b.segments);
  let contentSegments = segments.filter(isContent);

  it("gives every content segment equal length in both spaces", () => {
    for (let seg of contentSegments) {
      expect(seg.mdEnd - seg.mdStart).toBe(seg.docEnd - seg.docStart);
    }
  });

  it("maps every content segment to the same text in both spaces", () => {
    for (let seg of contentSegments) {
      expect(snapshot.markdown.slice(seg.mdStart, seg.mdEnd))
        .toBe(text.slice(seg.docStart, seg.docEnd));
    }
  });

  it("keeps segments non-overlapping and ordered in both spaces", () => {
    let mdCursor = 0;
    let docCursor = 0;
    for (let seg of segments) {
      expect(seg.mdStart).toBeGreaterThanOrEqual(mdCursor);
      expect(seg.mdEnd).toBeGreaterThanOrEqual(seg.mdStart);
      mdCursor = seg.mdEnd;
      if ("syntaxOnly" in seg) continue;
      expect(seg.docStart).toBeGreaterThanOrEqual(docCursor);
      docCursor = seg.docEnd;
    }
  });

  it("keeps each block's segments inside the block's own ranges", () => {
    for (let block of snapshot.sourceMap.blocks) {
      for (let seg of block.segments) {
        expect(seg.mdStart).toBeGreaterThanOrEqual(block.mdStart);
        expect(seg.mdEnd).toBeLessThanOrEqual(block.mdEnd);
        if ("syntaxOnly" in seg) continue;
        expect(seg.docStart).toBeGreaterThanOrEqual(block.docStart);
        expect(seg.docEnd).toBeLessThanOrEqual(block.docEnd);
      }
    }
  });
});

// Tab bodies have independent index spaces, so a coordinate without the selected tab's ID would
// land in whichever tab Google picks by default.
describe("selected-tab write coordinates", () => {
  it("stamps the tab ID on every inserted location and styled range", () => {
    let requests = markdownToDocRequests(
      "# Head\n\n- one\n\n**bold** and [link](https://e.com)\n", 7, "metrics");

    expect(requests.map(request => Object.keys(request)[0])).toEqual([
      "insertText", "updateParagraphStyle", "createParagraphBullets", "updateTextStyle",
      "updateTextStyle",
    ]);
    let found = coordinates(requests);
    expect(found).toHaveLength(requests.length);
    for (const coordinate of found) expect(coordinate.tabId).toBe("metrics");
  });
});

describe("computeReplaceOperations", () => {
  let snapshot = docTabToMarkdown(buildTab([
    { runs: ["Title\n"], namedStyleType: "HEADING_1" },
    { runs: ["Hello ", { text: "bold", style: { bold: true } }, " world.\n"] },
  ]));
  let md = snapshot.markdown;
  let replace = (oldText: string, newText: string) => {
    let start = md.indexOf(oldText);
    expect(start).toBeGreaterThanOrEqual(0);
    return computeReplaceOperations(
      snapshot.sourceMap, md, start, start + oldText.length, newText, TAB_ID);
  };

  it("renders the fixture as expected", () => {
    expect(md).toBe("# Title\n\nHello **bold** world.\n");
  });

  it("emits nothing when the text is unchanged", () => {
    expect(replace("world", "world")).toEqual({ requests: [], trimmedOld: "", trimmedNew: "" });
  });

  it("deletes then re-inserts at the mapped document range", () => {
    expect(replace("world", "there")).toEqual({
      trimmedOld: "world",
      trimmedNew: "there",
      requests: [
        { deleteContentRange: { range: { startIndex: 18, endIndex: 23, tabId: TAB_ID } } },
        { insertText: { location: { index: 18, tabId: TAB_ID }, text: "there" } },
      ],
    });
  });

  it("trims a shared prefix down to a bare insert", () => {
    expect(replace("world", "worlds")).toEqual({
      trimmedOld: "",
      trimmedNew: "s",
      requests: [{ insertText: { location: { index: 23, tabId: TAB_ID }, text: "s" } }],
    });
  });

  it("emits only a delete when the replacement is empty", () => {
    expect(replace("world", "")).toEqual({
      trimmedOld: "world",
      trimmedNew: "",
      requests: [{ deleteContentRange: { range: { startIndex: 18, endIndex: 23, tabId: TAB_ID } } }],
    });
  });

  // BUG (pre-existing, unfixed): when the replaced range touches Markdown syntax, mdRangeToDocRange
  // widens the delete to the whole enclosing block but computeReplaceOperations still inserts only
  // the caller's replacement text, so the rest of the paragraph is destroyed. The approval preview
  // uses a plain string splice and shows the correct result, so the user approves "Hello plain
  // world." and the document becomes "plain".
  //
  // `it.fails` records the correct expectation without failing CI. Delete the `.fails` when fixed.
  it.fails("preserves surrounding text when the range spans Markdown syntax", () => {
    let result = replace("**bold**", "plain");
    let deleted = result.requests[0].deleteContentRange.range;
    let inserted = result.requests[1].insertText.text;
    // The delete covers "Hello bold world.\n" (doc 7..25), so the insert must restore all of it.
    expect({ deleted, inserted }).toEqual({
      deleted: { startIndex: 7, endIndex: 25, tabId: TAB_ID },
      inserted: "Hello plain world.\n",
    });
  });

  it("currently truncates the paragraph in that case", () => {
    let result = replace("**bold**", "plain");
    expect(result.requests).toEqual([
      { deleteContentRange: { range: { startIndex: 7, endIndex: 25, tabId: TAB_ID } } },
      { insertText: { location: { index: 7, tabId: TAB_ID }, text: "plain" } },
    ]);
  });
});
