// Seeded tabs and edits for the differential of the request builders on a piece of a tab:
// tabs of the shapes a closure must get right (runs of empty paragraphs, nested, tabbed and
// off-preset list items, positioned objects, protected content, tables beside tables, in cells
// and suggested, section breaks), each saying which it holds and where; replacements and
// appends drawn on them, a share of them beside a shape; and table changes, each as a replay
// holds it and as a call names it, on those tabs and on tabs made for what a table change
// asks of its tab as a whole. The same draws at every run. A helper and no test of its own.

import type { GoogleDocsTab } from "../src/docs-api";
import { applyDocsRequests, hasModelIndexes } from "../src/docs-model";
import type { DocEdit } from "../src/docs-replay";
import { tableCallChange } from "../src/docs-table-actions";
import type { TableCall } from "../src/docs-table-actions";
import {
  hiddenContent, replacementPath, tableIdentity, tabTableChangeRequests, wholeTabReading,
} from "../src/docs-tables";
import type { TableChange, TextReplacement } from "../src/docs-tables";
import { ELEMENT_BLOCK, ELEMENT_TABLE } from "../src/markdown-converter";
import {
  buildTab, cellOf, CHECK_LIST, diceOf, footnote, grid, heading, item, NUMBERED_LIST, para,
  presetLevels, QUIET_LIST, sized,
} from "./doc-fixture";
import type { BlockSpec, Dice, Lists, ParagraphSpec } from "./doc-fixture";
import { APPEND, ownIn, pieceCase, renderedOf, REPLACE } from "./docs-piece-shadow";
import type { PieceCase } from "./docs-piece-shadow";
import { asFetched } from "./docs-store-slice-shadow";

/** The shapes a generated tab is drawn from, beside plain paragraphs and headings. */
export const PIECE_SHAPES = [
  /** A run of empty paragraphs: one to five, and in one tab in ten a run of 40. */
  "empties",
  /** Items of bulleted and numbered lists nested to level 5: the mark is on the deeper ones. */
  "nested",
  /** A list item whose text starts with a tab. */
  "tabbed",
  /** An item of a list no preset makes: one with no marker, a checklist's. */
  "offPreset",
  /** A paragraph outside lists that a positioned object is anchored to. */
  "positioned",
  /** A positioned object inside a run of deeper list items: on an item, or between two. */
  "positionedInList",
  /** A person or date chip, a footnote reference or a horizontal rule. */
  "protected",
  /** A table. */
  "tables",
  /** Two or three tables with only the paragraph between. */
  "tablesBeside",
  /** A table that holds a table in a cell. */
  "nestedTable",
  /** A table with a suggested row, or with a suggested cell. */
  "suggested",
  /** A section break or a table of contents inside the body. */
  "sectionBreak",
] as const;

/** One of `PIECE_SHAPES`. */
export type PieceShape = (typeof PIECE_SHAPES)[number];

/** A generated tab, as a fetch hands it to a store, with the shapes it holds. */
export type PieceTab = {
  readonly name: string;
  readonly tab: GoogleDocsTab;
  /** The shapes the tab holds. */
  readonly shapes: ReadonlySet<PieceShape>;
  /** The body elements, by their place in the body, that are of each shape the tab holds. */
  readonly marks: ReadonlyMap<PieceShape, readonly number[]>;
};

const LISTS: Lists = {
  B1: { listProperties: { nestingLevels: presetLevels() } },
  B2: { listProperties: { nestingLevels: presetLevels() } },
  N1: { listProperties: { nestingLevels: presetLevels(true) } },
  N2: { listProperties: { nestingLevels: presetLevels(true) } },
  ...QUIET_LIST,
  ...CHECK_LIST,
};
const PRESET_LISTS = ["B1", "B1", "B2", "N1", "N1", "N2"] as const;

/** A tab as it is drawn: its blocks so far, and what is marked of them, by block. */
type Draft = Dice & {
  blocks: BlockSpec[];
  marks: [PieceShape, number][];
  /** The blocks, by place, that a positioned object is anchored to. */
  anchors: number[];
  footnotes: number;
  /** A word no other block of the tab holds. */
  word(): string;
};

/** Appends `block`, marked as each of `shapes`. */
function put(draft: Draft, block: BlockSpec, ...shapes: PieceShape[]): void {
  for (let shape of shapes) draft.marks.push([shape, draft.blocks.length]);
  draft.blocks.push(block);
}

/** Appends a paragraph a positioned object is anchored to, marked as `shape`. */
function putAnchor(draft: Draft, block: ParagraphSpec, shape: PieceShape): void {
  draft.anchors.push(draft.blocks.length);
  put(draft, block, shape);
}

/** The next level of a list that wanders: up by one, the same, or down by one or two. */
function wandered({ below }: Dice, level: number): number {
  let step = below(4);
  return step === 0 ? Math.max(0, level - 1 - below(2)) : step === 1 ? level : Math.min(5, level + 1);
}

/** What draws the blocks of each shape. Each ends in a paragraph. */
const DRAWN: Record<PieceShape, (draft: Draft) => void> = {
  empties(draft) {
    for (let count = 1 + draft.below(5); count > 0; count--) put(draft, para(""), "empties");
    put(draft, para(`After ${draft.word()}`));
  },
  nested(draft) {
    let { below, pick } = draft;
    let listId: string = pick(PRESET_LISTS);
    let level = 0;
    let items = (count: number) => {
      for (; count > 0; count--) {
        let text = below(12) === 0 ? "" : `item ${draft.word()}`;
        put(draft, item(text, listId, level), ...(level > 0 ? ["nested" as const] : []));
        if (below(10) === 0) put(draft, para(""));
        if (below(8) === 0) listId = pick(PRESET_LISTS);
        level = wandered(draft, level);
      }
    };
    items(2 + below(7));
    // A list continued after a paragraph.
    if (below(3) === 0) {
      put(draft, para(`Between ${draft.word()}`));
      items(1 + below(3));
    }
    put(draft, para(`After ${draft.word()}`));
  },
  tabbed(draft) {
    let listId = draft.pick(PRESET_LISTS);
    put(draft, item(`item ${draft.word()}`, listId));
    for (let count = 1 + draft.below(3); count > 0; count--) {
      put(draft, item(`\titem ${draft.word()}`, listId, draft.below(3)), "tabbed");
    }
    put(draft, draft.below(2) ? item(`item ${draft.word()}`, listId) : para(`After ${draft.word()}`));
  },
  offPreset(draft) {
    let listId = draft.pick(["Q1", "check"]);
    for (let count = 1 + draft.below(4); count > 0; count--) {
      put(draft, item(`item ${draft.word()}`, listId), "offPreset");
    }
    put(draft, para(`After ${draft.word()}`));
  },
  positioned(draft) {
    putAnchor(draft, para(`Anchor ${draft.word()}`), "positioned");
    put(draft, para(`After ${draft.word()}`));
  },
  positionedInList(draft) {
    let { below } = draft;
    let listId = draft.pick(PRESET_LISTS);
    let deep = () => item(`item ${draft.word()}`, listId, 1 + below(3));
    put(draft, item(`item ${draft.word()}`, listId));
    put(draft, deep(), "nested");
    // The object on a deeper item, or on a plain paragraph between two deeper items.
    if (below(2)) putAnchor(draft, deep(), "positionedInList");
    else putAnchor(draft, para(`Anchor ${draft.word()}`), "positionedInList");
    put(draft, deep(), "nested");
    if (below(2)) put(draft, deep(), "nested");
    put(draft, para(`After ${draft.word()}`));
  },
  protected(draft) {
    let word = draft.word();
    put(draft, draft.pick<() => ParagraphSpec>([
      () => ({ runs: [`Chip ${word} `, { person: { name: "Ada", email: "ada@example.com" } }, " after\n"] }),
      () => ({ runs: [`Date ${word} `, { date: "2026-01-02" }, "\n"] }),
      () => ({ runs: [`Noted ${word}`, footnote(++draft.footnotes), "\n"] }),
      () => ({ runs: [{ horizontalRule: true }, "\n"] }),
    ])(), "protected");
    put(draft, para(`After ${draft.word()}`));
  },
  tables(draft) {
    let { below } = draft;
    let rows = Array.from({ length: 1 + below(2) },
      () => Array.from({ length: 1 + below(2) }, () => `cell ${draft.word()}`));
    put(draft, grid(...rows), "tables");
    put(draft, para(below(3) === 0 ? "" : `After ${draft.word()}`));
  },
  tablesBeside(draft) {
    for (let count = 2 + draft.below(2); count > 0; count--) {
      put(draft, grid([`cell ${draft.word()}`, `cell ${draft.word()}`]), "tables", "tablesBeside");
      put(draft, para(""));
    }
  },
  nestedTable(draft) {
    let inner = grid([`inner ${draft.word()}`]);
    put(draft, {
      table: [[cellOf(para(`cell ${draft.word()}`), inner, para("")), `cell ${draft.word()}\n`]],
    }, "tables", "nestedTable");
    put(draft, para(draft.below(3) === 0 ? "" : `After ${draft.word()}`));
  },
  suggested(draft) {
    let kind = draft.pick(["insertion", "deletion"] as const);
    let cell = () => `cell ${draft.word()}\n`;
    put(draft, draft.below(2)
      ? { table: [[cell()], [cell()]], suggestedRows: { [draft.below(2)]: kind } }
      : { table: [[cell(), { paragraphs: [para(`cell ${draft.word()}`)], suggested: kind }]] },
    "tables", "suggested");
    put(draft, para(draft.below(3) === 0 ? "" : `After ${draft.word()}`));
  },
  sectionBreak(draft) {
    put(draft, draft.below(2)
      ? { structure: "sectionBreak" }
      : { structure: "tableOfContents", length: 1 + draft.below(3) }, "sectionBreak");
    put(draft, para(`After ${draft.word()}`));
  },
};

/** Plain paragraphs and a heading, which every tab holds between its shapes. */
function plain(draft: Draft): void {
  if (draft.below(4) === 0) put(draft, heading(`Head ${draft.word()}`, 1 + draft.below(3)));
  for (let count = 1 + draft.below(2); count > 0; count--) put(draft, para(`Para ${draft.word()} tail`));
}

/**
 * `count` generated tabs of 20 to 60 body elements, the same at every run of a `seed`: each
 * holds three shapes that turn with its number, so that every shape is in a quarter of the
 * tabs, and others as drawn, between plain paragraphs and headings; one in five starts with
 * empty paragraphs and one in four ends with some, and every tenth holds a run of 40 of
 * them. Each is as a fetch hands a tab to a store (`asFetched`) and is indexed as the model
 * indexes a tab.
 */
export function pieceTabs(seed: number, count: number): PieceTab[] {
  let dice = diceOf(seed);
  let { below, pick } = dice;
  return Array.from({ length: count }, (_, number) => {
    let words = 0;
    let draft: Draft = {
      ...dice, blocks: [], marks: [], anchors: [], footnotes: 0,
      word: () => `w${number}x${words++}q`,
    };
    let long = number % 10 === 9;
    // The blocks of the body, which opens with a section break: the last of them empty.
    let tail = below(4) === 0 ? 1 + below(2) : 0;
    let limit = (long ? 59 : 19 + below(41)) - tail;
    if (below(5) === 0) for (let empty = 1 + below(3); empty > 0; empty--) put(draft, para(""), "empties");
    put(draft, para(`Lead ${draft.word()}`));
    if (long) {
      for (let empty = 0; empty < 40; empty++) put(draft, para(""), "empties");
      put(draft, para(`After ${draft.word()}`));
    }
    let featured = [0, 1, 2].map(turn => PIECE_SHAPES[(number + turn * 4) % PIECE_SHAPES.length]);
    while (draft.blocks.length < limit) {
      let chunk: Draft = { ...draft, blocks: [], marks: [], anchors: [] };
      let shape = featured.pop() ?? (below(3) === 0 ? undefined : pick(PIECE_SHAPES));
      if (shape) DRAWN[shape](chunk);
      else plain(chunk);
      // A chunk that would pass the limit is left out for plain paragraphs.
      if (draft.blocks.length + chunk.blocks.length > limit) {
        put(draft, para(`Para ${draft.word()} tail`));
        continue;
      }
      let at = draft.blocks.length;
      draft.blocks.push(...chunk.blocks);
      draft.marks.push(...chunk.marks.map(([marked, block]): [PieceShape, number] => [marked, at + block]));
      draft.anchors.push(...chunk.anchors.map(block => at + block));
      draft.footnotes = chunk.footnotes;
    }
    for (let empty = 0; empty < tail; empty++) put(draft, para(""), "empties");

    let built = buildTab(draft.blocks, LISTS);
    // A block is the body element after it: the body opens with a section break.
    for (let block of draft.anchors) {
      built.body.content[block + 1].paragraph!.positionedObjectIds = [`object-${block}`];
    }
    let tab = asFetched(built);
    if (!hasModelIndexes(tab)) throw new Error(`Tab ${number} of seed ${seed} is not indexed as the model indexes.`);
    let marks = new Map<PieceShape, number[]>();
    for (let [shape, block] of draft.marks) marks.set(shape, [...marks.get(shape) ?? [], block + 1]);
    return { name: `seed ${seed}, tab ${number}`, tab, shapes: new Set(marks.keys()), marks };
  });
}

/** An edit drawn on a generated tab. */
export type PieceDraw = PieceCase & {
  /** Whether the edit is an append. */
  readonly append: boolean;
  /**
   * The shapes the edit stands beside: those of which an element is one of the edit's own, or
   * the element before or after them.
   */
  readonly beside: readonly PieceShape[];
};

/**
 * `old` with a list item written after it or before it, at levels 0 to 5, of the kind of
 * `old`'s last item and of the other, and `old` with its own items brought to level 0.
 */
function itemsBeside(old: string, word: string): string[] {
  let marker = /^ *(-|\d+\.) [^\n]*$/.exec(old)?.[1] ?? "-";
  let other = marker === "-" ? "1." : "-";
  return [
    old.replace(/^ +(?=(?:-|\d+\.) )/gm, ""),
    `${old}\n${marker} ${word}`, `${marker} ${word}\n${old}`, `${old}\n  ${marker} ${word}`,
    `${old}\n    ${marker} ${word}`, `${old}\n          ${marker} ${word}`,
    `${old}\n${other} ${word}`, `${old}\n  ${other} ${word}`, `  ${other} ${word}\n${old}`,
  ];
}

/** What may stand in place of `old`, a text of a tab's Markdown: every way the edits change one. */
function replacements(old: string, word: string): string[] {
  let unmarked = old.replace(/^ *(?:-|\d+\.|#+) /gm, "");
  return [
    ...itemsBeside(old, word),
    // Emptied, and replaced whole.
    "", word, `${word}\n`, `\n${word}`, `\n\n${word}\n\n`,
    // Line breaks removed, halved, doubled, and written before and after.
    old.replace(/\n/g, ""), old.replace(/\n+/g, "\n"), old.replace(/\n+/g, "\n\n"),
    old.replace(/\n/g, "\n\n"), old.replace(/\n+/g, " "),
    `${old}\n`, `\n${old}`, `${old}\n\n`, `\n\n${old}`, `\n\n\n${old}`, `${old}\n\n\n`,
    // Blocks written in its place and beside it, list items at every level among them.
    `- ${word}`, `  - ${word}`, `      - ${word}`, `1. ${word}`, `  1. ${word}`, `## ${word}`,
    `- ${word}\n`, `\n- ${word}`, `\n  - ${word}\n`, `${old}\n\n${word}`, `${word}\n\n${old}`,
    // Markers removed, deepened, made shallower, switched in kind and added.
    unmarked, unmarked.replace(/\n+/g, " "),
    old.replace(/^( *)(?:-|\d+\.) /gm, "$1  - "),
    old.replace(/^ {2}( *)(?:-|\d+\.) /gm, "$1- "),
    old.replace(/^( *)- /gm, "$11. "),
    old.replace(/^( *)\d+\. /gm, "$1- "),
    old.replace(/^(.)/gm, "- $1"),
    // Lines reversed and split, and the text halved and trimmed.
    old.split("\n").toReversed().join("\n"),
    `${old.slice(0, old.length >> 1)}\n${old.slice(old.length >> 1)}`,
    old.slice(0, old.length >> 1), old.slice(old.length >> 1),
    old.trim(), old.trimEnd(), old.trimStart(),
  ];
}

/** The text of an append: one to four blocks, list items at levels 0 to 3 among them. */
function appended({ below, pick }: Dice, word: string): string {
  let blocks = Array.from({ length: 1 + below(4) }, (_, at) => pick([
    `Appended ${word}${at}.`, `Appended ${word}${at}.`, `## Head ${word}${at}`,
    `${"  ".repeat(below(4))}- item ${word}${at}`, `${"  ".repeat(below(4))}- item ${word}${at}`,
    `${"  ".repeat(below(4))}1. item ${word}${at}`,
  ]));
  let between = pick(["\n", "\n", "\n\n"]);
  return blocks.join(between);
}

/**
 * Up to `count` text edits of `tab`, the same at every run of a `seed`: one in ten an append;
 * of the others, half replace whole lines (one to four blocks, with or without the line
 * break after them or before them) and half ARBITRARY SUBSTRINGS of the rendering (starting
 * and ending inside a line, on a line break, one or two characters before a block, across up
 * to five blocks), each by one of `replacements`. Two in five start at a block BESIDE a
 * marked element of the tab (the block before or after it, or the block itself), one in five
 * at a list item deeper than level 0, where the tab has one, and one in ten at the last of
 * four such items in a row, which is brought to level 0 or has an item written at level 0
 * after it. A text that is not there exactly once, or that holds a character of a table's
 * HTML, is not drawn.
 */
export function pieceEdits(tab: PieceTab, seed: number, count: number): PieceDraw[] {
  let dice = diceOf(seed);
  let { below, pick } = dice;
  let { whole, rendering } = renderedOf(tab.tab);
  let { markdown } = rendering;
  let { blocks, tables } = rendering.sourceMap;
  // The body element of each block, and the blocks that stand beside a marked element.
  let elements = whole.flags.flatMap((flag, element) => flag & ELEMENT_BLOCK ? [element] : []);
  let marked = new Set([...tab.marks.values()].flat());
  let besides = elements.flatMap((element, block) =>
    [element - 1, element, element + 1].some(near => marked.has(near)) ? [block] : []);
  let deeper = blocks.flatMap((block, at) => block.listType !== null && block.listNestingLevel > 0 ? [at] : []);
  // The deeper items that end a run of four, one body element after the other: an item
  // written at level 0 there is read with every item of the run and the one before them.
  let runEnds = deeper.filter(block => [1, 2, 3].every(back =>
    deeper.includes(block - back) && elements[block - back] === elements[block] - back));
  let beside = (first: number, last: number) => [...tab.marks].flatMap(([shape, at]) =>
    at.some(element => element >= first - 1 && element <= last + 1) ? [shape] : []);

  let draws: PieceDraw[] = [];
  for (let serial = 0; serial < count && blocks.length > 0; serial++) {
    let word = `Zed${serial}`;
    if (below(10) === 0) {
      let end = whole.flags.length - 1;
      draws.push({
        ...pieceCase(APPEND, { markdown: appended(dice, word) }), append: true, beside: beside(end, end),
      });
      continue;
    }
    let halves = below(2) === 0;
    for (let tries = 0; tries < 12; tries++) {
      let aim = below(10);
      let atRunEnd = aim === 6 && runEnds.length > 0;
      let atDeeper = atRunEnd || (aim >= 4 && aim < 6 && deeper.length > 0);
      let first = aim < 4 && besides.length > 0 ? pick(besides)
        : atRunEnd ? pick(runEnds) : atDeeper ? pick(deeper) : below(blocks.length);
      // A deeper item is replaced from its line's start, so that its marker is the edit's.
      let lines = halves || atDeeper;
      let last = Math.min(blocks.length - 1, first + (below(3) === 0 ? below(lines ? 4 : 5) : below(2)));
      let edge = (block: number) => {
        let { mdStart, mdEnd } = blocks[block];
        return pick([
          mdStart, mdEnd - 1, mdEnd, Math.max(0, mdStart - 1), Math.max(0, mdStart - 2),
          mdStart + below(Math.max(1, mdEnd - mdStart)),
        ]);
      };
      let start = atDeeper ? blocks[first].mdStart
        : lines ? Math.max(0, blocks[first].mdStart - (below(4) === 0 ? 1 : 0)) : edge(first);
      let end = atDeeper ? blocks[first].mdEnd - 1 : lines ? blocks[last].mdEnd - below(2) : edge(last);
      if (end < start) [start, end] = [end, start];
      if (end === start) end = Math.min(markdown.length, start + 1 + below(6));
      let oldMarkdown = markdown.slice(start, end);
      if (oldMarkdown === "" || markdown.indexOf(oldMarkdown) !== start ||
          markdown.indexOf(oldMarkdown, start + 1) >= 0 ||
          tables.some(table => start < table.mdEnd && end > table.mdStart)) continue;
      // Beside a deeper item, half the edits write an item: what a walk back through the
      // items before it is for.
      let newMarkdown = pick(atRunEnd ? itemsBeside(oldMarkdown, word).slice(0, 2)
        : atDeeper && below(2) === 0 ? itemsBeside(oldMarkdown, word)
        : replacements(oldMarkdown, word));
      if (newMarkdown === oldMarkdown) continue;
      let edit = { matchStart: start, oldMarkdown, newMarkdown };
      let own = ownIn(whole, REPLACE.own(edit));
      draws.push({ ...pieceCase(REPLACE, edit), append: false, beside: beside(own.first, own.last) });
      break;
    }
  }
  return draws;
}

/**
 * The table the differential's seeded tests and the teeth run in the default pass: its seed,
 * its tabs and the edits drawn on each.
 */
export const DEFAULT_CORPUS = { seed: 20261119, tabs: 120, edits: 10 } as const;

/**
 * Every edit drawn on every tab of a table: `tabs` tabs of `seed`, and up to `edits` edits on
 * each, the edits of a tab seeded by the table's seed and the tab's number.
 */
export function pieceCorpus(
  { seed, tabs, edits }: { readonly seed: number; readonly tabs: number; readonly edits: number },
): { tab: PieceTab; drawn: PieceDraw }[] {
  return pieceTabs(seed, tabs).flatMap((tab, number) =>
    pieceEdits(tab, seed + 7919 * (number + 1), edits).map(drawn => ({ tab, drawn })));
}

/** An edit of a tab as `tabEditRequests` takes it, drawn for the differential, and its kind. */
export type TabEditDraw = {
  readonly edit: DocEdit;
  /**
   * A replacement outside tables or of the text of a table's cells, each of a text that
   * stands once; an append; or a replacement the scan refuses: of a text that is not there,
   * or that stands more than once.
   */
  readonly kind: "replace" | "cell" | "append" | "absent" | "twice";
  /** For a replacement of a text that stands once: where it stands in the tab's Markdown. */
  readonly matchStart?: number;
};

/** What may stand in place of `old`, text of a cell's paragraph, which is written as typed. */
function cellReplacements(old: string, word: string): string[] {
  return [word, `${old} ${word}`, `${word} ${old}`, old.slice(0, Math.ceil(old.length / 2)) + word];
}

/**
 * The edits `pieceEdits` draws on `tab`, as `tabEditRequests` takes them (a replacement's
 * path as `replacementPath` says it on the whole rendering), and up to `count / 2` more of
 * the kinds it does not draw, by a dice of their own so that its draws stand as they are:
 * replacements of the text of a table's cell (the whole text of a cell's paragraph, or a
 * part of it, that stands once in the tab), a replacement of a text the tab does not hold,
 * and one of a text it holds more than once.
 */
export function tabEdits(tab: PieceTab, seed: number, count: number): TabEditDraw[] {
  let { rendering } = renderedOf(tab.tab);
  let { markdown } = rendering;
  let draws: TabEditDraw[] = pieceEdits(tab, seed, count).map(({ entry, edit }): TabEditDraw => {
    if (entry === APPEND) {
      return { edit: { type: "appendText", markdown: (edit as { markdown: string }).markdown }, kind: "append" };
    }
    let { matchStart, oldMarkdown, newMarkdown } = edit as TextReplacement;
    return { edit: { type: "replaceText", oldMarkdown, newMarkdown }, kind: "replace", matchStart };
  });
  let { below, pick } = diceOf(seed + 104_729);
  let texts = rendering.sourceMap.tables.flatMap(table =>
    table.rows.flatMap(row => row.cells.flatMap(cell => cell.texts)));
  for (let serial = 0; serial < Math.ceil(count / 2); serial++) {
    let word = `Yod${serial}`;
    let kind = below(6);
    if (kind === 0) {
      draws.push({
        edit: { type: "replaceText", oldMarkdown: `${word} is nowhere`, newMarkdown: word }, kind: "absent",
      });
    } else if (kind === 1) {
      // A text of one to three characters that stands again later in the tab.
      for (let tries = 0; tries < 8 && markdown.length > 4; tries++) {
        let start = below(markdown.length - 3);
        let oldMarkdown = markdown.slice(start, start + 1 + below(3));
        if (markdown.indexOf(oldMarkdown, markdown.indexOf(oldMarkdown) + 1) < 0) continue;
        draws.push({ edit: { type: "replaceText", oldMarkdown, newMarkdown: word }, kind: "twice" });
        break;
      }
    } else if (texts.length > 0) {
      for (let tries = 0; tries < 8; tries++) {
        let { mdStart, mdEnd } = pick(texts);
        if (mdEnd <= mdStart) continue;
        // The text whole, or a part of it from a place inside it.
        let start = below(2) === 0 ? mdStart : mdStart + below(mdEnd - mdStart);
        let end = below(2) === 0 ? mdEnd : start + 1 + below(mdEnd - start);
        let oldMarkdown = markdown.slice(start, end);
        if (markdown.indexOf(oldMarkdown) !== start || markdown.indexOf(oldMarkdown, start + 1) >= 0) continue;
        let newMarkdown = pick(cellReplacements(oldMarkdown, word));
        let inTable = replacementPath(rendering, { matchStart: start, oldMarkdown, newMarkdown }).kind === "cells";
        draws.push({
          edit: { type: "replaceText", oldMarkdown, newMarkdown, ...(inTable ? { inTable: true as const } : {}) },
          kind: inTable ? "cell" : "replace", matchStart: start,
        });
        break;
      }
    }
  }
  return draws;
}

/** Every edit `tabEdits` draws on every tab of a table, as `pieceCorpus` draws its own. */
export function tabEditCorpus(
  { seed, tabs, edits }: { readonly seed: number; readonly tabs: number; readonly edits: number },
): { tab: PieceTab; drawn: TabEditDraw }[] {
  return pieceTabs(seed, tabs).flatMap((tab, number) =>
    tabEdits(tab, seed + 7919 * (number + 1), edits).map(drawn => ({ tab, drawn })));
}

// ---------------------------------------------------------------------------
// Table changes
// ---------------------------------------------------------------------------

/** A table change drawn on a tab. */
export type TableDraw = {
  /** The kind of change. */
  readonly kind: TableChange["type"];
  /** The change by how its table reads, as a replay holds it; absent for a draw only a call makes. */
  readonly change?: TableChange;
  /** The call that names its table by number, as a caller makes it; absent for a draw only a replay holds. */
  readonly call?: TableCall;
  /** The shapes the table, or the element a new table follows, stands beside. */
  readonly beside: readonly PieceShape[];
};

/** `rows` by `columns` texts for new cells: every other one empty. */
const newCells = (rows: number, columns: number, word: string): string[][] =>
  Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (__, column) => (row + column) % 2 ? "" : `${word}r${row}c${column}`));

/**
 * Up to `count` table changes of `tab`, the same at every run of a `seed`. Two in three change
 * a table the tab holds, where it holds one: rows and columns added at every place and
 * deleted, the table deleted, its cells' look, its columns' widths and its rows' heights set,
 * cells merged and a cell split, each as a change by how the table reads (built with no check
 * of the call's, so that what only the builders refuse is drawn too) and as a call by the
 * table's number; a look change's stored form is the call's, and is absent where the call is
 * refused. The others add a table: at the tab's end, after a line, after the text of a cell,
 * after a table (between two where another follows it), after a text the tab does not hold
 * and after one it holds twice. One draw in twelve is a refusal by the tab as a whole: a
 * call that names a table past the tab's last, or a change whose table reads as none does.
 */
export function pieceTableEdits(tab: PieceTab, seed: number, count: number): TableDraw[] {
  let dice = diceOf(seed);
  let { below, pick } = dice;
  let { whole, rendering } = renderedOf(tab.tab);
  let { markdown } = rendering;
  let { blocks, tables } = rendering.sourceMap;
  let reading = wholeTabReading(rendering);
  let elements = {
    tables: whole.flags.flatMap((flag, element) => flag & ELEMENT_TABLE ? [element] : []),
    blocks: whole.flags.flatMap((flag, element) => flag & ELEMENT_BLOCK ? [element] : []),
  };
  let beside = (element: number) => [...tab.marks].flatMap(([shape, at]) =>
    at.some(marked => marked >= element - 1 && marked <= element + 1) ? [shape] : []);
  let htmlOf = (table: number) => markdown.slice(tables[table].mdStart, tables[table].mdEnd);
  /** Whether `text` stands in the tab exactly once. */
  let once = (text: string) => text !== "" && markdown.indexOf(text) >= 0 &&
    markdown.indexOf(text, markdown.indexOf(text) + 1) < 0;

  let draws: TableDraw[] = [];
  let existing = (table: number, serial: number): TableDraw | undefined => {
    let word = `Tab${serial}`;
    let expected = tableIdentity(htmlOf(table));
    let rows = tables[table].rows.length;
    let columns = Math.max(...tables[table].rows.map(row => row.cells.length));
    let near = beside(elements.tables[table]);
    let kind = pick([
      "insertTableRows", "insertTableRows", "insertTableColumns", "deleteTableRows",
      "deleteTableColumns", "deleteTable", "deleteTable", "setTableCellStyle",
      "setTableColumnWidths", "setTableRowHeights", "mergeTableCells", "unmergeTableCells",
    ] as const);
    switch (kind) {
      case "insertTableRows":
      case "insertTableColumns": {
        let ofRows = kind === "insertTableRows";
        let at = below((ofRows ? rows : columns) + 1), added = 1 + below(2);
        let cells = ofRows ? newCells(added, columns, word) : newCells(rows, added, word);
        return {
          kind, beside: near, change: { type: kind, at, cells, expected },
          call: { method: kind, lines: { table, at, cells, ...(ofRows ? {} : { count: added }) } },
        };
      }
      case "deleteTableRows":
      case "deleteTableColumns": {
        let limit = kind === "deleteTableRows" ? rows : columns;
        // One in six deletes every line, which only a table deleted whole may.
        let at = below(limit), deleted = below(6) === 0 ? limit - at : 1 + below(Math.min(2, limit - at));
        let shape = { type: kind, at, count: deleted };
        return {
          kind, beside: near,
          change: { ...shape, expected, ...hiddenContent(rendering, table, shape) },
          call: { method: kind, lines: { table, at, count: deleted } },
        };
      }
      case "deleteTable":
        return {
          kind, beside: near, call: { method: kind, table },
          change: { type: kind, expected, ...hiddenContent(rendering, table, { type: kind }) },
        };
      case "mergeTableCells": {
        let row = below(rows), column = below(columns);
        let block = { row, column, rows: 1 + below(Math.min(2, rows - row)), columns: 1 + below(Math.min(2, columns - column)) };
        return {
          kind, beside: near, change: { type: kind, ...block, expected },
          call: { method: kind, cells: { table, ...block } },
        };
      }
      case "unmergeTableCells": {
        // The first cell that spans others, where the table holds one, in two draws of three.
        let spanning = tables[table].rows.flatMap((line, row) => line.cells.flatMap((cell, column) =>
          (cell.rowSpan ?? 1) > 1 || (cell.columnSpan ?? 1) > 1 ? [{ row, column }] : []));
        let cell = spanning.length > 0 && below(3) > 0 ? spanning[0] : { row: below(rows), column: below(columns) };
        return {
          kind, beside: near, change: { type: kind, ...cell, expected },
          call: { method: kind, cell: { table, ...cell } },
        };
      }
      default: {
        let row = below(rows), column = below(columns);
        let call: TableCall = kind === "setTableCellStyle"
          ? { method: kind, cells: { table, row, column, style: { background: pick(["#ffcc00", "#00ccff"]) } } }
          : kind === "setTableColumnWidths"
            ? { method: kind, columns: { table, at: column, width: pick([null, 72, 120.5]) } }
            : { method: kind, rows: { table, at: row, height: pick([0, 24, 40]) } };
        let change: TableChange | undefined;
        try {
          change = tableCallChange(reading, call);
        } catch (error) {
          if (!(error instanceof Error) || error instanceof TypeError) throw error;
        }
        return { kind, beside: near, call, ...(change ? { change } : {}) };
      }
    }
  };

  let added = (serial: number): TableDraw => {
    let word = `New${serial}`;
    let size = { rows: 1 + below(2), columns: 1 + below(2) };
    let cells = newCells(size.rows, size.columns, word);
    let kind = "insertTable" as const;
    let draw = (after: string | undefined, near: readonly PieceShape[]): TableDraw => ({
      kind, beside: near,
      change: { type: kind, ...size, cells, ...(after === undefined ? {} : { after }) },
      call: { method: kind, table: { ...size, cells, ...(after === undefined ? {} : { after }) } },
    });
    let aim = below(10);
    if (aim === 0) return draw(undefined, beside(whole.flags.length - 1));
    if (aim === 1) return draw(`${word} is nowhere`, []);
    if (aim === 2) {
      // A text of one to three characters that stands again later in the tab.
      for (let tries = 0; tries < 8 && markdown.length > 4; tries++) {
        let start = below(markdown.length - 3);
        let text = markdown.slice(start, start + 1 + below(3));
        if (text.trim() !== "" && markdown.indexOf(text, markdown.indexOf(text) + 1) >= 0) return draw(text, []);
      }
    }
    if (aim < 6 && tables.length > 0) {
      // After a table, named by its whole HTML, or after the text of one of its cells.
      let table = below(tables.length);
      let texts = tables[table].rows.flatMap(row => row.cells.flatMap(cell => cell.texts))
        .map(({ mdStart, mdEnd }) => markdown.slice(mdStart, mdEnd)).filter(once);
      let after = below(2) === 0 || texts.length === 0 ? htmlOf(table) : pick(texts);
      if (once(after)) return draw(after, beside(elements.tables[table]));
    }
    // After a line: a block's text, with the line break before it one time in three.
    for (let tries = 0; tries < 8 && blocks.length > 0; tries++) {
      let block = below(blocks.length);
      let { mdStart, mdEnd } = blocks[block];
      let line = markdown.slice(mdStart, mdEnd).replace(/\n+$/, "");
      let after = below(3) === 0 && mdStart > 0 ? `\n${line}` : line;
      if (once(line)) return draw(after, beside(elements.blocks[block]));
    }
    return draw(undefined, beside(whole.flags.length - 1));
  };

  for (let serial = 0; serial < count; serial++) {
    let aim = below(12);
    if (aim === 0) {
      let kind = pick(["deleteTable", "insertTableRows", "setTableRowHeights"] as const);
      let table = tables.length + below(3);
      draws.push({
        kind, beside: [],
        call: kind === "deleteTable" ? { method: kind, table }
          : kind === "insertTableRows" ? { method: kind, lines: { table } }
          : { method: kind, rows: { table, height: 20 } },
        // A table that reads as no table of the tab does.
        change: kind === "setTableRowHeights" ? undefined
          : kind === "deleteTable" ? { type: kind, expected: `<table>Gone${serial}</table>` }
          : { type: kind, at: 0, cells: [["x"]], expected: `<table>Gone${serial}</table>` },
      });
      continue;
    }
    let draw = aim < 9 && tables.length > 0 ? existing(below(tables.length), serial) : undefined;
    draws.push(draw ?? added(serial));
  }
  return draws;
}

/**
 * The table the differential's seeded tests of table changes and the teeth run in the default
 * pass: its seed, its tabs and the changes drawn on each.
 */
export const DEFAULT_TABLE_CORPUS = { seed: DEFAULT_CORPUS.seed + 900, tabs: 30, edits: 6 } as const;

/**
 * The tabs of a table, each with the table changes drawn on it: `tabs` tabs of `seed`, and
 * up to `edits` changes on each, seeded by the table's seed and the tab's number.
 */
export function pieceTableCorpus(
  { seed, tabs, edits }: { readonly seed: number; readonly tabs: number; readonly edits: number },
): { tab: PieceTab; draws: TableDraw[] }[] {
  return pieceTabs(seed, tabs).map((tab, number) =>
    ({ tab, draws: pieceTableEdits(tab, seed + 7919 * (number + 1), edits) }));
}

/** A tab made for one thing a table change asks of its tab as a whole, with the draws that ask it. */
export type MadeTableCase = { readonly tab: PieceTab; readonly draws: readonly TableDraw[] };

/** `count` plain paragraphs of words no other block holds. */
const filler = (name: string, count: number) =>
  Array.from({ length: count }, (_, at) => para(`${name} filler ${at}.`));

/**
 * The tabs made for what a table change asks of its tab AS A WHOLE, far from the piece
 * around its table, each with the draws that ask it:
 * - TWINS: two tables that read the same, twenty elements apart, and one that reads alone
 *   between them (a change by how its table reads meets "another table", a call by number
 *   the refusal that names both numbers);
 * - NUMBERED AFTER: a table whose cells hold items of a numbered list, with an item of a
 *   numbered list far after it, and the same with an ordered list in a far later table and
 *   no such item (the table deleted, and its rows);
 * - THE CELLS A TAB MAY HOLD: tables of 4,984 cells in all, far from a small one (rows, a
 *   column and a table added that fit, and that pass the limit);
 * - AN ANCHOR TWICE: a line that stands at the tab's two ends (a table after it);
 * - A MERGED CELL: a table with a cell that spans two columns, made by the model (the cell
 *   split, cells merged beside it, and lines added and deleted across it);
 * - TABLES OF SEVERAL ROWS AND COLUMNS between paragraphs, two of them with one empty
 *   paragraph between, with forty seeded draws (`pieceTableEdits`): the lines a seeded tab's
 *   small tables cannot lose;
 * - THE TAB'S TWO ENDS: a table that opens the body, and tables before the tab's last
 *   paragraph, one with text and one empty (the table deleted, a row added, and a table added
 *   after it): what a builder compares with the end of the Markdown in hand.
 */
export function madeTableCases(): MadeTableCase[] {
  let made = (name: string, tab: GoogleDocsTab, draw: (drawn: ReturnType<typeof renderedOf>) => TableDraw[]): MadeTableCase => {
    if (!hasModelIndexes(tab)) throw new Error(`The tab made for ${name} is not indexed as the model indexes.`);
    return { tab: { name, tab, shapes: new Set(), marks: new Map() }, draws: draw(renderedOf(tab)) };
  };
  let expectedOf = ({ rendering }: ReturnType<typeof renderedOf>, table: number) => {
    let { mdStart, mdEnd } = rendering.sourceMap.tables[table];
    return tableIdentity(rendering.markdown.slice(mdStart, mdEnd));
  };
  let none: readonly PieceShape[] = [];
  /** A row added to table `table`, and the table deleted, as a change and as a call. */
  let rowAndDeletion = (drawn: ReturnType<typeof renderedOf>, table: number): TableDraw[] => {
    let expected = expectedOf(drawn, table);
    let width = drawn.rendering.sourceMap.tables[table].rows[0].cells.length;
    let cells = newCells(1, width, `Made${table}`);
    return [
      {
        kind: "insertTableRows", beside: none, change: { type: "insertTableRows", at: 1, cells, expected },
        call: { method: "insertTableRows", lines: { table, at: 1, cells } },
      },
      {
        kind: "deleteTable", beside: none, call: { method: "deleteTable", table },
        change: { type: "deleteTable", expected, ...hiddenContent(drawn.rendering, table, { type: "deleteTable" }) },
      },
      {
        kind: "deleteTableRows", beside: none, call: { method: "deleteTableRows", lines: { table, at: 0 } },
        change: {
          type: "deleteTableRows", at: 0, count: 1, expected,
          ...hiddenContent(drawn.rendering, table, { type: "deleteTableRows", at: 0, count: 1 }),
        },
      },
    ];
  };
  let twin = grid(["Twin a", "Twin b"], ["Twin c", "Twin d"]);
  let listed = (name: string) => ({
    table: [[cellOf(item(`${name} one`, "N1"), item(`${name} two`, "N1")), `${name} plain\n`], [`${name} c\n`, `${name} d\n`]],
  });
  let cases = [
    made("twins", asFetched(buildTab([
      ...filler("Lead", 6), twin, ...filler("Mid", 9), grid(["Alone a", "Alone b"]), ...filler("More", 9),
      twin, ...filler("Tail", 4),
    ])), drawn => [0, 1, 2].flatMap(table => rowAndDeletion(drawn, table))),
    made("a numbered item far after a table of numbered items", asFetched(buildTab([
      ...filler("Lead", 5), listed("First"), ...filler("Mid", 12), item("Later item", "N1"), ...filler("Tail", 4),
    ], NUMBERED_LIST)), drawn => rowAndDeletion(drawn, 0)),
    made("an ordered list in a table far after a table of numbered items", asFetched(buildTab([
      ...filler("Lead", 5), listed("First"), ...filler("Mid", 12), listed("Second"), ...filler("Tail", 4),
    ], NUMBERED_LIST)), drawn => [0, 1].flatMap(table => rowAndDeletion(drawn, table))),
    made("the cells a tab may hold", asFetched(buildTab([
      ...filler("Lead", 4), grid(["Small a", "Small b"], ["Small c", "Small d"]), ...filler("Mid", 10),
      ...Array.from({ length: 10 }, (_, at) => [sized(at === 9 ? 24 : 25, 20, `t${at}r`), para(`Between ${at}.`)]).flat(),
    ])), drawn => {
      let expected = expectedOf(drawn, 0);
      let rows = (count: number): TableDraw => ({
        kind: "insertTableRows", beside: none,
        change: { type: "insertTableRows", at: 2, cells: newCells(count, 2, `Fit${count}`), expected },
        call: { method: "insertTableRows", lines: { table: 0, cells: newCells(count, 2, `Fit${count}`) } },
      });
      let table = (size: number): TableDraw => ({
        kind: "insertTable", beside: none,
        change: { type: "insertTable", rows: size, columns: 4, cells: newCells(size, 4, ""), after: "Lead filler 1." },
        call: { method: "insertTable", table: { rows: size, columns: 4, after: "Lead filler 1." } },
      });
      return [rows(1), rows(8), rows(9), table(4), table(5), {
        kind: "insertTableColumns", beside: none,
        change: { type: "insertTableColumns", at: 0, cells: newCells(2, 9, "Wide"), expected },
        call: { method: "insertTableColumns", lines: { table: 0, at: 0, count: 9 } },
      }];
    }),
    made("an anchor that stands twice", asFetched(buildTab([
      para("Echo line."), ...filler("Lead", 12), grid(["Cell a"]), ...filler("Tail", 12), para("Echo line."),
      para("End."),
    ])), () => ["Echo line.", "\nEcho line.", "Lead filler 3.", "Nowhere line."].map((after): TableDraw => ({
      kind: "insertTable", beside: none,
      change: { type: "insertTable", rows: 1, columns: 1, cells: [["x"]], after },
      call: { method: "insertTable", table: { rows: 1, columns: 1, cells: [["x"]], after } },
    }))),
  ];
  /** A table added after table `table`, named by the table's whole HTML. */
  let after = (drawn: ReturnType<typeof renderedOf>, table: number): TableDraw => {
    let { mdStart, mdEnd } = drawn.rendering.sourceMap.tables[table];
    let html = drawn.rendering.markdown.slice(mdStart, mdEnd);
    return {
      kind: "insertTable", beside: none,
      change: { type: "insertTable", rows: 1, columns: 1, cells: [["x"]], after: html },
      call: { method: "insertTable", table: { rows: 1, columns: 1, cells: [["x"]], after: html } },
    };
  };
  let ends = (drawn: ReturnType<typeof renderedOf>) => drawn.rendering.sourceMap.tables.flatMap(
    (_, table) => [...rowAndDeletion(drawn, table), after(drawn, table)]);
  cases.push(
    made("a table that opens the body", asFetched(buildTab([
      grid(["Open a", "Open b"]), ...filler("Mid", 10), grid(["Far a", "Far b"]), ...filler("Tail", 6),
    ])), ends),
    made("tables before the tab's last paragraph", asFetched(buildTab([
      ...filler("Lead", 9), grid(["Near a", "Near b"]), para("Between."), grid(["Last a", "Last b"]),
      para("Last."),
    ])), ends),
    made("a table before the empty paragraph a tab ends in", asFetched(buildTab([
      ...filler("Lead", 9), grid(["End a", "End b"], ["End c", "End d"]), para(""),
    ])), ends));
  let several = asFetched(buildTab([
    ...filler("Lead", 5), sized(3, 3, "a"), ...filler("Mid", 6), sized(4, 2, "b"), para(""),
    sized(2, 4, "c"), ...filler("Tail", 5),
  ]));
  cases.push(made("tables of several rows and columns", several, () => pieceTableEdits(
    { name: "tables of several rows and columns", tab: several, shapes: new Set(), marks: new Map() },
    DEFAULT_CORPUS.seed + 1, 40)));
  // A cell that spans two columns: the merge made in a table by the model, as Google makes it.
  let plain = asFetched(buildTab([
    ...filler("Lead", 8), sized(3, 3, "m"), ...filler("Tail", 8),
  ]));
  let merge: TableChange = {
    type: "mergeTableCells", row: 0, column: 0, rows: 1, columns: 2, expected: expectedOf(renderedOf(plain), 0),
  };
  let merged = applyDocsRequests(
    plain, tabTableChangeRequests(wholeTabReading(renderedOf(plain).rendering), merge).requests);
  cases.push(made("a merged cell", merged, drawn => {
    let expected = expectedOf(drawn, 0);
    return [
      {
        kind: "unmergeTableCells", beside: none, change: { type: "unmergeTableCells", row: 0, column: 0, expected },
        call: { method: "unmergeTableCells", cell: { table: 0, row: 0, column: 0 } },
      },
      {
        kind: "unmergeTableCells", beside: none, change: { type: "unmergeTableCells", row: 1, column: 1, expected },
        call: { method: "unmergeTableCells", cell: { table: 0, row: 1, column: 1 } },
      },
      {
        kind: "mergeTableCells", beside: none,
        change: { type: "mergeTableCells", row: 1, column: 0, rows: 2, columns: 2, expected },
        call: { method: "mergeTableCells", cells: { table: 0, row: 1, column: 0, rows: 2, columns: 2 } },
      },
      {
        kind: "mergeTableCells", beside: none,
        change: { type: "mergeTableCells", row: 0, column: 1, rows: 2, columns: 2, expected },
        call: { method: "mergeTableCells", cells: { table: 0, row: 0, column: 1, rows: 2, columns: 2 } },
      },
      {
        kind: "insertTableColumns", beside: none,
        change: { type: "insertTableColumns", at: 1, cells: newCells(3, 1, "Across"), expected },
        call: { method: "insertTableColumns", lines: { table: 0, at: 1 } },
      },
      {
        kind: "deleteTableColumns", beside: none,
        change: { type: "deleteTableColumns", at: 1, count: 1, expected },
        call: { method: "deleteTableColumns", lines: { table: 0, at: 1 } },
      },
      ...rowAndDeletion(drawn, 0),
    ];
  }));
  return cases;
}
