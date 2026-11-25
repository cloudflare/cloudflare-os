import { describe, expect, it } from "vitest";
import type { GoogleDocsTab, ParagraphElement, StructuralElement } from "../src/docs-api";
import {
  CHIP_PLACEHOLDER, isGoogleDocsStrippedCharacter, loneChipCopy, wholeFootnoteNumber,
} from "../src/docs-content";
import { docTabToMarkdown } from "../src/markdown-converter";
import { buildTab } from "./doc-fixture";
import type { ParagraphSpec } from "./doc-fixture";

type Copy = ReturnType<typeof loneChipCopy>;

const PERSON = { person: { name: "Ana", email: "ana@example.com" } };
const DATE = { date: "Sep 16, 2026" };
const RICH_LINK = { richLink: { title: "Plan", uri: "https://docs.example/plan" } };
const DROPDOWN = { dropdown: "Open" };
const FOOTNOTE = { footnote: { id: "footnote-1", number: "1" } };

/** Turn the date chip of a paragraph into an inline image, which the fixture has no part for. */
function dateToImage(elements: ParagraphElement[]): void {
  let image = elements.find(element => element.dateElement);
  if (!image) throw new Error("Expected a date chip");
  delete image.dateElement;
  image.inlineObjectElement = { inlineObjectId: "image-1" };
}

/** A cell's paragraphs, what to change in the first of them, and what `loneChipCopy` says. */
type Case = [
  name: string, paragraphs: ParagraphSpec[], copy: Copy,
  adjust?: (elements: ParagraphElement[]) => void,
];

const CASES: Case[] = [
  // Not one paragraph, no chip, or text beside the chips.
  ["an empty cell", [{ runs: ["\n"] }], undefined],
  ["text alone", [{ runs: ["plain\n"] }], undefined],
  ["a chip among paragraphs", [{ runs: [DROPDOWN, "\n"] }, { runs: ["\n"] }], undefined],
  ["a chip in a second paragraph", [{ runs: ["\n"] }, { runs: [DATE, "\n"] }], undefined],
  ["a chip with text beside it", [{ runs: ["Owner ", PERSON, "\n"] }], undefined],
  ["a dropdown with text after it", [{ runs: [DROPDOWN, " now\n"] }], undefined],
  ["a placeholder with text beside it", [{ runs: [`${CHIP_PLACEHOLDER} x\n`] }], undefined],
  ["an inline image alone", [{ runs: [DATE, "\n"] }], undefined, dateToImage],
  // No element but text.
  ["a placeholder alone", [{ runs: [`${CHIP_PLACEHOLDER}\n`] }], "placeholder"],
  ["two placeholders", [{ runs: [`${CHIP_PLACEHOLDER}${CHIP_PLACEHOLDER}\n`] }], "unseen"],
  ["a placeholder after a space", [{ runs: [` ${CHIP_PLACEHOLDER}\n`] }], "unseen"],
  ["a placeholder with a space after it", [{ runs: [`${CHIP_PLACEHOLDER} \n`] }], "unseen"],
  // More than one element that is not text.
  ["two person chips", [{ runs: [PERSON, PERSON, "\n"] }], "nothing"],
  ["a person chip, a date chip and a rich link", [{ runs: [PERSON, DATE, RICH_LINK, "\n"] }], "nothing"],
  ["two person chips with a space between them", [{ runs: [PERSON, " ", PERSON, "\n"] }], "unseen"],
  ["a dropdown and a person chip", [{ runs: [DROPDOWN, PERSON, "\n"] }], "unseen"],
  ["a person chip and an inline image", [{ runs: [PERSON, DATE, "\n"] }], "unseen", dateToImage],
  // One element that is not text.
  ["a dropdown alone", [{ runs: [DROPDOWN, "\n"] }], "dropdown"],
  ["a dropdown with a space", [{ runs: [DROPDOWN, " \n"] }], "unseen"],
  ["a person chip alone", [{ runs: [PERSON, "\n"] }], "placeholder"],
  ["a date chip alone", [{ runs: [DATE, "\n"] }], "placeholder"],
  ["a rich link alone", [{ runs: [RICH_LINK, "\n"] }], "placeholder"],
  ["a person chip with spaces after it", [{ runs: [PERSON, "  \n"] }], "placeholder"],
  ["a chip after spaces", [{ runs: [" ", PERSON, "\n"] }], "unseen"],
  ["a person chip and a placeholder", [{ runs: [PERSON, `${CHIP_PLACEHOLDER}\n`] }], "unseen"],
  ["a footnote reference alone", [{ runs: [FOOTNOTE, "\n"] }], "unseen"],
];

/** A tab whose one table has the case's cell first, and the content of that cell. */
function tabOf([, paragraphs, , adjust]: Case): { tab: GoogleDocsTab; cell: StructuralElement[] } {
  let tab = buildTab([
    { runs: ["\n"] }, { table: [[{ paragraphs }, "plain\n"]] }, { runs: ["\n"] },
  ]);
  let cell = tab.body.content.find(element => element.table)
    ?.table?.tableRows?.[0]?.tableCells?.[0]?.content;
  if (!cell) throw new Error("Expected a table cell");
  let first = cell[0]?.paragraph;
  if (adjust && first) adjust(first.elements);
  return { tab, cell };
}

const stripped = (code: number) => isGoogleDocsStrippedCharacter(code);

describe("isGoogleDocsStrippedCharacter", () => {
  it("says which code units Google strips from inserted text", () => {
    // The control characters below the tab.
    expect([0x00, 0x08].map(stripped)).toEqual([true, true]);
    // The tab, the line break and the vertical tab are written.
    expect([0x09, 0x0a, 0x0b].map(stripped)).toEqual([false, false, false]);
    // The control characters from the form feed up to the space.
    expect([0x0c, 0x1f, 0x20].map(stripped)).toEqual([true, true, false]);
    // The private use area, which holds the chip placeholder.
    expect([0xdfff, 0xe000, 0xf8ff, 0xf900].map(stripped)).toEqual([false, true, true, false]);
    expect(stripped(CHIP_PLACEHOLDER.charCodeAt(0))).toBe(true);
    expect(["a", " ", "\u00e9", "\u00a0"].map(text => stripped(text.charCodeAt(0))))
      .toEqual([false, false, false, false]);
  });
});

describe("loneChipCopy", () => {
  it("says what a row added beside a cell copies of its chips", () => {
    let said = CASES.map((entry): [string, Copy] => [entry[0], loneChipCopy(tabOf(entry).cell)]);

    expect(said).toEqual(CASES.map(([name, , copy]): [string, Copy] => [name, copy]));
    // Every answer is reached by some case.
    expect(new Set(said.map(([, copy]) => copy))).toEqual(
      new Set([undefined, "dropdown", "placeholder", "nothing", "unseen"]));
    // Content that is not one paragraph has no answer, whatever it is.
    expect(loneChipCopy([])).toBeUndefined();
    expect(loneChipCopy(tabOf(["a table", [{ runs: ["\n"] }], undefined]).tab.body.content
      .filter(element => element.table))).toBeUndefined();
  });

  it("agrees with the table map", () => {
    for (let entry of CASES) {
      let { tab, cell } = tabOf(entry);
      let copy = loneChipCopy(cell);
      let mapped = docTabToMarkdown(tab).sourceMap.tables[0].rows[0].cells[0];

      expect([entry[0], mapped.loneChip]).toEqual([entry[0], copy !== undefined]);
      expect([entry[0], mapped.copies]).toEqual(
        [entry[0], copy === "unseen" ? undefined : copy]);
    }
  });
});

describe("wholeFootnoteNumber", () => {
  it("says which footnote numbers are whole numbers", () => {
    let whole: [string, number][] = [
      ["0", 0], ["1", 1], ["12", 12], ["-3", -3], ["999999999", 999_999_999],
      ["-999999999", -999_999_999],
    ];
    for (let [text, number] of whole) {
      expect([text, wholeFootnoteNumber(text)]).toEqual([text, number]);
      // The number written back is the text: an offset counted from it restores it exactly.
      expect(String(wholeFootnoteNumber(text))).toBe(text);
    }
    let others = [
      undefined, "", "x", "007", "-0", "+1", "1.5", "1e3", " 2", "2 ", "\u0661", "1234567890",
      "9007199254740993",
    ];
    for (let text of others) expect([text, wholeFootnoteNumber(text)]).toEqual([text, undefined]);
  });
});
