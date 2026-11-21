import { describe, expect, it } from "vitest";
import type {
  GoogleDocsDocument, GoogleDocsTab, ParagraphElement, StructuralElement,
} from "../src/docs-api";
import type { DocCopy } from "../src/docs-copy";
import type { DocVersion } from "../src/docs-store";
import {
  checkSuggestion, composeComment, composeReply, composeResolve,
  locateQuoteInFetched, locateQuoteInRuns, requireQuote, savedDoc, selectTab,
} from "../src/drive-comment-body";
import {
  MAX_COMMENT_BYTES, MAX_DOCS_COMMENT_BYTES, MAX_QUOTE_CHARS, MAX_REPLACEMENT_CHARS,
} from "../src/drive-api";
import { diceOf } from "./doc-fixture";
import { readFixtures } from "./docs-live-fixtures";
import {
  drawnQuotes, locateQuote, locateQuoteWhole, outcome, QUOTED_TABS,
} from "./locate-quote-whole";
import { WIDER } from "./wider-run";

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

/**
 * The ways a body is handed as items: cut in two at each boundary between two of its elements,
 * and then an element an item.
 */
function* handed(content: readonly StructuralElement[]): Generator<StructuralElement[][]> {
  for (let at = 1; at < content.length; at++) yield [content.slice(0, at), content.slice(at)];
  yield content.map(element => [element]);
}

/** Every tab of every recording of Google's own answers. */
const RECORDED: GoogleDocsTab[] =
  readFixtures().flatMap(({ before, steps }) => [before, ...steps.map(step => step.after)]);

/** How many rounds of quotes are drawn from each tab: more in the wider run. */
const QUOTE_DRAWS = WIDER ? 120 : 16;

describe("locateQuoteInRuns", () => {
  it("finds a quote the same handed a tab whole and handed its runs", () => {
    let compared = 0, found = 0;
    let refusals = new Set<string>();
    let tabs = [...QUOTED_TABS, ...RECORDED.map(recorded => ({ tab: recorded, quotes: [] }))];
    for (let [index, { tab: searched, quotes }] of tabs.entries()) {
      let sample = new Set([...quotes, ...drawnQuotes(searched, diceOf(7_919 + index), QUOTE_DRAWS)]);
      for (let quote of sample) {
        for (let wholeChips of [false, true]) {
          let whole = outcome(() => locateQuoteWhole(searched, quote, { wholeChips }));
          // A refusal by its first words: the count and the tab's id are left out.
          if (typeof whole === "string") refusals.add(whole.split(" ").slice(0, 3).join(" "));
          else found++;
          let expected = JSON.stringify(whole);
          for (let items of handed(searched.body.content)) {
            let byRuns = outcome(() => locateQuoteInRuns(searched.tabId, items, quote, { wholeChips }));
            // Compared as text first: an assertion a search would be most of the test's time.
            if (JSON.stringify(byRuns) !== expected) {
              expect(byRuns, `${JSON.stringify(quote)} in tab ${index}, wholeChips ${wholeChips}, ` +
                `handed as items of ${items.map(item => item.length).join(", ")} elements`)
                .toEqual(whole);
            }
            compared++;
          }
        }
      }
    }

    // What the sample reached: quotes that are found, and every refusal the search has but
    // that of a quote with a line break, which reads no text.
    expect(compared).toBeGreaterThan(WIDER ? 200_000 : 60_000);
    expect(found).toBeGreaterThan(WIDER ? 15_000 : 4_000);
    expect([...refusals].toSorted()).toEqual([
      "That text appears", "That text runs", "That text takes", "That text was", "The quote is",
    ]);
  });

  it("finds a place that spans two items once, and counts overlapping places each", () => {
    let content = [paragraph(["The bud"]), paragraph(["get is "]), paragraph(["final.\n"]), paragraph(["aa"]),
      paragraph(["a"]), paragraph(["a\n"])];
    let found = tab("t.0", content);
    let items = found.body.content.map(element => [element]);

    // "The bud" is 1..8, "get is " 8..15 and "final." 15..21: the place takes in three items.
    expect(locateQuoteInRuns("t.0", items, "budget is final"))
      .toEqual({ startIndex: 5, endIndex: 20, tabId: "t.0" });
    expect(locateQuoteInRuns("t.0", items, "dg")).toEqual({ startIndex: 7, endIndex: 9, tabId: "t.0" });
    // "aaaa" over three items holds "aa" at three places and "aaa" at two.
    expect(() => locateQuoteInRuns("t.0", items, "aa")).toThrow("That text appears 3 times");
    expect(() => locateQuoteInRuns("t.0", items, "aaa")).toThrow("That text appears 2 times");
    expect(locateQuoteInRuns("t.0", items, "aaaa")).toEqual({ startIndex: 22, endIndex: 26, tabId: "t.0" });
  });

  it("reads no item for a quote refused on its own text", () => {
    let unread: Iterable<readonly unknown[]> = {
      [Symbol.iterator]: () => { throw new Error("The tab's runs were read."); },
    };

    expect(() => locateQuoteInRuns("t.0", unread, "  ")).toThrow("The quote is empty.");
    expect(() => locateQuoteInRuns("t.0", unread, "one\ntwo")).toThrow("A quote must sit within one paragraph");
    expect(() => locateQuoteInRuns("t.0", unread, "one")).toThrow("The tab's runs were read.");
  });

  it("reads every item even after a second place is found", () => {
    let found = tab("t.0", Array.from({ length: 6 }, () => paragraph(["a cat\n"])));
    let read = 0;
    let items = (function* () {
      for (let element of found.body.content) {
        read++;
        yield [element];
      }
    })();

    expect(() => locateQuoteInRuns("t.0", items, "a cat")).toThrow("That text appears 6 times");
    // The section break and the six paragraphs.
    expect(read).toBe(7);
  });

  it("places a quote across text runs of no text, however many follow one another", () => {
    let empty = Array.from({ length: 5_000 }, () => "");
    let found = tab("t.0", [paragraph(["ab", ...empty]), paragraph([...empty, "cd\n"])]);
    let items = found.body.content.map(element => [element]);

    expect(locateQuoteInRuns("t.0", items, "bc", { wholeChips: true }))
      .toEqual({ startIndex: 2, endIndex: 4, tabId: "t.0" });
    expect(locateQuoteInRuns("t.0", items, "bc")).toEqual(locateQuoteWhole(found, "bc"));
  });
});

/** `value` with a field no reader asks for added to every object under it, at every depth. */
function dressed<T>(value: T): T {
  if (Array.isArray(value)) for (let item of value) dressed(item);
  else if (value && typeof value === "object") {
    for (let inner of Object.values(value)) dressed(inner);
    (value as { zzUnread?: unknown }).zzUnread = { deep: [1] };
  }
  return value;
}

/** A tab that stands beside the one searched and holds every quote of the hand-built tabs. */
const beside = (tabId: string): GoogleDocsTab => tab(tabId, [
  paragraph(["Ask Alice by a cat aa pq The budget is final, joinedtext.\n"]),
]);

/** Two tabs of a paragraph each: "First." in `t.0` and "Second." in `t.1`. */
const twoTabs = () => [tab("t.0", [paragraph(["First.\n"])]), tab("t.1", [paragraph(["Second.\n"])])];

/** A tab of two paragraphs: "The budget is final." and "The end.". */
const read = () => tab("t.0", [paragraph(["The budget is final.\n"]), paragraph(["The end.\n"])]);

describe("locateQuoteInFetched", () => {
  it("finds a quote in a fetched document the same as in its tab whole", () => {
    let compared = 0, found = 0;
    let refusals = new Set<string>();
    let tabs = [...QUOTED_TABS, ...RECORDED.map(recorded => ({ tab: recorded, quotes: [] }))];
    for (let [index, { tab: recorded, quotes }] of tabs.entries()) {
      // The tab as Google sends it, with more than the copy keeps, between two other tabs.
      let searched = structuredClone(recorded);
      dressed(searched.body.content);
      let answer = JSON.stringify(document([beside("t.before"), searched, beside("t.after")]));
      let sample = new Set([...quotes, ...drawnQuotes(searched, diceOf(7_919 + index), QUOTE_DRAWS)]);
      for (let quote of sample) {
        for (let wholeChips of [false, true]) {
          let whole = outcome(() => locateQuoteWhole(searched, quote, { wholeChips }));
          if (typeof whole === "string") refusals.add(whole.split(" ").slice(0, 3).join(" "));
          else found++;
          // A parse of its own each time, as a fetch answers: the search empties it.
          let fetched = outcome(() =>
            locateQuoteInFetched(JSON.parse(answer), searched.tabId, quote, { wholeChips }));
          if (JSON.stringify(fetched) !== JSON.stringify(whole)) {
            expect(fetched, `${JSON.stringify(quote)} in tab ${index}, wholeChips ${wholeChips}`)
              .toEqual(whole);
          }
          compared++;
        }
      }
    }

    expect(compared).toBeGreaterThan(WIDER ? 30_000 : 10_000);
    expect(found).toBeGreaterThan(WIDER ? 15_000 : 4_000);
    expect([...refusals].toSorted()).toEqual([
      "That text appears", "That text runs", "That text takes", "That text was", "The quote is",
    ]);
  });

  it("takes the document over", () => {
    let content = [paragraph(["The budget is final.\n"]), paragraph(["The end.\n"])];
    let doc = document([tab("t.0", [paragraph(["First.\n"])]), tab("t.1", content), tab("t.2", [])]);
    let searched = doc.tabs[1];

    expect(locateQuoteInFetched(doc, "t.1", "budget"))
      .toEqual({ startIndex: 5, endIndex: 11, tabId: "t.1" });
    // The search left the one tab in the list and took each element out of its body.
    expect(doc.tabs).toEqual([searched]);
    expect(searched.body.content).toEqual([undefined, undefined, undefined]);
  });

  it("names every tab in the refusal of a tab the document lacks", () => {
    let doc = document(twoTabs());
    let whole = structuredClone(doc);

    expect(() => locateQuoteInFetched(doc, "t.9", "First"))
      .toThrow('This document has no tab "t.9". Its tabs are: t.0, t.1.');
    expect(doc).toEqual(whole);
  });

  it("reads the first tab when none is named", () => {
    expect(locateQuoteInFetched(document(twoTabs()), undefined, "First"))
      .toEqual({ startIndex: 1, endIndex: 6, tabId: "t.0" });
    expect(() => locateQuoteInFetched(document(twoTabs()), undefined, "Second"))
      .toThrow("That text was not found in tab t.0.");
  });

  it("reads nothing of the tab for a quote refused on its own text", () => {
    let doc = document([tab("t.0", [paragraph(["First.\n"])])]);
    let [first] = doc.tabs;

    expect(() => locateQuoteInFetched(doc, undefined, "one\ntwo"))
      .toThrow("A quote must sit within one paragraph");
    expect(doc.tabs).toEqual([first]);
    expect(first.body.content).toHaveLength(2);
    expect(first.body.content).not.toContain(undefined);
  });

  it("searches a tab as Google sent it, whatever a stored copy would refuse of it", () => {
    // A paragraph with no style is one the copy's pruning refuses: the search reads its text.
    let torn = read();
    delete (torn.body.content.at(-1)!.paragraph as { paragraphStyle?: unknown }).paragraphStyle;
    expect(locateQuoteInFetched(document([structuredClone(torn)]), undefined, "budget"))
      .toEqual({ startIndex: 5, endIndex: 11, tabId: "t.0" });
    expect(locateQuoteInFetched(document([structuredClone(torn)]), undefined, "end"))
      .toMatchObject({ tabId: "t.0" });
    // Named ranges the copy refuses are not read at all.
    let ranged = { ...read(), namedRanges: { marks: 7 } } as unknown as GoogleDocsTab;
    expect(locateQuoteInFetched(document([ranged]), undefined, "budget"))
      .toEqual({ startIndex: 5, endIndex: 11, tabId: "t.0" });

    // The search's own refusals are plain errors with their messages.
    expect(() => locateQuoteInFetched(document([read()]), undefined, "Goodbye"))
      .toThrow("That text was not found in tab t.0.");
    expect(() => locateQuoteInFetched(document([read()]), undefined, "The"))
      .toThrow("That text appears 2 times; quote more of it so it is unique.");
  });
});

/** A copy of the outline `tabs` whose every tab reads as `items`, with what was asked of it. */
function copyOf(tabs: string[], items: readonly StructuralElement[][]) {
  let asked: string[] = [];
  let copy = {
    outline: tabs.map((tabId, index) => ({ tabId, title: tabId, index, nestingLevel: 0 })),
    tab: (tabId: string) => (asked.push(`tab ${tabId}`), { tabId } as DocVersion),
    runs: (version: DocVersion) => (asked.push(`runs ${version.tabId}`), items),
  } as unknown as DocCopy;
  return { copy, asked };
}

describe("savedDoc", () => {
  it("lists the copy's outline and finds a quote in the runs of the tab named", () => {
    let found = tab("t.1", [paragraph(["The budget is final.\n"])]);
    let { copy, asked } = copyOf(["t.0", "t.1"], found.body.content.map(element => [element]));
    let saved = savedDoc(copy);

    expect(saved.tabs).toBe(copy.outline);
    expect(saved.locate("t.1", "budget", { wholeChips: true }))
      .toEqual({ startIndex: 5, endIndex: 11, tabId: "t.1" });
    expect(asked).toEqual(["tab t.1", "runs t.1"]);
    expect(() => saved.locate("t.1", "Goodbye")).toThrow("That text was not found in tab t.1.");
  });

  it("refuses a tab the outline does not list as selectTab does, and reads nothing", () => {
    let { copy, asked } = copyOf(["t.0", "t.1"], []);

    expect(() => savedDoc(copy).locate("t.9", "budget"))
      .toThrow('This document has no tab "t.9". Its tabs are: t.0, t.1.');
    expect(asked).toEqual([]);
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
