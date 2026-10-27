import { describe, expect, it } from "vitest";
import type { GoogleDocsDocument, GoogleDocsTab, StructuralElement } from "../src/docs-api";
import {
  composeComment, composeReply, composeResolve, composeSuggestion, headingLink, locateQuote,
  selectTab,
} from "../src/drive-comment-body";
import { MAX_COMMENT_BYTES, MAX_QUOTE_CHARS } from "../src/drive-api";

/** A paragraph of text runs, optionally a heading with Google's `headingId`. */
function paragraph(runs: string[], headingId?: string): StructuralElement {
  return {
    startIndex: 0, endIndex: 0,
    paragraph: {
      elements: runs.map(content => ({ startIndex: 0, endIndex: 0, textRun: { content, textStyle: {} } })),
      paragraphStyle: headingId
        ? { namedStyleType: "HEADING_2", headingId }
        : { namedStyleType: "NORMAL_TEXT" },
    },
  };
}

function table(rows: StructuralElement[][][]): StructuralElement {
  return {
    startIndex: 0, endIndex: 0,
    table: {
      tableRows: rows.map(cells => ({
        startIndex: 0, endIndex: 0,
        tableCells: cells.map(content => ({ startIndex: 0, endIndex: 0, content })),
      })),
    },
  };
}

function tab(tabId: string, content: StructuralElement[], extra: Partial<GoogleDocsTab> = {}): GoogleDocsTab {
  return {
    tabId, title: tabId, index: 0, nestingLevel: 0, lists: {}, namedRanges: {},
    body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, ...content] },
    ...extra,
  };
}

function document(tabs: GoogleDocsTab[]): GoogleDocsDocument {
  return { documentId: "doc-1", title: "Plan", tabs };
}

describe("selectTab", () => {
  let first = tab("t.0", []);
  let child = tab("t.child", [], { parentTabId: "t.0", nestingLevel: 1 });
  let second = tab("t.1", [], { index: 1 });
  let doc = document([first, child, second]);

  it("defaults to the first tab", () => {
    expect(selectTab(doc)).toBe(first);
  });

  it("picks a named tab, a nested child tab included", () => {
    expect(selectTab(doc, "t.1")).toBe(second);
    expect(selectTab(doc, "t.child")).toBe(child);
  });

  it("refuses an unknown tab, naming the tabs there are", () => {
    expect(() => selectTab(doc, "t.9"))
      .toThrow('This document has no tab "t.9". Its tabs are: t.0, t.child, t.1.');
  });
});

describe("locateQuote", () => {
  it("finds a quote in a paragraph and returns no heading when none precedes it", () => {
    expect(locateQuote(tab("t.0", [paragraph(["The budget is final.\n"])]), "budget")).toBeUndefined();
  });

  it("returns the nearest heading above the quote", () => {
    let content = [
      paragraph(["Plan\n"], "h.title"),
      paragraph(["Intro text.\n"]),
      paragraph(["Costs\n"], "h.costs"),
      paragraph(["The budget is final.\n"]),
      paragraph(["Risks\n"], "h.risks"),
    ];
    expect(locateQuote(tab("t.0", content), "budget is final")).toBe("h.costs");
  });

  it("returns the heading the quote is in", () => {
    let content = [paragraph(["Intro\n"], "h.intro"), paragraph(["Costs\n"], "h.costs")];
    expect(locateQuote(tab("t.0", content), "Costs")).toBe("h.costs");
  });

  it("matches across text runs", () => {
    let content = [paragraph(["Costs\n"], "h.costs"), paragraph(["The bud", "get is ", "final.\n"])];
    expect(locateQuote(tab("t.0", content), "budget is final")).toBe("h.costs");
  });

  it("finds text inside table cells, nested tables included, under the heading above the table", () => {
    let content = [
      paragraph(["Numbers\n"], "h.numbers"),
      table([[[paragraph(["Q1\n"])], [table([[[paragraph(["Revenue 42\n"])]]])]]]),
    ];
    expect(locateQuote(tab("t.0", content), "Revenue 42")).toBe("h.numbers");
  });

  it("trims the quote but compares the rest exactly", () => {
    let content = [paragraph(["Costs\n"], "h.costs"), paragraph(["Caf\u00e9  budget\n"])];
    expect(locateQuote(tab("t.0", content), "  Caf\u00e9  budget \n")).toBe("h.costs");
    // A decomposed e with an accent against the document's composed one, and one space for two,
    // are not the same text.
    expect(() => locateQuote(tab("t.0", content), "Cafe\u0301  budget")).toThrow("not found");
    expect(() => locateQuote(tab("t.0", content), "Caf\u00e9 budget")).toThrow("not found");
  });

  it("refuses text that is not in the tab", () => {
    expect(() => locateQuote(tab("t.0", [paragraph(["Hello\n"])]), "Goodbye"))
      .toThrow("That text was not found in tab t.0. Quote it as written, without " +
        "Markdown or HTML formatting, and pass tabId if it is in another tab.");
  });

  it("refuses a quote that crosses a paragraph or line break", () => {
    let content = [paragraph(["First line.\n"]), paragraph(["Second line.\n"])];
    for (let quote of ["line.\n\nSecond", "line.\nSecond", "line.\u000bSecond"]) {
      expect(() => locateQuote(tab("t.0", content), quote))
        .toThrow("A quote must sit within one paragraph; quote part of one paragraph instead.");
    }
  });

  it("reads chips as the Markdown shows them", () => {
    let chips: StructuralElement = {
      startIndex: 0, endIndex: 0,
      paragraph: {
        elements: [
          { startIndex: 0, endIndex: 0, textRun: { content: "Ask ", textStyle: {} } },
          { startIndex: 0, endIndex: 0, person: { personProperties: { name: "Alice" } } },
          { startIndex: 0, endIndex: 0, textRun: { content: " by ", textStyle: {} } },
          { startIndex: 0, endIndex: 0, dateElement: { dateElementProperties: { displayText: "Oct 21, 2026" } } },
          { startIndex: 0, endIndex: 0, textRun: { content: "\n", textStyle: {} } },
        ],
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      },
    };
    let content = [paragraph(["Owners\n"], "h.owners"), chips];
    expect(locateQuote(tab("t.0", content), "Ask Alice by Oct 21, 2026")).toBe("h.owners");
  });

  it("refuses text that appears more than once, counting overlaps", () => {
    expect(() => locateQuote(tab("t.0", [paragraph(["a cat, a cat\n"]), paragraph(["a cat\n"])]), "a cat"))
      .toThrow("That text appears 3 times; quote more of it so it is unique.");
    expect(() => locateQuote(tab("t.0", [paragraph(["aaa\n"])]), "aa"))
      .toThrow("That text appears 2 times");
  });

  it("refuses an empty quote", () => {
    expect(() => locateQuote(tab("t.0", [paragraph(["Hello\n"])]), "  ")).toThrow("The quote is empty.");
  });

  it("reads only text runs, skipping malformed elements", () => {
    let content = [
      paragraph(["Costs\n"], "h.costs"),
      { startIndex: 0, endIndex: 0, paragraph: { elements: [{ person: {} }, null, { textRun: { content: 7 } }] } },
      paragraph(["Total\n"]),
    ] as unknown as StructuralElement[];
    expect(locateQuote(tab("t.0", content), "Total")).toBe("h.costs");
  });
});

describe("headingLink", () => {
  it("links the tab and heading, encoding each part", () => {
    expect(headingLink("doc-1", "t.0", "h.xgjl2srtytjt"))
      .toBe("https://docs.google.com/document/d/doc-1/edit?tab=t.0#heading=h.xgjl2srtytjt");
    expect(headingLink("a/b", "t 1", "h#x&y"))
      .toBe("https://docs.google.com/document/d/a%2Fb/edit?tab=t%201#heading=h%23x%26y");
  });
});

describe("composeComment", () => {
  const LINK = "https://docs.google.com/document/d/doc-1/edit?tab=t.0#heading=h.costs";

  it("is the trimmed text alone without a quote", () => {
    expect(composeComment("  Looks good.\n")).toBe("Looks good.");
  });

  it("puts the quote, the text and the link in their own paragraphs", () => {
    expect(composeComment("Is this final?", " the budget ", LINK))
      .toBe(`"the budget"\n\nIs this final?\n\n${LINK}`);
  });

  it("leaves the link out when there is none", () => {
    expect(composeComment("Is this final?", "the budget")).toBe('"the budget"\n\nIs this final?');
  });

  it("keeps the text's inner whitespace and characters exactly", () => {
    let text = "line1\r\nline2   \n\ttabbed e\u0301 \u00e9 \u{1F600} \u200d \u00a0end";
    expect(composeComment(text)).toBe(text);
  });

  it("refuses empty or whitespace-only text, even with a quote", () => {
    expect(() => composeComment("")).toThrow("The comment is empty.");
    expect(() => composeComment(" \n\t", "the budget")).toThrow("The comment is empty.");
  });

  it("refuses an empty quote", () => {
    expect(() => composeComment("Why?", "  ")).toThrow("The quote is empty.");
  });

  it("caps the quote in characters, not bytes", () => {
    expect(composeComment("Why?", "\u00e9".repeat(MAX_QUOTE_CHARS))).toContain("\u00e9".repeat(MAX_QUOTE_CHARS));
    expect(() => composeComment("Why?", "x".repeat(MAX_QUOTE_CHARS + 1)))
      .toThrow(`The quote is ${MAX_QUOTE_CHARS + 1} characters; at most ${MAX_QUOTE_CHARS} can be quoted.`);
  });

  it("allows exactly Google's limit in UTF-8 bytes and refuses one byte more", () => {
    expect(composeComment("a".repeat(MAX_COMMENT_BYTES))).toHaveLength(MAX_COMMENT_BYTES);
    expect(composeComment("\u00e9".repeat(2048))).toHaveLength(2048);
    expect(() => composeComment("a".repeat(MAX_COMMENT_BYTES + 1)))
      .toThrow("The comment is 4097 bytes of UTF-8; Google Drive allows at most 4096.");
    expect(() => composeComment("\u00e9".repeat(2049)))
      .toThrow("The comment is 4098 bytes of UTF-8; Google Drive allows at most 4096.");
  });

  it("counts the quote and the link against the limit", () => {
    // `"abcd"`, a paragraph break, then the text: 6 + 2 + 4088 bytes.
    let text = "a".repeat(MAX_COMMENT_BYTES - 8);
    expect(composeComment(text, "abcd")).toHaveLength(MAX_COMMENT_BYTES);
    expect(() => composeComment(text, "abcde")).toThrow("The comment is 4097 bytes");
    expect(() => composeComment(text, "abcd", "x")).toThrow("The comment is 4099 bytes");
  });
});

describe("composeSuggestion", () => {
  const LINK = "https://docs.google.com/document/d/doc-1/edit?tab=t.0#heading=h.costs";

  it("states the replacement, then the note and the link", () => {
    expect(composeSuggestion(" 2025 ", "2026", " The year moved. ", LINK))
      .toBe(`Suggested edit: replace "2025" with "2026"\n\nThe year moved.\n\n${LINK}`);
  });

  it("is the replacement alone without a note or link", () => {
    expect(composeSuggestion("2025", "2026")).toBe('Suggested edit: replace "2025" with "2026"');
  });

  it("keeps the new text exactly as given", () => {
    expect(composeSuggestion("teh", " the ")).toBe('Suggested edit: replace "teh" with " the "');
  });

  it("states a deletion when the new text is empty", () => {
    expect(composeSuggestion("very very", "", undefined, LINK))
      .toBe(`Suggested edit: delete "very very"\n\n${LINK}`);
  });

  it("refuses a replacement identical to the old text", () => {
    expect(() => composeSuggestion("same", "same"))
      .toThrow("The replacement is the same as the text it replaces.");
  });

  it("refuses empty old text, an empty note, and old text over the quote cap", () => {
    expect(() => composeSuggestion(" ", "x")).toThrow("The text to replace is empty.");
    expect(() => composeSuggestion("a", "b", "  ")).toThrow("The note is empty.");
    expect(() => composeSuggestion("x".repeat(MAX_QUOTE_CHARS + 1), "y"))
      .toThrow(`The text to replace is ${MAX_QUOTE_CHARS + 1} characters`);
  });

  it("refuses a body over Google's limit", () => {
    expect(() => composeSuggestion("a", "b".repeat(MAX_COMMENT_BYTES)))
      .toThrow(/^The comment is \d+ bytes of UTF-8; Google Drive allows at most 4096\.$/);
  });
});

describe("composeReply and composeResolve", () => {
  it("trims a reply and refuses an empty one", () => {
    expect(composeReply(" Done. \n")).toBe("Done.");
    expect(() => composeReply(" ")).toThrow("The reply is empty.");
  });

  it("caps a reply at Google's limit", () => {
    expect(composeReply("a".repeat(MAX_COMMENT_BYTES))).toHaveLength(MAX_COMMENT_BYTES);
    expect(() => composeReply("a".repeat(MAX_COMMENT_BYTES + 1)))
      .toThrow("The reply is 4097 bytes of UTF-8; Google Drive allows at most 4096.");
  });

  it("resolves without content when given no text", () => {
    expect(composeResolve()).toBeUndefined();
    expect(composeResolve(" Fixed. ")).toBe("Fixed.");
  });

  it("refuses blank resolve text rather than sending an empty reply", () => {
    expect(() => composeResolve("  "))
      .toThrow("The reply is empty; leave it out to resolve without a reply.");
  });
});
