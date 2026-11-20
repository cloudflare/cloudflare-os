import { describe, expect, it } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab, Paragraph } from "../src/docs-api";
import { applyDocsRequests, NotModelledError } from "../src/docs-model";
import {
  DocEditRefusedError, docEditRequests, docEditResult, type DocEdit,
} from "../src/docs-replay";
import type { RunSizes } from "../src/docs-runs";
import { hiddenContent, tableIdentity } from "../src/docs-tables";
import type { TableChange } from "../src/docs-tables";
import {
  canonicalizeMarkdownForWrite, docTabToMarkdown, LIST_LEVEL_TOO_DEEP, POSITIONED_ITEM_BEFORE,
} from "../src/markdown-converter";
import type { DocTabSnapshot } from "../src/markdown-converter";
import { buildTab, diceOf, MODELS, presetLevels } from "./doc-fixture";
import type { BlockSpec, CellSpec, Dice, ParagraphSpec, TableSpec } from "./doc-fixture";
import { fakeDocStore } from "./doc-store-fake";
import { expectRendersByRuns } from "./render-run-tabs";

// What the request builders send never reaches a shape the model has no answer for. Random
// tabs are edited the way an approved action is: the batch is built by the production builder
// from the tab as it reads, and applied by the model under each of its options. A builder that
// throws has refused the edit, and the tab stands. The same run shows that no builder bullets
// a range that holds a list item, which is one of the shapes the model refuses to answer.

/** Lists made as the two presets make them, and lists of one level. */
const LISTS = (): GoogleDocsTab["lists"] => ({
  B9: { listProperties: { nestingLevels: presetLevels(false) } },
  N9: { listProperties: { nestingLevels: presetLevels(true) } },
  B1: { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } },
  N1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
});

const NAMED_STYLES: NonNullable<GoogleDocsTab["namedStyles"]> = {
  styles: [
    { namedStyleType: "NORMAL_TEXT", textStyle: { bold: false, italic: false, strikethrough: false } },
    { namedStyleType: "HEADING_2", textStyle: { bold: true } },
    { namedStyleType: "HEADING_6", textStyle: { italic: true } },
    { namedStyleType: "SUBTITLE", textStyle: { italic: false } },
  ],
};

/** The shared dice, and words no two of which are the same. */
type WordDice = Dice & { word: () => string };

function wordDiceOf(seed: number): WordDice {
  let shared = diceOf(seed);
  let words = 0;
  let word = () => `${["alpha", "beta", "gamma", "delta"][shared.below(4)]}${words++}`;
  return { ...shared, word };
}

/** The list a tail's items belong to, and how its items are written. */
type Tail = {
  marker: "- " | "1. ";
  /** The nesting level of `b`, the item that anchors a positioned object. */
  level: 1 | 2;
  /** Whether an item `c` at `b`'s level follows it. */
  hasC: boolean;
};

const B_ANCHOR = "kix.anchor-b";

/**
 * A tab that mixes what the builders read and write around. One in five ends in a tail: an
 * optional item `itemA`, an item `itemB` one or two levels deep that anchors a positioned
 * object, and half the time an item `itemC` at its level, all of one list a preset made.
 */
function randomTab(dice: WordDice): { tab: GoogleDocsTab; tail?: Tail } {
  let { below, pick, word } = dice;
  let line = (text: string): ParagraphSpec => ({ runs: [`${text}\n`] });
  let positioned = new Set<BlockSpec>();
  let item = (text: string, listId: string, nestingLevel: number): ParagraphSpec =>
    ({ ...line(text), bullet: { listId, nestingLevel } });
  let cell = (): CellSpec => [
    () => `${word()}\n`,
    () => `${word()}\n`,
    () => "\n",
    () => ({ paragraphs: [line(word()), line(word())] }),
    () => ({ paragraphs: [{ ...line(word()), namedStyleType: "HEADING_2" }] }),
    () => ({ paragraphs: [item(word(), "B1", 0), item(word(), "B1", 0)] }),
  ][below(6)]();
  let table = (): TableSpec => {
    let rows = 1 + below(3);
    let columns = 1 + below(3);
    let cells = Array.from({ length: rows }, () => Array.from({ length: columns }, cell));
    // A merged cell, with the empty cell it covers.
    if (columns > 1 && below(5) === 0) {
      cells[0][0] = { paragraphs: [line(word())], tableCellStyle: { columnSpan: 2 } };
      cells[0][1] = "\n";
    } else if (rows > 1 && below(5) === 0) {
      cells[0][0] = { paragraphs: [line(word())], tableCellStyle: { rowSpan: 2 } };
      cells[1][0] = "\n";
    }
    return {
      table: cells,
      ...(below(5) === 0 ? { headerRows: 1 } : {}),
      ...(below(5) === 0
        ? { columns: Array.from({ length: columns }, (_, column) => column === 0 ? 100 : null) }
        : {}),
    };
  };
  let kinds: (() => BlockSpec[])[] = [
    () => [line(`${word()} ${word()}`)],
    () => [line(`${word()} \u{1F600} ${word()}`)],
    () => [{
      runs: [
        `${word()} `, { text: word(), style: { bold: true } }, " ",
        { text: word(), style: { italic: true } }, " ",
        { text: word(), style: { strikethrough: true } }, " ",
        { text: word(), style: { link: { url: "https://example.com/linked" } } }, "\n",
      ],
    }],
    () => [{
      ...line(word()),
      namedStyleType: pick(["HEADING_1", "HEADING_2", "HEADING_3", "TITLE", "SUBTITLE"]),
    }],
    () => {
      let listId = pick(["B9", "N9", "B1", "N1"]);
      let deep = listId.endsWith("9");
      return Array.from({ length: 1 + below(3) }, () => item(word(), listId, deep ? below(3) : 0));
    },
    () => {
      let listId = pick(["B9", "N9"]);
      return [item(word(), listId, 0), item(word(), listId, 1), item(word(), listId, 2)];
    },
    () => [table()],
    () => [table()],
    () => [line("")],
    () => [{ runs: [`${word()} `, { person: { name: "Ana", email: "" } }, "\n"] }],
    () => {
      let anchor = line(word());
      positioned.add(anchor);
      return [anchor];
    },
    () => [{ structure: "tableOfContents", length: 3 }],
  ];
  let tailed = below(5) === 0;
  let blocks = Array.from({ length: tailed ? below(4) : 3 + below(5) }, () => pick(kinds)()).flat();
  // Some tabs end in nested items, which an item appended after them takes in.
  if (!tailed && below(4) === 0) blocks.push(...kinds[5]());

  let tail: Tail | undefined;
  if (tailed) {
    let listId = pick(["B9", "N9"]);
    tail = { marker: listId === "B9" ? "- " : "1. ", level: pick([1, 2]), hasC: below(2) === 0 };
    if (below(4) > 0) blocks.push(item("itemA", listId, 0));
    let anchor = item("itemB", listId, tail.level);
    positioned.add(anchor);
    blocks.push(anchor);
    if (tail.hasC) blocks.push(item("itemC", listId, tail.level));
  }
  // As in a document of Google's, a paragraph stands before every table and at the end.
  let spaced: BlockSpec[] = [];
  for (let block of blocks) {
    let previous = spaced.at(-1);
    if ("table" in block && (!previous || !("runs" in previous))) spaced.push(line(""));
    spaced.push(block);
  }
  let last = spaced.at(-1);
  if (!last || !("runs" in last)) spaced.push(line(""));

  let tab = buildTab(spaced, LISTS());
  spaced.forEach((block, index) => {
    // The section break that opens the body stands before the first block.
    let paragraph = tab.body.content[index + 1].paragraph;
    if (paragraph && positioned.has(block)) {
      paragraph.positionedObjectIds = [tail && block === spaced.at(tail.hasC ? -2 : -1)
        ? B_ANCHOR : `kix.anchor-${index}`];
    }
  });
  return { tab: below(2) === 0 ? { ...tab, namedStyles: NAMED_STYLES } : tab, tail };
}

/** The kind of an edit, as the run counts them: a replacement in table cells is its own. */
function kindOfEdit(edit: DocEdit): "replace" | "cells" | "append" | "table" {
  if (edit.type === "replaceText") return edit.inTable ? "cells" : "replace";
  return edit.type === "appendText" ? "append" : "table";
}

/** Markdown as a caller may write it, around a word. */
const WRITTEN: ((word: string) => string)[] = [
  word => word, word => `${word} and more words`, word => `# ${word}`, word => `## ${word}`,
  word => `- ${word}`, word => `1. ${word}`, word => `  - ${word}`,
  word => `${" ".repeat(18)}- ${word}`, word => `**${word}**`, word => `*${word}*`,
  word => `~~${word}~~`, word => `[${word}](https://example.com/${word})`,
  word => `${word}\n\nsecond ${word}`, () => "", word => `${word}\twith a tab`,
  word => `${word} \u{1F600}`,
  // Every branch of the builders' bullets: a nested item alone, a list that starts nested,
  // nested items a top-level one is written after, a numbered child, a deep child before a
  // top-level item, and the two kinds of list one after the other.
  word => `  - ${word}\n    - deeper ${word}`, word => `- ${word}\n  - b ${word}\n    - c ${word}`,
  word => `1. ${word}\n  1. m ${word}`, word => `    1. deep ${word}\n1. top ${word}`,
  word => `- ${word}\n- two ${word}`, word => `1. ${word}\n1. two ${word}`,
  word => `- ${word}\n1. other ${word}`,
  // The forms only text that was not put in the form a read gives has.
  word => `* ${word}`, word => `+ ${word}`, word => `1) ${word}`, word => `-\t${word}`,
  word => `\t${word}`, word => ` - ${word}`, word => `   - ${word}`, word => `     - ${word}`,
  word => `\n\n${word}`, word => `${word}\n\n`, word => `${word}\n\n\n\nafter ${word}`,
  word => `\n${word}`, word => `\n- ${word}`, word => `\n\n1. ${word}`, word => `\n  - ${word}`,
  word => `\n# ${word}`, word => `\n\n\n${word}\n\n`,
  word => `${word}\r\nsecond ${word}`, word => `- ${word}\r\n- crlf ${word}`,
  word => `${word.slice(0, 2)}\u0001${word.slice(2)}`,
  // List items whose own text starts with a tab, alone and in a run that takes levels.
  word => `- \t${word}`, word => `  - \t${word}\n- \tb ${word}`,
];

/** The text of a cell as a caller may write it, around a word. */
const WRITTEN_IN_CELLS: ((word: string) => string)[] = [
  word => word, word => `<strong>${word}</strong> tail`, word => `<em>${word}</em>`,
  word => `<s>${word}</s>`, word => `<a href="https://example.com/${word}">${word}</a>`,
  () => "", word => `${word}<br>${word}`, word => `${word} \u{1F600}`,
  word => `${word} &amp; more`, word => `**${word}**`,
];

/** `index`, or the start of the surrogate pair it would cut. */
function onCodePoint(text: string, index: number): number {
  let unit = text.charCodeAt(index);
  let before = text.charCodeAt(index - 1);
  return unit >= 0xdc00 && unit <= 0xdfff && before >= 0xd800 && before <= 0xdbff ? index - 1 : index;
}

/** Whether `text` occurs in `markdown` at `start` and nowhere else, as a replacement must. */
function occursOnce(markdown: string, text: string, start: number): boolean {
  return text !== "" && markdown.indexOf(text) === start && markdown.indexOf(text, start + 1) < 0;
}

/** A replacement of a range of the tab's Markdown, drawn towards the ends of lines and words. */
function drawReplacement({ markdown }: DocTabSnapshot, { below, pick, word }: WordDice): DocEdit | undefined {
  let lineStarts = [0];
  for (let index = markdown.indexOf("\n"); index >= 0; index = markdown.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  let lineEnd = (start: number) => {
    let end = markdown.indexOf("\n", start);
    return end < 0 ? markdown.length : end;
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    let lineStart = pick(lineStarts);
    let start = lineStart;
    let end = lineEnd(lineStart);
    let shape = below(4);
    if (shape === 1) {
      // One word of the line, or from one word's start to another's end.
      let words = [...markdown.slice(lineStart, end).matchAll(/[^\s<>]+/g)];
      if (words.length === 0) continue;
      let from = below(words.length);
      let to = from + below(Math.min(3, words.length - from));
      start = lineStart + words[from].index;
      end = lineStart + words[to].index + words[to][0].length;
    } else if (shape === 2) {
      // On into one of the next lines.
      end = lineEnd(lineStarts[Math.min(lineStarts.length - 1, lineStarts.indexOf(lineStart) + 1 + below(3))]);
    } else if (shape === 3) {
      start = onCodePoint(markdown, below(markdown.length));
      end = onCodePoint(markdown, Math.min(markdown.length, start + 1 + below(30)));
    }
    let oldMarkdown = markdown.slice(start, end);
    if (!occursOnce(markdown, oldMarkdown, start)) continue;
    let text = pick(WRITTEN)(word());
    let newMarkdown = pick([
      text, text, `${oldMarkdown}\n${text}`, `${oldMarkdown}\n\n${text}`, `${text}\n\n${oldMarkdown}`,
      `${text}\n${oldMarkdown}`, `${oldMarkdown} ${word()}`,
    ]);
    // A top-level item written after a nested one takes the nested items before it in.
    let nested = shape === 0 ? /^ +(- |\d+\. )/.exec(oldMarkdown) : null;
    if (nested && below(2) === 0) newMarkdown = `${oldMarkdown}\n${nested[1]}${word()}`;
    return { type: "replaceText", oldMarkdown, newMarkdown };
  }
  return undefined;
}

/**
 * Text appended to the tab, as the caller gives it: an action stores it unchanged, and it is
 * far below the size an append may have.
 */
function drawAppend({ markdown }: DocTabSnapshot, { below, pick, word }: WordDice): DocEdit {
  // A top-level item appended after a nested one takes the nested items before it in.
  let nested = /\n +(- |\d+\. )[^\n]*\n$/.exec(markdown);
  return {
    type: "appendText",
    markdown: nested && below(3) === 0 ? `${nested[1]}${word()}` : pick(WRITTEN)(word()),
  };
}

/** A replacement of the text of one cell paragraph, or of several of one table at once. */
function drawCellReplacement(view: DocTabSnapshot, { below, pick, word }: WordDice): DocEdit | undefined {
  let { markdown } = view;
  let tables = view.sourceMap.tables;
  if (tables.length === 0) return undefined;
  let { mdStart, mdEnd } = pick(tables);
  let html = markdown.slice(mdStart, mdEnd);
  let written = (tag: string, text: string) => {
    // A list item keeps the marker it reads with.
    let marker = tag === "li" ? /^\S+ /.exec(text)?.[0] ?? "" : "";
    return `<${tag}>${marker}${pick(WRITTEN_IN_CELLS)(word())}</${tag}>`;
  };
  let paragraphs = /<(p|li|h[1-6])>([^<]*)<\/\1>/g;
  if (below(4) === 0 && occursOnce(markdown, html, mdStart)) {
    let newMarkdown = html.replace(paragraphs, (all, tag: string, text: string) =>
      below(2) === 0 ? written(tag, text) : all);
    return { type: "replaceText", oldMarkdown: html, newMarkdown, inTable: true };
  }
  let found = [...html.matchAll(paragraphs)]
    .filter(match => occursOnce(markdown, match[0], mdStart + match.index));
  if (found.length === 0) return undefined;
  let match = pick(found);
  return {
    type: "replaceText", oldMarkdown: match[0], newMarkdown: written(match[1], match[2]),
    inTable: true,
  };
}

/** A change to one of the tab's tables, or a new table. */
function drawTableChange(view: DocTabSnapshot, { below, pick, word }: WordDice): DocEdit {
  let { markdown } = view;
  let tables = view.sourceMap.tables;
  let text = () => pick([word(), word(), "", "two words", `${word()}\n${word()}`, "\u{1F600}"]);
  let cells = (rows: number, columns: number) =>
    Array.from({ length: rows }, () => Array.from({ length: columns }, text));
  let kind = below(11);
  if (kind === 0 || tables.length === 0) {
    let rows = 1 + below(3);
    let columns = 1 + below(3);
    // After a line of the tab, or at its end.
    let lines = markdown.split("\n").filter(line => line !== "" && !/^\s*</.test(line));
    let after = below(2) === 0 && lines.length > 0 ? { after: pick(lines) } : {};
    return { type: "insertTable", rows, columns, cells: cells(rows, columns), ...after };
  }
  let table = below(tables.length);
  let target = tables[table];
  let rows = target.rows.length;
  let columns = target.rows[0].cells.length;
  let named = { expected: tableIdentity(markdown.slice(target.mdStart, target.mdEnd)) };
  let row = below(rows);
  let column = below(columns);
  let block = {
    row, column, rows: 1 + below(Math.min(2, rows - row)),
    columns: 1 + below(Math.min(2, columns - column)),
  };
  let change = ((): TableChange => {
    switch (kind) {
      case 1: return {
        type: "insertTableRows", at: below(rows + 1), cells: cells(1 + below(2), columns), ...named,
      };
      case 2: return {
        type: "insertTableColumns", at: below(columns + 1), cells: cells(rows, 1 + below(2)), ...named,
      };
      case 3: {
        let shape = { type: "deleteTableRows" as const, at: row, count: block.rows };
        return { ...shape, ...named, ...hiddenContent(view, table, shape) };
      }
      case 4: {
        let shape = { type: "deleteTableColumns" as const, at: column, count: block.columns };
        return { ...shape, ...named, ...hiddenContent(view, table, shape) };
      }
      case 5: {
        let shape = { type: "deleteTable" as const };
        return { ...shape, ...named, ...hiddenContent(view, table, shape) };
      }
      case 6: return {
        type: "setTableCellStyle", ...block, ...named,
        style: pick([
          { background: "#ffcc00" }, { background: "transparent" }, { verticalAlign: "middle" },
          { padding: { top: "2pt" } }, { border: "1pt solid #000000" },
          { borders: { top: "2pt dashed #ff0000" } },
        ]),
      };
      case 7: return {
        type: "setTableColumnWidths", at: column, count: block.columns, width: pick([72, 120.5, null]),
        ...named,
      };
      case 8: return {
        type: "setTableRowHeights", at: row, count: block.rows, height: pick([0, 30]), ...named,
      };
      case 9: return { type: "mergeTableCells", ...block, ...named };
      default: return { type: "unmergeTableCells", row, column, ...named };
    }
  })();
  return change;
}

/**
 * The first edit of a tab that ends in a tail. `shallower` writes an item above the level of
 * `itemB`, which the builders could place only by rewriting `itemB`: behind the list, or in
 * place of `itemC`. Otherwise the item is as deep as `itemB`, or one level deeper two times in
 * three, which is where the builders put an empty paragraph directly behind `itemB`.
 */
function tailEdit(
  { marker, level, hasC }: Tail, shallower: boolean, { below, pick }: Dice,
): DocEdit {
  let written = (depth: number, text: string) => `${"  ".repeat(depth)}${marker}${text}`;
  let append = (depth: number): DocEdit => ({ type: "appendText", markdown: written(depth, "x") });
  let moved = (depth: number): DocEdit => ({
    type: "replaceText", oldMarkdown: written(level, "itemC"), newMarkdown: written(depth, "itemC"),
  });
  let followed = (depth: number): DocEdit =>
    ({ type: "replaceText", oldMarkdown: "itemC", newMarkdown: `itemC\n${written(depth, "d")}` });
  if (shallower) {
    return hasC ? pick([append(level - 1), moved(level - 1), followed(level - 1)]) : append(level - 1);
  }
  if (below(3) > 0) return hasC ? moved(level + 1) : append(level + 1);
  return hasC ? followed(level) : append(level);
}

/** The positioned objects the paragraphs of the tab's body anchor, in document order. */
const anchors = (tab: GoogleDocsTab) =>
  tab.body.content.flatMap(element => element.paragraph?.positionedObjectIds ?? []);

const kindOf = (request: GoogleDocsRequest) => Object.keys(request)[0];

/** Whether a batch bullets an empty paragraph it wrote for the levels, and deletes it. */
function hasEmptyParagraph(requests: readonly GoogleDocsRequest[]): boolean {
  return requests.some((request, index) => {
    let after = requests[index + 2];
    return "insertText" in request && /^\t*\n$/.test(request.insertText.text) &&
      kindOf(requests[index + 1] ?? {}) === "createParagraphBullets" &&
      after !== undefined && "deleteContentRange" in after &&
      after.deleteContentRange.range.endIndex - after.deleteContentRange.range.startIndex === 1;
  });
}

/**
 * Whether a batch takes existing items into the bullets it makes: after its text styles it
 * removes their bullets and their indent and writes their levels in tabs.
 */
function takesItemsIn(requests: readonly GoogleDocsRequest[]): boolean {
  let kinds = requests.map(kindOf);
  let taken = kinds.indexOf("deleteParagraphBullets", kinds.lastIndexOf("updateTextStyle") + 1);
  let indent = requests[taken + 1];
  let tabs = requests[taken + 2];
  return taken >= 0 && indent !== undefined && "updateParagraphStyle" in indent &&
    indent.updateParagraphStyle.fields === "indentStart,indentFirstLine" &&
    tabs !== undefined && "insertText" in tabs && /^\t+$/.test(tabs.insertText.text) &&
    kinds.includes("createParagraphBullets", taken);
}

/** Whether a range a request names holds any index of `paragraph`. */
function reaches(
  range: { startIndex: number; endIndex: number },
  paragraph: { startIndex: number; endIndex: number },
): boolean {
  return range.startIndex < paragraph.endIndex && range.endIndex > paragraph.startIndex;
}

const EDITS_PER_TAB = 6;

/**
 * The texts of Google's own refusals of a batch the builders sent, each a defect of the
 * builder: none is known.
 */
const GOOGLE_REFUSALS: string[] = [];

/** Sizes that cut a tab into runs of one to three elements. */
const FORCED: RunSizes = { least: 0, target: 400, most: Infinity, elements: 3 };

/** The tabs the generator builds, and the parts they are edited in: one test a part. */
const TABS = 420;
const PARTS = 10;

describe("what the request builders send", () => {
  // One run of the dice over every tab, in the parts' order: a part goes on where the part
  // before it stopped, and the last test holds what all of them counted.
  let seed = 20261113;
  let dice = wordDiceOf(seed);
  let { below } = dice;
  let applied = { replace: 0, cells: 0, append: 0, table: 0 };
  let refused = 0;
  let positionedRefusals = 0;
  let levelRefusals = 0;
  let rawAppends = 0;
  let bullets = 0;
  let tabsWrittenBack = 0;
  let emptyParagraphs = 0;
  let takenIn = 0;
  let tails = { refused: 0, built: 0, behind: 0 };
  // Google's own refusal of a batch a builder sent, by its text, with the first case of it.
  let googleRefusals = new Map<string, string>();

  it.each(Array.from({ length: PARTS }, (_, part) => part))(
    "never reaches a shape the model has no answer for: part %i of the tabs", part => {
    for (let number = part * TABS / PARTS; number < (part + 1) * TABS / PARTS; number++) {
      let made = randomTab(dice);
      let { tail } = made;
      let { tab } = made;
      // Google sends no start index on the section break that opens a body: the model gives it
      // one, and a tab the model made reads back from the store with it.
      delete (tab.body.content[0] as { startIndex?: number }).startIndex;
      // Every tab the generator builds and every tab an edit gives renders by runs as it
      // renders whole, at every cut, and each of its runs is summarised and keyed as the
      // renderer renders it.
      expectRendersByRuns(tab, `seed ${seed}, tab ${number} as built`, "every", { stored: true });
      // Beside the chain in memory, each edit is made through a store, in the stored version of
      // the tab the chain carries, which the store decodes from what it stored: a version that
      // passed through JSON gives the same step. Every second tab is edited through a second
      // store too, which cuts it into runs of one to three elements (every second, for the
      // time the test takes): a version of several runs gives the same step.
      let stores = [
        fakeDocStore(), ...(number % 2 === 0 ? [fakeDocStore(undefined, undefined, FORCED)] : []),
      ];
      for (let turn = 0; turn < EDITS_PER_TAB; turn++) {
        let view = docTabToMarkdown(tab);
        let first = tail !== undefined && turn === 0 ? tail : undefined;
        let shallower = below(2) === 0;
        let draw = below(10);
        let edit = first ? tailEdit(first, shallower, dice)
          : (draw < 2 ? drawCellReplacement(view, dice) : undefined) ??
            (draw < 4 ? drawTableChange(view, dice) : undefined) ??
            (draw < 6 ? drawAppend(view, dice) : undefined) ??
            drawReplacement(view, dice);
        if (!edit) continue;
        let where = () => `seed ${seed}, tab ${number}, the edit ${JSON.stringify(edit)} of the ` +
          `tab that reads ${JSON.stringify(view.markdown)}`;

        let versions = stores.map(store => store.putTab("doc", tab, []));
        let stored = stores.map((store, at) => () => docEditResult(store, versions[at], edit));
        let requests: GoogleDocsRequest[];
        try {
          requests = docEditRequests(view, edit);
        } catch (error) {
          // A builder refuses with an `Error` of its own; anything else is a defect.
          if (!(error instanceof Error) || error instanceof TypeError) throw error;
          for (let made of stored) {
            expect(made, where()).toThrow(new DocEditRefusedError({ reason: error.message }));
          }
          refused++;
          if (error.message === POSITIONED_ITEM_BEFORE) positionedRefusals++;
          if (error.message === LIST_LEVEL_TOO_DEEP) levelRefusals++;
          if (first) {
            expect(shallower, where()).toBe(true);
            expect(error.message, where()).toBe(POSITIONED_ITEM_BEFORE);
            tails.refused++;
          }
          continue;
        }
        if (first) expect(shallower, where()).toBe(false);
        if (requests.length === 0) {
          for (let [at, made] of stored.entries()) expect(made().after, where()).toBe(versions[at]);
          continue;
        }

        let results: GoogleDocsTab[] = [];
        for (let options of MODELS) {
          try {
            results.push(applyDocsRequests(tab, requests, options));
          } catch (error) {
            if (error instanceof NotModelledError) {
              throw new Error(`The model has no answer for ${error.what}: ${where()}`, { cause: error });
            }
            let refusal = error instanceof Error ? error.message : String(error);
            if (!googleRefusals.has(refusal)) googleRefusals.set(refusal, where());
          }
        }
        if (results.length < MODELS.length) {
          expect(first, where()).toBeUndefined();
          continue;
        }

        // The builders neutralise what Google does one way or another: one rendering.
        let readings = new Set(results.map(result => docTabToMarkdown(result).markdown));
        expect(readings.size, where()).toBe(1);
        // Each store answers the requests, the tab and the Markdown the chain in memory has.
        let after = applyDocsRequests(tab, requests);
        expectRendersByRuns(after, where(), "every", { stored: true });
        let markdown = docTabToMarkdown(after).markdown;
        for (let [at, store] of stores.entries()) {
          let result = stored[at]();
          let decoded = store.tab(result.after);
          expect(result.requests, where()).toEqual(requests);
          expect(decoded, where()).toEqual(after);
          expect(JSON.stringify(decoded), where()).toBe(JSON.stringify(after));
          expect(store.markdown(result.after), where()).toBe(markdown);
        }
        // No edit to paragraphs moves or drops a positioned object. A table change may: a
        // deleted table, row or column takes its cells' paragraphs with it.
        let kind = kindOfEdit(edit);
        if (kind === "replace" || kind === "append") {
          for (let result of results) expect(anchors(result), where()).toEqual(anchors(tab));
        }

        applied[kind]++;
        bullets += requests.filter(request => "createParagraphBullets" in request).length;
        // The level tabs of items a run takes in may follow a later run's bullets; only tabs
        // after the batch's last bullets are an item's own, written back.
        let lastBullets = requests.findLastIndex(request => "createParagraphBullets" in request);
        if (lastBullets >= 0 && requests.slice(lastBullets).some(request =>
          "insertText" in request && /^\t+$/.test(request.insertText.text))) tabsWrittenBack++;
        if (hasEmptyParagraph(requests)) emptyParagraphs++;
        if (takesItemsIn(requests)) takenIn++;
        if (edit.type === "appendText") {
          // The text as given builds another batch than the text in the form a read gives.
          let canonical = canonicalizeMarkdownForWrite(edit.markdown);
          let other: unknown;
          try {
            other = docEditRequests(view, { type: "appendText", markdown: canonical });
          } catch {
            other = undefined;
          }
          if (JSON.stringify(other) !== JSON.stringify(requests)) rawAppends++;
        }
        if (first) {
          tails.built++;
          // Nothing was written in front of `itemB`, so its indexes are those of the tab.
          let anchored = tab.body.content.find(element =>
            element.paragraph?.positionedObjectIds?.includes(B_ANCHOR));
          if (!anchored) throw new Error(`Expected the anchored item: ${where()}`);
          let last = requests[requests.length - 1];
          let behind = requests.some(request => "insertText" in request &&
            request.insertText.location.index === anchored.endIndex &&
            /^\t+\n$/.test(request.insertText.text)) &&
            "deleteContentRange" in last &&
            last.deleteContentRange.range.startIndex === anchored.endIndex &&
            last.deleteContentRange.range.endIndex === anchored.endIndex + 1;
          if (behind) tails.behind++;
          for (let request of requests) {
            let written = "insertText" in request &&
              request.insertText.location.index === anchored.startIndex;
            let bulleted = "deleteParagraphBullets" in request &&
              reaches(request.deleteParagraphBullets.range, anchored) ||
              "createParagraphBullets" in request &&
              reaches(request.createParagraphBullets.range, anchored);
            expect(written || bulleted, where()).toBe(false);
          }
          for (let result of results) {
            let holders = result.body.content.filter(element =>
              element.paragraph?.positionedObjectIds?.includes(B_ANCHOR));
            expect(holders.map(textOf), where()).toEqual(["itemB\n"]);
          }
        }
        tab = results[below(results.length)];
      }
    }
  });

  it("sends no batch Google refuses, and reaches every kind of edit and of bullets", () => {
    // A batch that Google refuses is a defect of the builder that sent it. None is known.
    expect([...googleRefusals.keys()], [...googleRefusals.values()].join("\n"))
      .toEqual(GOOGLE_REFUSALS);
    // Every kind of edit was applied, and the builders' bullets were reached in each shape.
    expect(applied.replace).toBeGreaterThanOrEqual(200);
    expect(applied.cells).toBeGreaterThanOrEqual(200);
    expect(applied.append).toBeGreaterThanOrEqual(200);
    expect(applied.table).toBeGreaterThanOrEqual(200);
    expect(refused).toBeGreaterThan(positionedRefusals);
    expect(rawAppends).toBeGreaterThanOrEqual(30);
    expect(bullets).toBeGreaterThanOrEqual(300);
    // An item whose text starts with a tab is bulleted without it and given it afterwards, and
    // the model reads every such batch.
    expect(tabsWrittenBack).toBeGreaterThanOrEqual(20);
    expect(emptyParagraphs).toBeGreaterThanOrEqual(30);
    expect(takenIn).toBeGreaterThanOrEqual(30);
    // The item that anchors a positioned object: every shallower item was refused with the
    // builders' own text, and every other one was built without a request into that item.
    expect(positionedRefusals).toBeGreaterThanOrEqual(20);
    expect(tails.refused).toBeGreaterThanOrEqual(20);
    expect(tails.built).toBeGreaterThanOrEqual(20);
    expect(tails.behind).toBeGreaterThanOrEqual(15);
    // The item written eighteen spaces in is refused by the builders, so the model is never
    // asked for a tenth level.
    expect(levelRefusals).toBeGreaterThanOrEqual(5);
  });
});

function textOf(element: { paragraph?: Paragraph }): string {
  return (element.paragraph?.elements ?? []).map(part => part.textRun?.content ?? "").join("");
}
