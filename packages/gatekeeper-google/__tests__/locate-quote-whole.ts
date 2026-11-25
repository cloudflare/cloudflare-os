// THE WHOLE-TAB SEARCH `locateQuoteInRuns` is held to (sharing only the renderer's reading of an
// element), the tabs and quotes they are compared over, and `locateQuote` over a tab in hand.

import type { DocsRange, GoogleDocsTab, ParagraphElement } from "../src/docs-api";
import { locateQuoteInRuns } from "../src/drive-comment-body";
import { paragraphElementText } from "../src/markdown-converter";
import { buildTab, cellOf, footnote, grid, type Dice } from "./doc-fixture";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One piece of a tab's text and where it sits in the tab: a text run, whose characters are its
 * indices one for one, or a chip, which reads as more text than the one index it takes.
 */
type Piece = { at: number; length: number; startIndex: number; endIndex: number; run: boolean };

/**
 * A tab's text as its Markdown shows it, unformatted, in document order (cells included), with
 * where each piece sits. Elements arrive unvalidated, so they are read defensively.
 */
function tabTextWhole(tab: GoogleDocsTab): { text: string; pieces: Piece[] } {
  let chunks: string[] = [];
  let length = 0;
  let pieces: Piece[] = [];
  let visit = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (let element of content) {
      if (!isRecord(element)) continue;
      let { paragraph, table } = element;
      if (isRecord(paragraph)) {
        for (let part of Array.isArray(paragraph.elements) ? paragraph.elements : []) {
          if (!isRecord(part)) continue;
          // Chips read as the Markdown the agent was shown renders them.
          let text = paragraphElementText(part as ParagraphElement);
          let { startIndex, endIndex } = part;
          if (typeof text !== "string" || typeof startIndex !== "number" ||
              typeof endIndex !== "number") continue;
          pieces.push({
            at: length, length: text.length, startIndex, endIndex, run: isRecord(part.textRun),
          });
          chunks.push(text);
          length += text.length;
        }
      } else if (isRecord(table) && Array.isArray(table.tableRows)) {
        for (let row of table.tableRows) {
          if (!isRecord(row) || !Array.isArray(row.tableCells)) continue;
          for (let cell of row.tableCells) if (isRecord(cell)) visit(cell.content);
        }
      }
    }
  };
  visit(tab.body.content);
  return { text: chunks.join(""), pieces };
}

/** The refusal for replacing part of a chip, which takes one index however long its text reads. */
const PARTIAL_CHIP = "That text takes in part of a smart chip (a person, date or link), which " +
  "can only be replaced whole. Include all of the chip's text, or none of it.";

/** The refusal for replacing text on both sides of an element that reads as no text. */
const SPANS_HIDDEN = "That text runs across something in the Doc that reads as no text, such " +
  "as a dropdown or a horizontal line, which the suggestion would delete too. Quote the text on " +
  "one side of it.";

/**
 * The tab index of text offset `offset`, as the start (or, `end`, the exclusive end) of a range.
 * A chip the offset falls inside is taken whole, or, with `wholeChips`, refused.
 */
function indexAt(pieces: Piece[], offset: number, end: boolean, wholeChips: boolean): number {
  let piece = pieces.find(candidate => end
    ? offset > candidate.at && offset <= candidate.at + candidate.length
    : offset >= candidate.at && offset < candidate.at + candidate.length);
  if (!piece) throw new Error("That text could not be placed in the document.");
  if (!piece.run) {
    let inside = end ? offset < piece.at + piece.length : offset > piece.at;
    if (inside && wholeChips) throw new Error(PARTIAL_CHIP);
    return end ? piece.endIndex : piece.startIndex;
  }
  return piece.startIndex + offset - piece.at;
}

/**
 * The range in `tab` of `quote`, trimmed, which must occur exactly once (nothing normalized). A
 * chip partly quoted is taken whole; with `wholeChips` it is refused, as is a quote across an
 * element the text leaves out.
 */
export function locateQuoteWhole(
  tab: GoogleDocsTab, quote: string, { wholeChips = false }: { wholeChips?: boolean } = {},
): DocsRange {
  let needle = quote.trim();
  if (!needle) throw new Error("The quote is empty.");
  // The Markdown the agent read separates paragraphs differently from the Doc's own text.
  if (/[\n\v]/.test(needle)) {
    throw new Error("A quote must sit within one paragraph; quote part of one paragraph instead.");
  }
  let { text, pieces } = tabTextWhole(tab);
  let first = text.indexOf(needle);
  if (first < 0) {
    throw new Error(`That text was not found in tab ${tab.tabId}. Quote it as written, without ` +
      "Markdown or HTML formatting, and pass tabId if it is in another tab.");
  }
  let count = 0;
  for (let at = first; at >= 0; at = text.indexOf(needle, at + 1)) count++;
  if (count > 1) {
    throw new Error(`That text appears ${count} times; quote more of it so it is unique.`);
  }
  if (wholeChips) {
    let end = first + needle.length;
    let inside = pieces.filter(piece => piece.at < end && piece.at + piece.length > first);
    if (inside.some((piece, i) => i > 0 && inside[i - 1].endIndex !== piece.startIndex)) {
      throw new Error(SPANS_HIDDEN);
    }
  }
  return {
    startIndex: indexAt(pieces, first, false, wholeChips),
    endIndex: indexAt(pieces, first + needle.length, true, wholeChips),
    tabId: tab.tabId,
  };
}

/** The source's `locateQuoteInRuns` over the body of `tab` as one item, for a tab in hand. */
export function locateQuote(
  tab: GoogleDocsTab, quote: string, options: { wholeChips?: boolean } = {},
): DocsRange {
  return locateQuoteInRuns(tab.tabId, [tab.body.content], quote, options);
}

// --- What the two searches are compared over

/** What a search answers: the range, or the message of its refusal. */
export function outcome(search: () => DocsRange): DocsRange | string {
  try {
    return search();
  } catch (thrown) {
    return (thrown as Error).message;
  }
}

/** `quote` without what stands past its first line break, which no quote may hold. */
const withinLine = (quote: string) => quote.split(/[\n\v]/)[0];

/**
 * `draws` rounds of quotes drawn from the text of `tab`: within an element, across two, any stretch,
 * one or two characters (most repeat), and text the tab does not hold.
 */
export function drawnQuotes(tab: GoogleDocsTab, dice: Dice, draws: number): string[] {
  let { text, pieces } = tabTextWhole(tab);
  let worded = pieces.filter(piece => piece.length > 0);
  if (worded.length === 0) return ["absent"];
  let quotes: string[] = [];
  for (let draw = 0; draw < draws; draw++) {
    let piece = dice.pick(worded);
    let from = piece.at + dice.below(piece.length);
    quotes.push(text.slice(from, from + 1 + dice.below(piece.at + piece.length - from)));
    let seam = dice.pick(worded).at;
    quotes.push(text.slice(Math.max(0, seam - 1 - dice.below(3)), seam + 1 + dice.below(3)));
    let start = dice.below(text.length);
    quotes.push(text.slice(start, start + 2 + dice.below(24)));
    quotes.push(text.slice(start, start + 1 + dice.below(2)));
    quotes.push(`${text.slice(start, start + 3)}☃`);
  }
  return quotes.map(withinLine);
}

/** `tab` with `change` made to the paragraph elements of its `at`-th body element. */
function withElements(
  tab: GoogleDocsTab, at: number, change: (elements: ParagraphElement[]) => void,
): GoogleDocsTab {
  change(tab.body.content[at].paragraph!.elements);
  return tab;
}

/** `tab` with each empty text run from body element `from` on given one index, later ones moved up. */
function withIndexedEmpties(tab: GoogleDocsTab, from: number): GoogleDocsTab {
  let moved = 0;
  for (let element of tab.body.content.slice(from)) {
    element.startIndex += moved;
    for (let part of element.paragraph!.elements) {
      part.startIndex += moved;
      if (part.textRun?.content === "") moved++;
      part.endIndex += moved;
    }
    element.endIndex += moved;
  }
  return tab;
}

const ALICE = { person: { name: "Alice", email: "alice@example.com" } };

/** Hand-built tabs, each with the quotes that reach what it was built for. */
export const QUOTED_TABS: { tab: GoogleDocsTab; quotes: string[] }[] = [
  {
    // Chips, an element that reads as no text, a table with a table in a cell, and text that
    // occurs twice and twice overlapping.
    tab: buildTab([
      { runs: ["Ask ", ALICE, " by ", { date: "Oct 21, 2026" }, " or read ",
        { richLink: { title: "The plan", uri: "https://example.com/plan" } }, "\n"] },
      { runs: ["Before ", { dropdown: "Open" }, " after\n"] },
      { table: [["Q1\n", cellOf(grid(["Revenue 42"]), { runs: ["\n"] })], ["a cat, a cat\n", "aaa\n"]] },
      { runs: ["Total ", footnote(1), " and a cat\n"] },
    ]),
    quotes: [
      "Ask Alice by", "lice by Oct", "Oct 21, 2026 or read The plan", "The pl", "Before  after",
      "Before", "after", "Revenue 42", "a cat", "aa", "aaa", "Total [1] and", "[1", "nowhere",
    ],
  },
  {
    // Paragraphs with no line break, so two texts join: across elements, across an empty-reading
    // paragraph, and where the joined text repeats.
    tab: buildTab([
      { runs: ["joined"] }, { runs: ["text\n"] },
      { runs: ["abc"] }, { runs: [{ dropdown: "Open" }] }, { runs: ["def"] },
      { runs: [{ horizontalRule: true }] }, { runs: ["abcdef\n"] },
      { runs: ["aa"] }, { runs: ["a"] }, { runs: ["a\n"] },
      { runs: ["Ask ", ALICE] }, { runs: [ALICE, " twice\n"] },
    ]),
    quotes: [
      "joinedtext", "dt", "edte", "abcdef", "cd", "fabc", "bcdefa", "aa", "aaa", "aaaa", "aaaaa",
      "Ask AliceAlice twice", "liceAli", "k AliceAl", "eAlice",
    ],
  },
  {
    // Empty text runs: of no index, meeting and (around "m") not; and of one index each, meeting,
    // inside "abcd" and between "hi" and "jk".
    tab: withIndexedEmpties(withElements(buildTab([
      { runs: ["p"] }, { runs: [""] }, { runs: ["", ""] }, { runs: ["q\n"] },
      { runs: ["x", "", "", "y\n"] },
      { runs: ["m", "", "", "n\n"] },
      { runs: ["abcd", "", "", "efg\n"] },
      { runs: ["hi"] }, { runs: [""] }, { runs: ["", ""] }, { runs: ["jk\n"] },
    ]), 6, elements => {
      elements[2].startIndex = 99;
    }), 7),
    quotes: ["pq", "p", "q", "xy", "mn", "m", "n", "de", "abcdefg", "ij", "hijk"],
  },
  {
    // Text runs that carry suggestion ids, as the view with suggestions inline sends them.
    tab: withElements(buildTab([
      { runs: ["The ", "old", "new", " budget is final.\n"] }, { runs: ["The end.\n"] },
    ]), 1, elements => {
      Object.assign(elements[1].textRun!, { suggestedDeletionIds: ["suggest.1"] });
      Object.assign(elements[2].textRun!, { suggestedInsertionIds: ["suggest.2"] });
    }),
    quotes: ["The oldnew budget", "oldnew", "old", "new budget", "The "],
  },
];
