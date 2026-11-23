import { describe, expect, it } from "vitest";
import type {
  GoogleDocsDocument, GoogleDocsTab, ParagraphElement, StructuralElement,
} from "../src/docs-api";
import {
  checkSuggestion, composeComment, composeReply, composeResolve, locateQuote, requireQuote,
  selectTab,
} from "../src/drive-comment-body";
import {
  MAX_COMMENT_BYTES, MAX_DOCS_COMMENT_BYTES, MAX_QUOTE_CHARS, MAX_REPLACEMENT_CHARS,
} from "../src/drive-api";

/** A part of a paragraph: a text run, or a chip that reads as text but takes one index. */
type Part = string | { person: string } | { date: string } | { dropdown: true };

/** A paragraph of text runs and chips, its indices filled in later by {@link tab}. */
function paragraph(parts: Part[], headingId?: string): StructuralElement {
  return {
    startIndex: 0, endIndex: 0,
    paragraph: {
      elements: parts.map(part => typeof part === "string"
        ? { startIndex: 0, endIndex: 0, textRun: { content: part, textStyle: {} } }
        : "person" in part
          ? { startIndex: 0, endIndex: 0, person: { personProperties: { name: part.person } } }
          : "date" in part
            ? { startIndex: 0, endIndex: 0, dateElement: { dateElementProperties: { displayText: part.date } } }
            // An element the text leaves out, as Google's dropdown, which no type here declares.
            : { startIndex: 0, endIndex: 0, dropdown: {} } as ParagraphElement),
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

/** Gives every element its index as Google would: a run its length, a chip one, a table and cell one. */
function numbered(content: StructuralElement[], from: number): number {
  let at = from;
  for (let element of content) {
    element.startIndex = at;
    if (element.paragraph) {
      for (let part of element.paragraph.elements) {
        part.startIndex = at;
        at += part.textRun ? part.textRun.content.length : 1;
        part.endIndex = at;
      }
    } else if (element.table) {
      at++;
      for (let row of element.table.tableRows ?? []) {
        at++;
        for (let cell of row.tableCells ?? []) at = numbered(cell.content ?? [], at + 1);
      }
    }
    element.endIndex = at;
  }
  return at;
}

function tab(tabId: string, content: StructuralElement[], extra: Partial<GoogleDocsTab> = {}): GoogleDocsTab {
  numbered(content, 1);
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
  it("returns the range the quote takes in its tab", () => {
    // Index 1 is where the body's text starts.
    expect(locateQuote(tab("t.0", [paragraph(["The budget is final.\n"])]), "budget"))
      .toEqual({ startIndex: 5, endIndex: 11, tabId: "t.0" });
  });

  it("counts every paragraph before it, headings included", () => {
    let content = [paragraph(["Plan\n"], "h.title"), paragraph(["The budget is final.\n"])];
    expect(locateQuote(tab("t.1", content), "budget is final"))
      .toEqual({ startIndex: 10, endIndex: 25, tabId: "t.1" });
  });

  it("matches across text runs", () => {
    let content = [paragraph(["The bud", "get is ", "final.\n"])];
    expect(locateQuote(tab("t.0", content), "budget is final"))
      .toEqual({ startIndex: 5, endIndex: 20, tabId: "t.0" });
  });

  it("finds text inside table cells, nested tables included, at its index there", () => {
    let content = [table([[[paragraph(["Q1\n"])], [table([[[paragraph(["Revenue 42\n"])]]])]]])];
    let found = tab("t.0", content);
    let range = locateQuote(found, "Revenue 42");
    let inner = content[0].table!.tableRows![0].tableCells![1].content![0].table!
      .tableRows![0].tableCells![0].content![0];
    expect(range).toEqual({ startIndex: inner.startIndex, endIndex: inner.startIndex + 10, tabId: "t.0" });
  });

  it("trims the quote but compares the rest exactly", () => {
    let content = [paragraph(["Caf\u00e9  budget\n"])];
    expect(locateQuote(tab("t.0", content), "  Caf\u00e9  budget \n"))
      .toEqual({ startIndex: 1, endIndex: 13, tabId: "t.0" });
    // A decomposed e with an accent against the document's composed one, and one space for two,
    // are not the same text.
    expect(() => locateQuote(tab("t.0", content), "Cafe\u0301  budget")).toThrow("not found");
    expect(() => locateQuote(tab("t.0", content), "Caf\u00e9 budget")).toThrow("not found");
  });

  it("counts UTF-16 code units, as Docs indices do", () => {
    let content = [paragraph(["\u{1F600} smile\n"])];
    expect(locateQuote(tab("t.0", content), "smile")).toEqual({ startIndex: 4, endIndex: 9, tabId: "t.0" });
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

  it("reads chips as the Markdown shows them, and takes a chip quoted in part whole", () => {
    let content = [paragraph(["Ask ", { person: "Alice" }, " by ", { date: "Oct 21, 2026" }, "\n"])];
    let found = tab("t.0", content);
    // "Ask " is 1..5, the person chip 5..6, " by " 6..10, the date chip 10..11.
    expect(locateQuote(found, "Ask Alice by Oct 21, 2026")).toEqual({ startIndex: 1, endIndex: 11, tabId: "t.0" });
    expect(locateQuote(found, "lice by")).toEqual({ startIndex: 5, endIndex: 9, tabId: "t.0" });
    // Text a suggestion replaces may take a chip only whole: deleting it whole would replace more
    // than was asked.
    expect(locateQuote(found, "Ask Alice by", { wholeChips: true }))
      .toEqual({ startIndex: 1, endIndex: 9, tabId: "t.0" });
    for (let part of ["lice by", "Ask Ali", "Alic"]) {
      expect(() => locateQuote(found, part, { wholeChips: true }), part)
        .toThrow("That text takes in part of a smart chip");
    }
  });

  // bonk: an element that reads as no text joins the text on its sides, and a replacement range
  // across it would delete it unseen.
  it("refuses a replacement across an element that reads as no text, which a comment may span", () => {
    // "Before " is 1..8, the dropdown 8..9, " after" 9..15.
    let found = tab("t.0", [paragraph(["Before ", { dropdown: true }, " after\n"])]);
    expect(() => locateQuote(found, "Before  after", { wholeChips: true }))
      .toThrow("That text runs across something in the Doc that reads as no text");
    expect(locateQuote(found, "Before  after")).toEqual({ startIndex: 1, endIndex: 15, tabId: "t.0" });
    expect(locateQuote(found, "Before", { wholeChips: true })).toEqual({ startIndex: 1, endIndex: 7, tabId: "t.0" });
    expect(locateQuote(found, "after", { wholeChips: true })).toEqual({ startIndex: 10, endIndex: 15, tabId: "t.0" });
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

  it("skips malformed elements", () => {
    let content = [
      { startIndex: 1, endIndex: 2, paragraph: { elements: [{ person: {} }, null, { textRun: { content: 7 } }] } },
      { startIndex: 2, endIndex: 8, paragraph: { elements: [
        { startIndex: 2, endIndex: 8, textRun: { content: "Total\n", textStyle: {} } }] } },
    ] as unknown as StructuralElement[];
    let raw: GoogleDocsTab = { tabId: "t.0", title: "t.0", index: 0, nestingLevel: 0, lists: {},
      namedRanges: {}, body: { content } };
    expect(locateQuote(raw, "Total")).toEqual({ startIndex: 2, endIndex: 7, tabId: "t.0" });
  });
});

describe("composeComment", () => {
  it("is the trimmed text", () => {
    expect(composeComment("  Looks good.\n")).toBe("Looks good.");
  });

  it("keeps the text's inner whitespace and characters exactly", () => {
    let text = "line1\r\nline2   \n\ttabbed e\u0301 \u00e9 \u{1F600} \u200d \u00a0end";
    expect(composeComment(text)).toBe(text);
  });

  it("refuses empty or whitespace-only text", () => {
    expect(() => composeComment("")).toThrow("The comment is empty.");
    expect(() => composeComment(" \n\t", true)).toThrow("The comment is empty.");
  });

  it("allows exactly Drive's limit in UTF-8 bytes and refuses one byte more", () => {
    expect(composeComment("a".repeat(MAX_COMMENT_BYTES))).toHaveLength(MAX_COMMENT_BYTES);
    expect(composeComment("\u00e9".repeat(2048))).toHaveLength(2048);
    expect(() => composeComment("a".repeat(MAX_COMMENT_BYTES + 1)))
      .toThrow("The comment is 4097 bytes of UTF-8; Google Drive allows at most 4096.");
    expect(() => composeComment("\u00e9".repeat(2049)))
      .toThrow("The comment is 4098 bytes of UTF-8; Google Drive allows at most 4096.");
  });

  it("holds a comment attached through Docs to the Docs limit, as Google counts it", () => {
    // Probed: 2048 ASCII and 1024 two-byte characters pass; 2049 and 1025 are refused.
    expect(composeComment("a".repeat(MAX_DOCS_COMMENT_BYTES), true)).toHaveLength(2048);
    expect(composeComment("\u00e9".repeat(1024), true)).toHaveLength(1024);
    expect(() => composeComment("a".repeat(2049), true))
      .toThrow("The comment is 2049 bytes of UTF-8; Google Docs allows at most 2048 on a comment " +
        "that quotes a Doc or a suggestion's note.");
    expect(() => composeComment("\u00e9".repeat(1025), true)).toThrow("The comment is 2050 bytes");
  });
});

describe("requireQuote", () => {
  it("trims, and caps the quote in characters, not bytes", () => {
    expect(requireQuote(" the budget ")).toBe("the budget");
    expect(requireQuote("\u00e9".repeat(MAX_QUOTE_CHARS))).toBe("\u00e9".repeat(MAX_QUOTE_CHARS));
    expect(() => requireQuote("x".repeat(MAX_QUOTE_CHARS + 1)))
      .toThrow(`The quote is ${MAX_QUOTE_CHARS + 1} characters; at most ${MAX_QUOTE_CHARS} can be quoted.`);
    expect(() => requireQuote("  ")).toThrow("The quote is empty.");
  });
});

describe("checkSuggestion", () => {
  it("trims the old text and the note, and keeps the new text exactly as given", () => {
    expect(checkSuggestion(" 2025 ", " 2026 ", " The year moved. "))
      .toEqual({ oldText: "2025", newText: " 2026 ", note: "The year moved." });
    expect(checkSuggestion("very very", "")).toEqual({ oldText: "very very", newText: "" });
  });

  it("refuses a replacement identical to the old text", () => {
    expect(() => checkSuggestion("same", "same"))
      .toThrow("The replacement is the same as the text it replaces.");
  });

  it("refuses empty old text, an empty note, and old text over the quote cap", () => {
    expect(() => checkSuggestion(" ", "x")).toThrow("The text to replace is empty.");
    expect(() => checkSuggestion("a", "b", "  ")).toThrow("The note is empty.");
    expect(() => checkSuggestion("x".repeat(MAX_QUOTE_CHARS + 1), "y"))
      .toThrow(`The text to replace is ${MAX_QUOTE_CHARS + 1} characters`);
  });

  it("keeps the old and the new text within one paragraph", () => {
    expect(() => checkSuggestion("a\nb", "c")).toThrow("The text to replace must sit within one paragraph.");
    for (let newText of ["c\nd", "c\rd", "c\u000bd"]) {
      expect(() => checkSuggestion("a", newText))
        .toThrow("The replacement must be one paragraph, without line breaks.");
    }
  });

  it("refuses a replacement with a character Google Docs would drop, and keeps a tab", () => {
    for (let [newText, code] of [["a\u0000b", "0000"], ["\u001fx", "001F"], ["x", "E000"]]) {
      expect(() => checkSuggestion("a", newText))
        .toThrow(`The replacement contains a character Google Docs drops from inserted text (U+${code}).`);
    }
    expect(checkSuggestion("a", "b\tc").newText).toBe("b\tc");
  });

  it("caps the new text in characters and the note at the Docs limit", () => {
    expect(checkSuggestion("a", "\u00e9".repeat(MAX_REPLACEMENT_CHARS)).newText).toHaveLength(MAX_REPLACEMENT_CHARS);
    expect(() => checkSuggestion("a", "b".repeat(MAX_REPLACEMENT_CHARS + 1)))
      .toThrow(`The replacement is ${MAX_REPLACEMENT_CHARS + 1} characters; at most ${MAX_REPLACEMENT_CHARS} can be suggested.`);
    expect(checkSuggestion("a", "b", "n".repeat(MAX_DOCS_COMMENT_BYTES)).note).toHaveLength(2048);
    expect(() => checkSuggestion("a", "b", "n".repeat(MAX_DOCS_COMMENT_BYTES + 1)))
      .toThrow("The note is 2049 bytes of UTF-8; Google Docs allows at most 2048");
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
