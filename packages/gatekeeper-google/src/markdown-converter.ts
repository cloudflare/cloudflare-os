// Bidirectional conversion between Google Docs structure and Markdown,
// with source mapping to allow Markdown-level edits to be translated back
// to Google Docs batchUpdate operations.

import type {
  GoogleDocsRequest, GoogleDocsTab, Paragraph, ParagraphElement, StructuralElement, Table,
  TableCell, TextRun, TextStyle,
} from "./docs-api";
import {
  atGraphemeBoundary, BULLET_PRESETS, CHIP_PLACEHOLDER, holdsOwnSuggestion, holdsSuggestion,
  isGoogleDocsStrippedCharacter, joinsGraphemes, LIST_LEVELS, loneChipCopy, madeByPreset,
  wholeFootnoteNumber,
} from "./docs-content";
import { lookOfTable, renderLook } from "./docs-table-look";
import type { TableLook } from "./docs-table-look";

// ---------------------------------------------------------------------------
// Source map types
// ---------------------------------------------------------------------------

/**
 * The Markdown rendering of one document tab, with the map back to that tab's indices.
 *
 * Every tab body has its own index space, so a snapshot is only ever valid for the tab it was
 * built from — Markdown, source map and end index all restart per tab.
 */
export type DocTabSnapshot = {
  /** The tab this rendering came from; every write derived from it must carry this ID. */
  tabId: string;
  /** Tab name, as shown in the Docs tab list. */
  title: string;
  /** The containing tab, absent for a top-level tab. */
  parentTabId?: string;
  /** Position among the tabs sharing this parent. */
  index: number;
  /** Depth in the tab tree; 0 for a top-level tab. */
  nestingLevel: number;
  /** The Markdown rendering of this tab's content. */
  markdown: string;
  /** Maps Markdown positions back to this tab's Google Docs character indices. */
  sourceMap: SourceMap;
  /** The endIndex of the last structural element in this tab's body. */
  bodyEndIndex: number;
  /**
   * Set on a rendering of a PART of the tab: consecutive whole body elements, `markdown`
   * theirs alone and every Markdown offset of `sourceMap` counted from its start, with the
   * document indexes and `bodyEndIndex` the tab's own. Absent on a rendering of the whole
   * tab. `isBlankDocTab` is never asked of a part: blankness is the tab's.
   */
  part?: DocTabPart;
}

/** Where a rendering of a part of a tab stands in the tab. */
export type DocTabPart = {
  /** Where the piece's Markdown starts in the tab's Markdown. */
  readonly mdStart: number;
  /** How many of the tab's tables stand before the piece. */
  readonly tablesBefore: number;
  /** Whether the piece's first element is the tab's first. */
  readonly first: boolean;
  /** Whether the piece's last element is the tab's last. */
  readonly last: boolean;
  /**
   * The document indexes between the piece's outermost elements: from where its first
   * element ends to where its last element starts. A batch built from the piece names no
   * index outside it on a side where the tab goes on.
   */
  readonly inner: { readonly from: number; readonly to: number };
  /** The reading of the tab the piece was cut for: what answers for the rest of the tab. */
  readonly tab: TabReading;
};

/**
 * What the request builders, their checks and the cards ask of a tab AS A WHOLE, each
 * answered without the tab's rendering in hand: from a whole rendering (`wholeTabReading`)
 * or from stored rows (`storedTabReading`). Made for ONE SYNCHRONOUS STRETCH. Every offset
 * and number it answers or is handed is the tab's own.
 */
export type TabReading = {
  /** The id of the tab read, as the refusals name it. */
  readonly tabId: string;
  /** Whether the tab is blank: `isBlankDocTab` of its whole rendering. */
  blank(): boolean;
  /**
   * Where `text` stands in the tab's Markdown where it stands exactly once; `"none"` or
   * `"many"` otherwise (two places that overlap are two). With `lineBreakBefore`, the
   * Markdown is searched as if a line break stood before it, and a place that starts at
   * that line break is -1. `text` is not empty.
   */
  find(text: string, lineBreakBefore?: boolean): number | "none" | "many";
  /** How many tables the tab holds, and their cells in all (`tableCellCount` of each). */
  tables(): { readonly count: number; readonly cells: number };
  /** The numbers, from 0, of the first two tables whose HTML has `shape` (`tableShape`). */
  tablesShaped(shape: string): readonly number[];
  /**
   * Whether, after table `table`, a later table's HTML holds an ordered list or a paragraph
   * of the body is an item of a numbered list.
   */
  numberedAfter(table: number): boolean;
  /**
   * The nearest line that ends before Markdown offset `mdStart`, a line start, that is not
   * empty and not part of a table, without its line break; `undefined` where there is none.
   */
  lineBefore(mdStart: number): string | undefined;
  /**
   * A rendering that holds the closure of `own` (`closureOf`), with `part` set. A whole
   * rendering answers itself. Throws what the reading throws for a tab it cannot read.
   */
  piece(own: OwnRange): DocTabSnapshot;
};

/**
 * Whether the tab's named styles give a subtitle's text italic, resolved over normal text's.
 * Without its named styles, a subtitle is taken to be italic, as Google's older default is.
 */
function givesSubtitleItalic(namedStyles: GoogleDocsTab["namedStyles"]): boolean {
  if (!namedStyles?.styles) return true;
  let normal = namedStyles.styles.find(style => style.namedStyleType === "NORMAL_TEXT")?.textStyle;
  return namedStyles.styles.some(style => style.namedStyleType === "SUBTITLE" &&
    (style.textStyle?.italic ?? normal?.italic) === true);
}

export type SourceMap = {
  /** One entry per editable paragraph/heading/list item, in document order. */
  blocks: BlockMapping[];
  /** Rendered structural content that `replaceText()` must not modify or cross. */
  protectedRanges: MarkdownRange[];
  /** One entry per top-level table, in document order. */
  tables: TableMapping[];
}

/** A half-open range in the rendered Markdown string. */
export type MarkdownRange = { mdStart: number; mdEnd: number };

/** A table of a tab: where its HTML is in the rendering, where it is in the tab, and its cells. */
export type TableMapping = MarkdownRange & {
  /** Where the table starts in the tab's index space. */
  docStart: number;
  /** Where the table ends in the tab's index space, exclusive. */
  docEnd: number;
  /** The table's look, as its tags write it. */
  look: TableLook;
  /** Its rows, in order. */
  rows: TableRowMapping[];
  /** How many rows, from the first, the table pins as its header; absent when it pins none. */
  pinnedRows?: number;
  /**
   * How many suggestions the table holds: each suggested insertion or deletion of the table, of
   * a row of it or of a cell of it, each suggested change to a row's or a cell's style, each
   * suggestion on the text and the paragraphs of its cells, and those of a table inside one of
   * its cells. Absent when it holds none.
   */
  suggested?: number;
};

/** One row of a table: its lines in the rendering, `  <tr…>` through `  </tr>` and its line break. */
type TableRowMapping = MarkdownRange & {
  /** Where the row starts in the tab's index space; its first cell starts one index later. */
  docStart: number;
  /** Where the row ends in the tab's index space, exclusive: the end of its last cell. */
  docEnd: number;
  /** Its cells in order, those a merged cell covers included. */
  cells: TableCellMapping[];
};

/** One cell: its lines in the rendering, its last line break included, and what it holds. */
export type TableCellMapping = MarkdownRange & {
  /** Where the cell starts in the tab's index space. */
  docStart: number;
  /** How many rows the cell spans, as its tag writes it (`rowspan`); 1 where the tag has none. */
  rowSpan: number;
  /** How many columns the cell spans, as its tag writes it (`colspan`); 1 where the tag has none. */
  columnSpan: number;
  /** Whether the cell holds a table. */
  nested: boolean;
  /** The cell's paragraphs as the HTML shows them, one for each line of its content. */
  lines: number;
  /** Whether one of those lines is an empty paragraph (`<p></p>`). */
  emptyParagraph: boolean;
  /**
   * Set when the table, the cell's row or the cell is itself a suggested insertion or deletion,
   * which Google marks on them and not on the text. None of the cell's text is editable: an edit
   * made outside suggesting mode would change what the suggestion inserts or deletes.
   */
  inSuggestion?: true;
  /** The cell's editable texts, in order; none for a cell that holds a table. */
  texts: TableTextMapping[];
  /** What suggestions the cell's paragraphs hold, those that hold any; absent for none. */
  suggested?: ParagraphSuggestions[];
  /** Whether the cell holds an item of a list that numbers any of its levels. */
  numbered: boolean;
  /** Whether the cell holds a footnote reference. */
  footnote: boolean;
  /** Whether a paragraph of the cell anchors a positioned object, which reads as `[Image]`. */
  positioned: boolean;
  /**
   * Whether the cell starts with anything but a paragraph of normal text outside a list: a
   * heading, a title, a subtitle, a list item, or no paragraph at all. A cell added beside it
   * is reset to a plain paragraph; beside any other cell it keeps the look Google copies.
   */
  styled: boolean;
  /**
   * Whether the cell is one paragraph that holds a smart chip, or another element that is
   * neither text nor an inline image, and no text beside it. Google Docs copies a chip that
   * stands alone in a cell into a row added beside the cell.
   */
  loneChip: boolean;
  /**
   * What Google Docs is seen copying into a row added beside a cell of chips and no text: a
   * dropdown of the same choices for a dropdown, the placeholder character (one index each) for
   * one person chip, date chip, rich link or placeholder, and nothing for several. Absent for
   * every other cell, and for chips in a shape nobody has seen copied.
   */
  copies?: "dropdown" | "placeholder" | "nothing";
  /**
   * How many elements the cell holds that the rendering shows nothing for: a dropdown, or a
   * smart chip that has no text of its own. A cell that holds nothing else reads as an empty
   * cell.
   */
  unshown: number;
};

/** An editable text of a cell: the HTML between the tags of its paragraph. */
type TableTextMapping = MarkdownRange & {
  /** The start index of the paragraph that holds it. */
  docStart: number;
};

/**
 * Version of the Markdown a tab reads as: the version an edit records it was previewed under.
 * Bump it whenever that Markdown changes, so an edit queued against what an earlier version
 * showed is told apart. A bump also has to decide which earlier versions
 * {@link REPLAYABLE_TEXT_EDIT_VERSIONS} keeps.
 */
export const MARKDOWN_RENDERING_VERSION = 8;

/**
 * Earlier rendering versions whose text edits (a replacement outside tables, an append) still
 * replay under {@link MARKDOWN_RENDERING_VERSION}, because they render everything outside tables
 * as it does. Decide this list again with every bump. Not 6: it read a subtitle whose named style
 * is upright as italic, so a quote that was unique under 6 can be unique under 7 as another
 * paragraph's, and the edit would change text its preview did not show changing. 7 showed text
 * a suggestion inserts or deletes without its marks and is otherwise 8: a quote of it that
 * crosses where a mark now stands is found nowhere, and one beside the marks is where it was.
 */
export const REPLAYABLE_TEXT_EDIT_VERSIONS: readonly number[] = [7];

type ListType = "bullet" | "numbered";

/** The preset `createParagraphBullets` is sent with for a new list item of each kind. */
const BULLET_PRESET = {
  bullet: "BULLET_DISC_CIRCLE_SQUARE", numbered: "NUMBERED_DECIMAL_ALPHA_ROMAN",
} as const;

export type BlockMapping = {
  /** Range in the Markdown string [mdStart, mdEnd). */
  mdStart: number;
  mdEnd: number;
  /** Range in Google Docs index space [docStart, docEnd). */
  docStart: number;
  docEnd: number;
  /** Paragraph structure needed to preserve inline-only edits. */
  namedStyleType: string;
  listType: ListType | null;
  listNestingLevel: number;
  /** Provider list identity, used only when the whole list can be preserved in place. */
  listId?: string;
  /** Set when a positioned object is anchored to this paragraph. */
  positioned?: true;
  /**
   * Set for an item of a bulleted or numbered list that the preset a new item of its kind is
   * bulleted with did not make (`madeByPreset`): a new item does not join such a list.
   */
  offPreset?: true;
  /**
   * Set when the paragraph's text starts with a tab, which `createParagraphBullets` would read
   * as nesting and remove were the paragraph made a list item again.
   */
  tabbed?: true;
  /** What suggestions the paragraph holds; absent when it holds none. */
  suggested?: ParagraphSuggestions;
  /** Fine-grained segments within this block. */
  segments: Segment[];
}

/**
 * What suggestions one paragraph holds, which a text edit may not touch: an edit made outside
 * suggesting mode would discard them, or make its own text part of one.
 */
export type ParagraphSuggestions = {
  /** Where the paragraph starts in the tab's index space. */
  docStart: number;
  /** Where it ends, exclusive: after its final line break. */
  docEnd: number;
  /** Set when a suggestion changes the paragraph's style or its bullet. */
  own?: true;
  /** The ranges of its text runs that a suggestion inserts, deletes or restyles, in order. */
  runs: readonly { readonly docStart: number; readonly docEnd: number }[];
};

/**
 * A segment maps a range of Markdown characters to Google Docs characters.
 * Content segments have a 1:1 character mapping (since we emit the raw text
 * from the doc). Syntax-only segments represent Markdown syntax characters
 * (like "**", "# ", "- ") that don't exist in the doc.
 */
export type Segment =
  | { mdStart: number; mdEnd: number; docStart: number; docEnd: number; textStyle: TextStyle }
  | { mdStart: number; mdEnd: number; syntaxOnly: true };

type ParagraphListItem = {
  listId: string;
  /** How this level renders; null means it has no marker. */
  listType: ListType | null;
  glyphType: string | undefined;
  glyphSymbol: string | undefined;
  nestingLevel: number;
  startNumber: number;
};
type VisibleParagraphElement = {
  text: string;
  style: TextStyle;
  link?: string;
};

// ---------------------------------------------------------------------------
// Google Docs → Markdown
// ---------------------------------------------------------------------------

const NOT_A_LINE_BREAK = /[^\n]/;

/**
 * Accumulates the rendered Markdown together with the source-map segments of the block being
 * emitted, so every emit site records its own mapping instead of restating the bookkeeping.
 */
class MarkdownWriter {
  text = "";
  /** Segments of the block being emitted; replaced at every block boundary. */
  segments: Segment[] = [];
  /**
   * Whether text given since this was last cleared holds a character that is no line break;
   * set until it is first cleared. Only a pass that tells its elements clears it
   * (`ElementsTold`), and while it is set an emit tests nothing: a pass that tells none reads
   * no text it writes. It is told from the text each emit is GIVEN and never from `text`:
   * reading the Markdown written so far would copy it into one string at every element. The
   * test copies a given text likewise where that is a concatenation, so an emit of one whose
   * text is known sets this first (a structure's).
   */
  wroteText = true;

  /** `start` is where this writer's text starts in the Markdown it is a part of. */
  constructor(private readonly start = 0) {}

  /** Where the next character goes in the whole Markdown: every offset mapped is one of these. */
  get length(): number {
    return this.start + this.text.length;
  }

  /** Start a block, returning the array its segments are collected into. */
  beginBlock(): Segment[] {
    return this.segments = [];
  }

  /** Emit text that belongs to no segment. */
  append(text: string): void {
    this.text += text;
    this.#notes(text);
  }

  /** Emit Markdown syntax that has no counterpart in the document. */
  syntax(markdown: string): void {
    let mdStart = this.length;
    this.text += markdown;
    this.#notes(markdown);
    this.segments.push({ mdStart, mdEnd: this.length, syntaxOnly: true });
  }

  /** Emit text mapping 1:1 onto the document characters starting at `docStart`. */
  mapped(text: string, docStart: number, textStyle: TextStyle): void {
    if (!text) return;
    let mdStart = this.length;
    this.text += text;
    this.#notes(text);
    this.segments.push({
      mdStart, mdEnd: this.length, docStart, docEnd: docStart + text.length, textStyle,
    });
  }

  #notes(given: string): void {
    if (!this.wroteText && NOT_A_LINE_BREAK.test(given)) this.wroteText = true;
  }
}

/**
 * Whether `render` is of a tab with no content: no text and nothing protected. An append to such
 * a tab writes the tab's whole text, where to any other it adds a paragraph after the last. A
 * tab whose only content renders as nothing (a chip with no label) is protected, so it is not
 * blank. Empty Markdown counts as `"\n"` does: a tab keeps its final paragraph whatever is
 * removed from it.
 */
export function isBlankDocTab(render: Pick<DocTabSnapshot, "markdown" | "sourceMap">): boolean {
  return (render.markdown === "" || render.markdown === "\n") &&
    render.sourceMap.protectedRanges.length === 0;
}

/** What the rendering reads of a tab beside its body: its lists and its named styles. */
export type RenderContext = Pick<GoogleDocsTab, "lists" | "namedStyles">;

/**
 * What the rendering of a tab carries from the elements before a run into the run: everything
 * an element reads of the elements before it, and nothing else. This is the carry AS A READER
 * IS HANDED IT: the carry of one pass over the tab's runs (`PassCarry`), which the pass moves
 * in place past each run. Whoever is handed it reads it before the pass moves again and keeps
 * nothing of it; what must outlive the move is taken then, as a copy of what it needs (a run's
 * key, `runCarryKey`, holds only what the run shows of the carry). Written one way:
 * `continuedListLevels` is empty without a `previousListId` and ends with no `false`; a list's
 * numbers end with no `null`, and a list with none is left out.
 */
export type RenderCarry = {
  /** Whether anything is written yet: what is written first takes no blank line before it. */
  readonly hasOutput: boolean;
  /** Whether the last protected range ends where the Markdown written so far ends. */
  readonly abutsProtected: boolean;
  /** The list of the last paragraph; absent after a paragraph outside a list or a structure. */
  readonly previousListId?: string;
  /** The levels of that list written since another block last interrupted it. */
  readonly continuedListLevels: readonly boolean[];
  /**
   * The last number given at each level of each list that holds one, `null` for none: asked
   * by the list's id and by nothing else (a reader never lists a carry's lists), of a map,
   * since an id may be a name every object inherits.
   */
  readonly listNumbers: Pick<ReadonlyMap<string, readonly (number | null)[]>, "get">;
  /**
   * How many footnote references the elements before hold, those of table cells included. The
   * renderer counts it and does not read it: a stored run holds its footnote numbers counted
   * from it, and the decoder (`decodeRun`) adds it back.
   */
  readonly footnoteBase: number;
};

/**
 * THE CARRY OF ONE PASS over a tab's runs, in order: made for the pass (`initialCarry`), owned
 * by it and moved in place past each run (`advanceCarry`), so that a run costs the lists it
 * counts in and never the lists counted so far. Its arrays (a list's numbers, the continued
 * levels) are replaced when they move and never changed in place.
 */
export type PassCarry = {
  -readonly [Part in keyof Omit<RenderCarry, "listNumbers">]: RenderCarry[Part];
} & { readonly listNumbers: Map<string, readonly (number | null)[]> };

/** The carry of a tab's first run, for a pass to own: a carry of its own at every call. */
export function initialCarry(): PassCarry {
  return {
    hasOutput: false, abutsProtected: false, continuedListLevels: [], listNumbers: new Map(),
    footnoteBase: 0,
  };
}

/** Where a run stands in its tab's rendering. */
export type RunPlace = {
  /** Where the run's Markdown starts in the tab's Markdown: its map is written from there. */
  readonly mdStart: number;
  /** Whether the pass also says what each element writes (`RenderedRun.elements`). */
  readonly elements?: boolean;
};

/** An element writes line breaks alone. Neither this nor `ELEMENT_TEXT`: it writes nothing. */
export const ELEMENT_BREAKS = 1;
/** An element writes at least one character that is no line break. */
export const ELEMENT_TEXT = 2;
/** One entry of `sourceMap.blocks` is the element's (a paragraph has one). */
export const ELEMENT_BLOCK = 4;
/** One entry of `sourceMap.tables` is the element's. */
export const ELEMENT_TABLE = 8;
/** One entry of `sourceMap.protectedRanges` is the element's. */
export const ELEMENT_PROTECTS = 16;
/** The element is a paragraph that is an item of a list at a level deeper than 0. */
export const ELEMENT_DEEP = 32;

/** What each body element of a run writes, told by the pass that renders the run. */
export type RunElements = {
  /**
   * For each element, in order, where its Markdown starts in the tab's Markdown as `at`
   * places the run: the blank line written before it is the element's. An element that
   * writes nothing starts where the next one does, or where the run's Markdown ends.
   */
  readonly starts: Uint32Array;
  /**
   * For each element, the sum of the `ELEMENT_*` that hold of it. The entries of the source
   * map's three lists are the elements' in order, so the k-th element with `ELEMENT_BLOCK`
   * owns the k-th block, and likewise a table and a protected range.
   */
  readonly flags: Uint8Array;
};

/** One run rendered. */
export type RenderedRun = {
  /** The run's Markdown: the tab's Markdown is its runs' joined, in order. */
  readonly markdown: string;
  /**
   * The run's part of the source map, in the tab's index space (the elements' own indexes) and
   * in the tab's Markdown (as `at` places the run): the tab's map is its runs' three lists
   * joined, in order.
   */
  readonly sourceMap: SourceMap;
  /**
   * The one thing a run writes backwards: set when the last protected range BEFORE the run
   * ends one character later than its own run said, at the blank line this run starts with.
   * Whoever joins source maps adds 1 to that range's `mdEnd` before appending this run's.
   */
  readonly extendsProtected: boolean;
  /**
   * What the run needs of any carry and does to it (`RunSummary`): the same whatever `carry`
   * this rendering was made with, so it keys the run (`runCarryKey`, `runContextKey`) and
   * moves past it (`advanceCarry`) every carry the run is entered with.
   */
  readonly summary: RunSummary;
  /** What each element of the run writes. Set where `at.elements` asked. */
  readonly elements?: RunElements;
};

/** One level of one list whose carried number a run shows. */
export type CarriedLevel = {
  readonly listId: string;
  readonly level: number;
  /** The level's start number: the number shown is this where nothing is carried for it. */
  readonly start: number;
};

/** What a run does to one list's numbers. */
export type ListEffect = {
  /** The carried levels below this one are kept; those from it on are replaced by `tail`. */
  readonly keep: number;
  /** How many numbers the run gives at level `keep - 1`, on top of the carried one. */
  readonly add: number;
  /** The start number of level `keep - 1`, for a list with no carried number there. */
  readonly start: number;
  /** The numbers of the levels from `keep` on after the run, `null` for none. */
  readonly tail: readonly (number | null)[];
};

/**
 * What `renderRun` says of a run whatever is carried into it: what its rendering needs of the
 * carry, and what it does to the carry. A function of the run's elements and of the
 * definitions of the lists they name, and of nothing else: the same for a run wherever it
 * stands AND WHATEVER CARRY IT IS RENDERED WITH. It says what the run would show of any carry,
 * never what it showed of this one: a level is listed in `lead` whether or not this carry
 * continues it, and in `counters` whether or not this carry holds a number for it. So the
 * summary stored with one rendering of a run advances and keys every other carry the run is
 * ever entered with. Plain data that survives JSON.
 */
export type RunSummary = {
  /** Whether the run writes anything. */
  readonly emits: boolean;
  /** What it writes first; absent where it writes nothing. */
  readonly firstWrites?: "paragraph" | "structure";
  /**
   * Set when the first block written is a list item: its list, and the numbered levels whose
   * leading items show the carried number unless the carry says the level is continued.
   */
  readonly lead?: { readonly listId: string; readonly levels: readonly CarriedLevel[] };
  /** The levels whose carried number the run shows whatever the carry says. */
  readonly counters: readonly CarriedLevel[];
  /** How many footnote references the run holds, those of table cells included. */
  readonly footnotes: number;
  /**
   * How many of them hold a whole number (`wholeFootnoteNumber` of `docs-content.ts`, the one
   * definition): the references whose number the stored form counts from the run's start, so
   * the ones whose rendering moves with `carry.footnoteBase`.
   */
  readonly numberedFootnotes: number;
  /** The lists the run names, body and cells, sorted. */
  readonly listIds: readonly string[];
  /** Whether the run holds a subtitle. */
  readonly subtitle: boolean;
  /** What it writes last: text, or something protected. Absent where it writes nothing. */
  readonly lastWrites?: "text" | "protected";
  /** The list of the last block written, where it is a list item. */
  readonly endListId?: string;
  /**
   * The continued levels after the run: fixed by the run (`lead: false`), or, where every
   * block of the run continues the list it leads with, the carried levels below `min` (kept
   * where the carry's list is that list) followed by `tail`.
   */
  readonly levels:
    | { readonly lead: true; readonly min: number; readonly tail: readonly boolean[] }
    | { readonly lead: false; readonly fixed: readonly boolean[] };
  /** What the run does to the numbers of each list it counts in. */
  readonly lists: { readonly [listId: string]: ListEffect };
};

/**
 * What the pass over a run counts as it renders. The last number given at each level of each
 * list: the carried numbers, a list's copied the first time the run counts in it, so the
 * carry is never changed. And what the run's summary says of its lists, its footnotes and its
 * subtitles, each noted where the pass reads it and none taken from the carry.
 */
class RunTally {
  /** How many footnote references the paragraphs noted hold. */
  footnotes = 0;
  /** How many of them hold a whole number. */
  numberedFootnotes = 0;
  /** Whether a paragraph noted is a subtitle. */
  subtitle = false;
  /**
   * Each list the run counts in: its levels, the lowest level the run shortened it to
   * (`keep - 1`), how many numbers the run gave at that level and the level's start number.
   */
  #lists = new Map<string, {
    levels: (number | null)[]; keep: number; add: number; start: number;
  }>();
  /** The levels whose carried number the run shows, each once. */
  #shown = new Map<string, CarriedLevel>();

  constructor(private readonly carried: RenderCarry["listNumbers"]) {}

  /**
   * Counts `item`, in document order, and answers its number where its level is numbered. Its
   * list's levels are shortened to the item's, so the levels from `keep` on hold only what the
   * run counted, and a number given at level `keep - 1` is one more on top of the carried one.
   * A carried `null` reads as a level with no number.
   */
  count(item: ParagraphListItem): number | undefined {
    let { listId, nestingLevel } = item;
    let list = this.#lists.get(listId);
    if (!list) {
      let levels = [...this.carried.get(listId) ?? []];
      list = { levels, keep: Infinity, add: 0, start: 1 };
      this.#lists.set(listId, list);
    }
    list.levels.length = nestingLevel + 1;
    if (nestingLevel + 1 < list.keep) {
      list.keep = nestingLevel + 1;
      list.add = 0;
      list.start = item.startNumber;
    }
    if (item.listType !== "numbered") return undefined;
    let number = (list.levels[nestingLevel] ?? item.startNumber - 1) + 1;
    list.levels[nestingLevel] = number;
    if (nestingLevel + 1 === list.keep) list.add++;
    return number;
  }

  /**
   * Notes that the run shows the number `count` just gave `item`. Where no item the run
   * counted in that list before stands at a lower level, the number follows the carried one,
   * and the level is one whose carried number the run shows.
   */
  shows(item: ParagraphListItem): void {
    let { listId, nestingLevel: level, startNumber: start } = item;
    if (item.listType !== "numbered" || this.#lists.get(listId)?.keep !== level + 1) return;
    this.#shown.set(`${level} ${listId}`, { listId, level, start });
  }

  /** Notes a paragraph the run holds: whether it is a subtitle, and its footnote references. */
  notes(paragraph: Paragraph): void {
    if (paragraph.paragraphStyle.namedStyleType === "SUBTITLE") this.subtitle = true;
    for (let { footnoteReference } of paragraph.elements) {
      if (!footnoteReference) continue;
      this.footnotes++;
      if (wholeFootnoteNumber(footnoteReference.footnoteNumber) !== undefined) {
        this.numberedFootnotes++;
      }
    }
  }

  /** What the summary says of the run's lists: `listIds`, `counters` and `lists`. */
  summary(): Pick<RunSummary, "listIds" | "counters" | "lists"> {
    return {
      listIds: [...this.#lists.keys()].toSorted(),
      counters: [...this.#shown.values()],
      lists: Object.fromEntries(Array.from(this.#lists, ([listId, { levels, keep, add, start }]) => {
        let tail = Array.from(levels.slice(keep), number => number ?? null);
        return [listId, { keep, add, start, tail }];
      })),
    };
  }
}

/**
 * What a pass says of each element of its run (`RunElements`), where it is asked: made before
 * the first element, and told as the pass leaves each. An element's Markdown starts where the
 * writer stood when the element before it was left, since nothing is written between two.
 */
class ElementsTold implements RunElements {
  readonly starts: Uint32Array;
  readonly flags: Uint8Array;
  /** The element the pass is in, and where the writer stood as the pass entered it. */
  #element = 0;
  #start: number;

  constructor(private readonly writer: MarkdownWriter, length: number) {
    this.starts = new Uint32Array(length);
    this.flags = new Uint8Array(length);
    this.#start = writer.length;
    writer.wroteText = false;
  }

  /**
   * Notes the element the pass leaves. `owns` is the sum of the `ELEMENT_*` for the entries
   * it pushed and for a deeper list item; what it wrote is the writer's to say.
   */
  left(owns: number): void {
    let end = this.writer.length;
    this.starts[this.#element] = this.#start;
    this.flags[this.#element++] = owns |
      (end === this.#start ? 0 : this.writer.wroteText ? ELEMENT_TEXT : ELEMENT_BREAKS);
    this.#start = end;
    this.writer.wroteText = false;
  }
}

/**
 * Renders `elements`, consecutive elements of a tab's body with the indexes they have in the
 * tab, given what the elements before them leave (`carry`) and where their Markdown starts
 * (`at`). The runs of a body rendered in order, each with the carry of the one before, give
 * `docTabToMarkdown` of the tab exactly: the Markdown joined, the source maps joined, and the
 * last protected range before a run that `extendsProtected` ended one character later. It
 * reads no element outside `elements`, changes none, and reads of `context` the definitions of
 * the lists the elements name and, for a subtitle, whether the named styles give one italic.
 * It changes nothing it is handed, the carry included: the carry after the run is the pass's
 * to make, from the run's summary (`advanceCarry`). Where `at.elements` asks, the same pass
 * says what each element writes; where it does not, nothing is made for it.
 */
export function renderRun(
  elements: readonly StructuralElement[], context: RenderContext, carry: RenderCarry,
  at: RunPlace,
): RenderedRun {
  let writer = new MarkdownWriter(at.mdStart);
  let told = at.elements ? new ElementsTold(writer, elements.length) : undefined;
  let blocks: BlockMapping[] = [];
  let protectedRanges: MarkdownRange[] = [];
  let tables: TableMapping[] = [];
  let previousListId = carry.previousListId;
  let tally = new RunTally(carry.listNumbers);
  let continuedListLevels = [...carry.continuedListLevels];
  // Whether anything is written yet, by the elements before the run or by the run.
  let written = carry.hasOutput;
  let extendsProtected = false;
  let subtitleItalic = givesSubtitleItalic(context.namedStyles);
  // What the summary says of the run's blocks, noted as each is written and never read from
  // the carry. `leadMin` is the lowest level reached while every block written continues the
  // list the run leads with: `undefined` before a list item is written first and once a block
  // does not continue it. Only below that level does `continuedListLevels` hold what was
  // carried: from it on, and after another block, it holds what the run wrote.
  let firstWrites: RunSummary["firstWrites"];
  let lastWrites: RunSummary["lastWrites"];
  let lead: { listId: string; levels: CarriedLevel[] } | undefined;
  let leadMin: number | undefined;

  for (let elem of elements) {
    // A table's range is its HTML alone, without the blank line before or the line break after.
    let tableStart = writer.length + (written ? 1 : 0);
    let table = elem.table &&
      tableToHtml(elem.table, context.lists, tally, subtitleItalic, tableStart);
    let structure = table ? table.html
      : elem.tableOfContents ? "[Table of contents]"
      : elem.sectionBreak && elem.startIndex > 0 ? "[Section break]"
      : undefined;
    if (structure !== undefined) {
      let mdStart = writer.length;
      if (written) writer.append("\n");
      if (elem.table && table) {
        tables.push({
          mdStart: tableStart, mdEnd: tableStart + structure.length,
          ...tableDocMapping(elem, elem.table), look: table.look, rows: table.rows,
        });
      }
      // A structure's text is no line break. Said here and not found by the writer, whose
      // test would copy the concatenation, a table's HTML with it, into one string.
      writer.wroteText = true;
      writer.append(`${structure}\n`);
      written = true;
      protectedRanges.push({ mdStart, mdEnd: writer.length });
      previousListId = undefined;
      firstWrites ??= "structure";
      lastWrites = "protected";
      leadMin = undefined;
      told?.left(table ? ELEMENT_TABLE | ELEMENT_PROTECTS : ELEMENT_PROTECTS);
      continue;
    }
    if (!elem.paragraph) {
      told?.left(0);
      continue;
    }

    let para = elem.paragraph;
    let segments = writer.beginBlock();
    let docStart = elem.startIndex;
    let docEnd = elem.endIndex;

    let listItem = paragraphListItem(para, context.lists);
    let listNumber = nextOrderedListNumber(listItem, tally);
    let continuesList = listItem !== undefined && listItem.listId === previousListId;
    if (!continuesList) continuedListLevels.length = 0;
    let continuesListLevel = false;
    if (listItem) {
      continuedListLevels.length = listItem.nestingLevel + 1;
      continuesListLevel = !!continuedListLevels[listItem.nestingLevel];
      continuedListLevels[listItem.nestingLevel] = true;
    }
    let markdownListNumber = !continuesListLevel && listNumber !== 1 ? listNumber : undefined;

    tally.notes(para);
    // A list item written first leads the run, until a block does not continue its list.
    if (firstWrites === undefined && listItem) {
      lead = { listId: listItem.listId, levels: [] };
      leadMin = Infinity;
    } else if (!continuesList) {
      leadMin = undefined;
    }
    if (lead && leadMin !== undefined && listItem) {
      // A leading item at a level lower than any before it: whether its level is continued is
      // the carry's to say, and its number follows the carried one.
      if (listItem.nestingLevel < leadMin) {
        leadMin = listItem.nestingLevel;
        if (listItem.listType === "numbered") {
          lead.levels.push({
            listId: listItem.listId, level: leadMin, start: listItem.startNumber,
          });
        }
      }
    } else if (listItem && !continuesListLevel) {
      // Past the leading items the levels continued are the run's own: this one is not, so
      // the item shows its number.
      tally.shows(listItem);
    }
    let protects = !holdsOnlyText(para);
    firstWrites ??= "paragraph";
    lastWrites = protects ? "protected" : "text";

    // Blank line between blocks, except within one provider list.
    // A protected paragraph owns the preceding unmapped boundary.
    // The last protected range is this run's last or, while the run has written nothing, the
    // one the elements before it left. That one is out of this run's reach: where the blank
    // line joins it, the run says so (`extendsProtected`) to whoever joins the maps.
    let separatorStart = writer.length;
    let previousProtected = protectedRanges.at(-1);
    let abutsProtected = previousProtected ? previousProtected.mdEnd === separatorStart
      : carry.abutsProtected && writer.text === "";
    let protectedStart = abutsProtected || !written ? separatorStart : separatorStart - 1;
    if (written && !continuesList) {
      writer.append("\n");
      if (abutsProtected) {
        if (previousProtected) previousProtected.mdEnd = writer.length;
        else extendsProtected = true;
        protectedStart = writer.length;
      }
    }
    let mdStart = writer.length;

    // Paragraph prefix (heading markers, list markers, etc.).
    let prefix = getParagraphPrefix(para, listItem, markdownListNumber);
    if (prefix) writer.syntax(prefix);

    emitParagraphContent(para, writer, subtitleItalic);

    // Trailing newline. Every Google Docs paragraph ends with \n in the doc
    // character space. In Markdown, we use \n as the line terminator.
    // The paragraph's trailing \n is already included in the last text run's
    // content, and we handled it in emitParagraphContent by not emitting it.
    // Instead, we add our own Markdown newline here.
    writer.append("\n");
    written = true;

    let mdEnd = writer.length;
    if (protects) protectedRanges.push({ mdStart: protectedStart, mdEnd });
    let suggested = paragraphSuggestions(para, docStart, docEnd);
    blocks.push({
      mdStart, mdEnd, docStart, docEnd, segments,
      namedStyleType: para.paragraphStyle.namedStyleType,
      listType: listItem?.listType ?? null,
      listNestingLevel: listItem?.nestingLevel ?? 0,
      ...(listItem ? { listId: listItem.listId } : {}),
      ...(para.positionedObjectIds?.length ? { positioned: true as const } : {}),
      ...(para.elements[0]?.textRun?.content.startsWith("\t") ? { tabbed: true as const } : {}),
      ...(suggested ? { suggested } : {}),
      ...(listItem?.listType && !madeByPreset(
        context.lists[listItem.listId], BULLET_PRESETS[BULLET_PRESET[listItem.listType]],
      ) ? { offPreset: true as const } : {}),
    });
    previousListId = listItem?.listId;
    told?.left(ELEMENT_BLOCK | (protects ? ELEMENT_PROTECTS : 0) |
      (listItem?.listType && listItem.nestingLevel > 0 ? ELEMENT_DEEP : 0));
  }

  // After a list item the last level is the item's own, which is continued: it ends with no
  // `false`. A level skipped on the way down is a hole, written as `false`.
  let continued = previousListId === undefined ? [] : Array.from(continuedListLevels, Boolean);
  let emits = firstWrites !== undefined;
  return {
    markdown: writer.text,
    sourceMap: { blocks, protectedRanges, tables },
    extendsProtected,
    summary: {
      emits,
      ...(firstWrites === undefined ? {} : { firstWrites }),
      ...(lead ? { lead } : {}),
      footnotes: tally.footnotes,
      numberedFootnotes: tally.numberedFootnotes,
      subtitle: tally.subtitle,
      ...(lastWrites === undefined ? {} : { lastWrites }),
      // Before the run writes a block, the list and the levels are the carried ones.
      ...(emits && previousListId !== undefined ? { endListId: previousListId } : {}),
      levels: leadMin === undefined ? { lead: false, fixed: emits ? continued : [] }
        : { lead: true, min: leadMin, tail: continued.slice(leadMin) },
      ...tally.summary(),
    },
    // The two arrays alone: `told` holds the writer.
    ...(told ? { elements: { starts: told.starts, flags: told.flags } } : {}),
  };
}

/** Runs of a tab joined so far, in order: what `joinRenderedRun` appends to. */
export type JoinedRuns = Pick<DocTabSnapshot, "markdown" | "sourceMap"> & {
  /**
   * Set when a run joined so far ends the last protected range BEFORE the joined runs one
   * character later (`RenderedRun.extendsProtected`, where the joined runs hold no range):
   * always `false` for runs joined from a tab's first.
   */
  extendsProtected: boolean;
  /** Where the joined Markdown starts in the Markdown the runs were placed in. */
  readonly mdStart: number;
  /** Where each element joined starts (`RunElements.starts`), where every run joined said. */
  starts: number[];
  /** What each element joined writes and owns (`RunElements.flags`), likewise. */
  flags: number[];
};

/**
 * Runs joined so far: none, for runs joined from Markdown offset `mdStart` on. A part of a tab
 * is joined from the run it starts in, not from the tab's first.
 */
export function noRenderedRuns(mdStart = 0): JoinedRuns {
  return {
    markdown: "", sourceMap: { blocks: [], protectedRanges: [], tables: [] },
    extendsProtected: false, mdStart, starts: [], flags: [],
  };
}

/**
 * Appends `run` to `joined`, IN PLACE, as `renderRun` says runs join: the Markdown, the three
 * lists of the source map in order, and the last protected range joined so far ended one
 * character later where the run `extendsProtected`. `run` was rendered with `mdStart` where
 * the joined Markdown ends (`joined.mdStart + joined.markdown.length`), so `joined.markdown[i]`
 * is the character at offset `joined.mdStart + i` of the Markdown the runs were placed in, and
 * the offsets of the source map and of the elements' starts stay as the runs were placed.
 * Joining a tab's runs in order, each rendered with the carry of the one before, gives
 * `docTabToMarkdown` of the tab. A run's `elements` are appended where it has them.
 * @throws For a run without `elements` joined to runs that had them, a fault of the caller,
 * before anything of the run is joined.
 */
export function joinRenderedRun(joined: JoinedRuns, run: RenderedRun): void {
  if (!run.elements && joined.starts.length > 0) {
    throw new Error("A run that says nothing of its elements is joined to runs that do");
  }
  let ranges = joined.sourceMap.protectedRanges;
  if (run.extendsProtected) {
    let last = ranges.pop();
    if (last) ranges.push({ ...last, mdEnd: last.mdEnd + 1 });
    else joined.extendsProtected = true;
  }
  joined.markdown += run.markdown;
  for (let block of run.sourceMap.blocks) joined.sourceMap.blocks.push(block);
  for (let range of run.sourceMap.protectedRanges) ranges.push(range);
  for (let table of run.sourceMap.tables) joined.sourceMap.tables.push(table);
  if (run.elements) {
    for (let start of run.elements.starts) joined.starts.push(start);
    for (let flag of run.elements.flags) joined.flags.push(flag);
  }
}

/** How many elements of `flags[from, to)` own an entry of each list of the source map. */
function entriesOwned(
  flags: readonly number[], from: number, to: number,
): { blocks: number; protectedRanges: number; tables: number } {
  let blocks = 0, protectedRanges = 0, tables = 0;
  for (let element = from; element < to; element++) {
    if (flags[element] & ELEMENT_BLOCK) blocks++;
    if (flags[element] & ELEMENT_PROTECTS) protectedRanges++;
    if (flags[element] & ELEMENT_TABLE) tables++;
  }
  return { blocks, protectedRanges, tables };
}

/** Counts `range` from `by` characters later, in place. */
function movedBack(range: MarkdownRange, by: number): void {
  range.mdStart -= by;
  range.mdEnd -= by;
}

/**
 * The rendering of elements `[from, to)` of `joined`, runs rendered in order with their
 * elements told and joined: their Markdown alone, and the entries of the source map that
 * are theirs, every Markdown offset counted from the piece's start. `mdStart` is where the
 * piece starts in the Markdown the runs were placed in and `tablesBefore` how many joined
 * tables stand before it. It is what the same elements read as in a rendering of the whole
 * tab, moved, with the one thing an element writes backwards kept true: a protected range
 * that the element after the piece ended one character later ends where the piece ends,
 * and where the piece's first element starts with the blank line that ends the protected
 * range before the piece, the piece holds that character as a protected range of its own,
 * first. A protected range that starts at the line break before its paragraph's blank line
 * starts there still: one character before the piece (-1) where that paragraph is the
 * piece's first. THE MIRROR OF THAT IS NOT KEPT: where such a paragraph is the element after
 * the piece, its range covers the piece's last character in the whole tab, and the piece,
 * which holds no entry of that element, protects it by none. Whether a piece's last line
 * break is protected is so not the tab's answer while the tab goes on after the piece: a
 * caller keeps what it asks about away from the piece's last element. IT TAKES `joined`: the
 * entries are moved in place, and `joined` is not read again. The answer's Markdown is a
 * slice of the joined runs' and may keep that string alive: a caller joins only the runs
 * that hold the range.
 * @throws Where `[from, to)` is no range of the joined elements, or the elements told do
 * not own the entries joined one for one (runs joined that told nothing of theirs).
 */
export function pieceRendering(
  joined: JoinedRuns, from: number, to: number,
): Pick<DocTabSnapshot, "markdown" | "sourceMap"> & { mdStart: number; tablesBefore: number } {
  let { starts, flags, sourceMap } = joined;
  if (!(0 <= from && from <= to && to <= flags.length)) {
    throw new Error("A piece is no range of the elements joined");
  }
  let before = entriesOwned(flags, 0, from);
  let inside = entriesOwned(flags, from, to);
  let after = entriesOwned(flags, to, flags.length);
  if (starts.length !== flags.length ||
      before.blocks + inside.blocks + after.blocks !== sourceMap.blocks.length ||
      before.protectedRanges + inside.protectedRanges + after.protectedRanges !==
        sourceMap.protectedRanges.length ||
      before.tables + inside.tables + after.tables !== sourceMap.tables.length) {
    throw new Error("A piece is cut from runs that do not say what their elements write");
  }
  let joinedEnd = joined.mdStart + joined.markdown.length;
  let mdStart = starts[from] ?? joinedEnd;
  let length = (starts[to] ?? joinedEnd) - mdStart;
  let blocks = sourceMap.blocks.slice(before.blocks, before.blocks + inside.blocks);
  let protectedRanges = sourceMap.protectedRanges.slice(
    before.protectedRanges, before.protectedRanges + inside.protectedRanges);
  let tables = sourceMap.tables.slice(before.tables, before.tables + inside.tables);

  for (let block of blocks) {
    movedBack(block, mdStart);
    for (let segment of block.segments) movedBack(segment, mdStart);
  }
  for (let range of protectedRanges) movedBack(range, mdStart);
  for (let table of tables) {
    movedBack(table, mdStart);
    for (let row of table.rows) {
      movedBack(row, mdStart);
      for (let cell of row.cells) {
        movedBack(cell, mdStart);
        for (let text of cell.texts) movedBack(text, mdStart);
      }
    }
  }

  // The blank line an element starts with ends the protected range before it one character
  // later. Where that element stands after the piece, the character is not the piece's, and
  // the range ends with the piece. Where it is the first of the piece to write, the range is
  // not the piece's (an element joined before the piece owns it, or a run before those
  // joined), and the character is protected still.
  let last = protectedRanges.at(-1);
  if (last && last.mdEnd > length) last.mdEnd = length;
  let rangeBefore = sourceMap.protectedRanges[before.protectedRanges - 1];
  if (length > 0 && ((rangeBefore !== undefined && rangeBefore.mdEnd > mdStart) ||
      (joined.extendsProtected && mdStart === joined.mdStart))) {
    protectedRanges.unshift({ mdStart: 0, mdEnd: 1 });
  }

  return {
    markdown: joined.markdown.slice(mdStart - joined.mdStart, mdStart - joined.mdStart + length),
    sourceMap: { blocks, protectedRanges, tables },
    mdStart,
    tablesBefore: before.tables,
  };
}

/** The elements an edit changes or names, among elements in hand: `first` to `last`, inclusive. */
export type OwnElements = { readonly first: number; readonly last: number };

/** How an edit's own elements are named, in the tab's own units. */
export type OwnRange =
  /** The elements whose Markdown holds a character of `[mdStart, mdEnd)` of the tab's. */
  | { readonly markdown: MarkdownRange }
  /** The tab's table of that number, from 0. */
  | { readonly table: number }
  /** The tab's last element. */
  | "end";

/**
 * The first element of the closure of `first` among `flags` (`closureOf`'s steps back and
 * its walk, alone), or `undefined` where they ran out of the elements in hand while the tab
 * goes on before: what a scout of the runs before an edit asks. `tabFirst` says whether the
 * first of `flags` is the tab's first element. It answers for any `first`: one that is no
 * element in hand is stepped from as it stands, and one before them all ran out.
 */
export function closureStart(
  flags: ArrayLike<number>, first: number, tabFirst: boolean,
): number | undefined {
  let low = first;
  // A step ends ON an element that writes a character: one that is the first in hand ends
  // it as any other does. What runs out is a step, or the walk, that must go on past it.
  // Each test for the first in hand is one no number passes twice (`!(low > 0)`), so the
  // steps end for a `first` that is no element in hand too.
  for (let step = 0; step < 2; step++) {
    do {
      if (!(low > 0)) return tabFirst ? 0 : undefined;
      low--;
    } while (!(flags[low] & ELEMENT_TEXT));
  }
  // A list item deeper than level 0 is read with the element before it, whatever that is.
  while (flags[low] & ELEMENT_DEEP) {
    if (!(low > 0)) return tabFirst ? 0 : undefined;
    low--;
  }
  return low;
}

/**
 * The CLOSURE of an edit's own elements: the range of elements `[from, to)` a local
 * rendering must hold for the request builders to build from it what they build from the
 * whole tab. A step BACK from an element takes every element before it that writes nothing
 * or line breaks alone, and then the nearest that writes a character; a step FORWARD is the
 * same after it. The closure is two steps back from `own.first`; then, while its first
 * element is an item of a list at a level deeper than 0 (`ELEMENT_DEEP`), the element
 * before that one; and two steps forward from `own.last`. `flags` are those of runs joined
 * (`RunElements.flags`); `ends` says whether the first of them is the tab's first element
 * and the last the tab's last.
 * @returns The range, or `{ more }` where a step or the walk back through list items ran
 * out of the elements in hand on a side where the tab goes on: the caller loads more on
 * that side and asks again. `"before"` is answered first.
 */
export function closureOf(
  flags: ArrayLike<number>, own: OwnElements,
  ends: { readonly first: boolean; readonly last: boolean },
): { readonly from: number; readonly to: number } | { readonly more: "before" | "after" } {
  let from = closureStart(flags, own.first, ends.first);
  if (from === undefined) return { more: "before" };
  let end = flags.length - 1;
  let high = own.last;
  for (let step = 0; step < 2; step++) {
    do {
      if (!(high < end)) return ends.last ? { from, to: end + 1 } : { more: "after" };
      high++;
    } while (!(flags[high] & ELEMENT_TEXT));
  }
  return { from, to: high + 1 };
}

/** Convert one document tab to Markdown with a source map into that tab's index space. */
export function docTabToMarkdown(tab: GoogleDocsTab): DocTabSnapshot {
  let elements = tab.body.content;
  let { markdown, sourceMap } = renderRun(elements, tab, initialCarry(), { mdStart: 0 });
  return {
    tabId: tab.tabId,
    title: tab.title,
    ...tab.parentTabId === undefined ? {} : { parentTabId: tab.parentTabId },
    index: tab.index,
    nestingLevel: tab.nestingLevel,
    markdown,
    sourceMap,
    bodyEndIndex: elements.length > 0 ? elements[elements.length - 1].endIndex : 0,
  };
}

/**
 * Moves `carry` past a run, from the run's summary alone and with no element read: the pass's
 * carry is, after the call, what its next run is entered with. It reads and writes the lists
 * the run counts in (`summary.lists`) and no other, whatever the carry holds; a run that
 * writes nothing moves nothing. A list's numbers and the continued levels are replaced, never
 * changed in place, so whoever took one of those arrays before the move still holds what the
 * carry held then.
 */
export function advanceCarry(carry: PassCarry, summary: RunSummary): void {
  if (!summary.emits) return;
  let { endListId, levels } = summary;
  // Worked out of the carry's own parts before any of them is written.
  let continuedListLevels: readonly boolean[] = [];
  if (endListId === undefined) {
    // Nothing is continued after a paragraph outside a list or a structure.
  } else if (levels.lead) {
    let continues = carry.previousListId === summary.lead?.listId;
    continuedListLevels = [
      ...Array.from({ length: levels.min }, (_, level) =>
        continues && !!carry.continuedListLevels[level]),
      ...levels.tail,
    ];
  } else {
    continuedListLevels = levels.fixed;
  }

  for (let [listId, { keep, add, start, tail }] of Object.entries(summary.lists)) {
    // An empty entry reads as a list with none (`CarryBeside` holds one for such a list).
    let carried = carry.listNumbers.get(listId) ?? [];
    let after = Array.from({ length: keep }, (_, level) => carried[level] ?? null);
    if (add > 0) after[keep - 1] = (after[keep - 1] ?? start - 1) + add;
    after.push(...tail);
    // Written as a carry holds them: no `null` at the end, and no list with no number.
    while (after.length > 0 && after.at(-1) === null) after.pop();
    if (after.length > 0) carry.listNumbers.set(listId, after);
    else carry.listNumbers.delete(listId);
  }

  carry.hasOutput = true;
  carry.abutsProtected = summary.lastWrites === "protected";
  if (endListId === undefined) delete carry.previousListId;
  else carry.previousListId = endListId;
  carry.continuedListLevels = continuedListLevels;
  carry.footnoteBase += summary.footnotes;
}

/** `value` as JSON with the keys of every object in it sorted: equal values are equal text. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) =>
    held !== null && typeof held === "object" && !Array.isArray(held)
      ? Object.fromEntries(
        Object.entries(held).toSorted(([left], [right]) => left < right ? -1 : 1))
      : held);
}

/**
 * The normal form of `carry` for one run, as the text a stored rendering is keyed by: only
 * what the run's Markdown and counts show of the carry, so that two carries with one key give
 * the run one Markdown, and a carry that differs in something the run does not show has the
 * same key. Canonical JSON of the fields below with every key sorted, a field that holds its
 * initial value left out, and THE EMPTY STRING where none remains (so a run entered with
 * `initialCarry()` always has the key `""`):
 * - `s: true` the first thing the run writes takes a blank line before it;
 * - `n` by list and level, the carried number of a level whose next number the run shows
 *   (0 where the level shows `1.` because the carried list continues at it), left out where
 *   it is the level's start less one;
 * - `l` the leading levels that show `1.` because the carried list continues at them while
 *   the run shows the carried number of the same level later (not where that number is 0:
 *   the leading item then shows `1.` continued or not, and `n` says it);
 * - `f` `carry.footnoteBase`, for a run that holds a numbered footnote, left out where 0.
 * What only a source map shows of the carry (whether the leading blank line joins the
 * protected range before) is not in it: a source map is never stored. WHERE THE RUN STANDS is
 * not in it either: the one element whose rendering depends on its place, the section break
 * that opens a body, is told from every other by its stored form (`cutRuns`), so a stored
 * run renders the same wherever a version lists it.
 */
export function runCarryKey(summary: RunSummary, carry: RenderCarry): string {
  if (!summary.emits) return "";
  let { lead, counters } = summary;
  let continues = lead !== undefined && carry.previousListId === lead.listId;
  let carried = ({ listId, level, start }: CarriedLevel) =>
    carry.listNumbers.get(listId)?.[level] ?? start - 1;
  // By list in a map, written as own properties below: an id may be a name every object
  // inherits.
  let n = new Map<string, { [level: string]: number }>();
  let shows = (level: CarriedLevel, number: number) => {
    if (number === level.start - 1) return;
    let levels = n.get(level.listId) ?? {};
    levels[level.level] = number;
    n.set(level.listId, levels);
  };
  for (let level of counters) shows(level, carried(level));
  let l: { [level: string]: true } = {};
  for (let level of lead?.levels ?? []) {
    if (!continues || !carry.continuedListLevels[level.level]) {
      shows(level, carried(level));
    } else if (carried(level) !== 0 && counters.some(later =>
      later.listId === level.listId && later.level === level.level)) {
      // The leading item shows `1.` and a later one the number carried: the key says both.
      l[level.level] = true;
    } else {
      shows(level, 0);
    }
  }
  let footnoteBase = summary.numberedFootnotes > 0 ? carry.footnoteBase : 0;
  let key = {
    ...(carry.hasOutput && !continues ? { s: true } : {}),
    ...(n.size > 0 ? { n: Object.fromEntries(n) } : {}),
    ...(Object.keys(l).length > 0 ? { l } : {}),
    ...(footnoteBase === 0 ? {} : { f: footnoteBase }),
  };
  return Object.keys(key).length > 0 ? canonicalJson(key) : "";
}

/**
 * What a run's rendering reads of `context`, as text: canonical JSON of the definitions of
 * the lists the run names (`null` for one the tab does not define) and, where the run holds a
 * subtitle, whether the named styles give one italic; THE EMPTY STRING for a run that names no
 * list and holds no subtitle. Two contexts with one text give the run one rendering and one
 * summary.
 */
export function runContextKey(summary: RunSummary, context: RenderContext): string {
  if (summary.listIds.length === 0 && !summary.subtitle) return "";
  // Read as an own property: an id may be a name every object inherits.
  let definition = (id: string) => (Object.hasOwn(context.lists, id) && context.lists[id]) || null;
  return canonicalJson({
    lists: Object.fromEntries(summary.listIds.map(id => [id, definition(id)])),
    ...(summary.subtitle ? { subtitleItalic: givesSubtitleItalic(context.namedStyles) } : {}),
  });
}

function sameList<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * A SECOND CARRY BESIDE A PASS'S OWN, for a walk that moves two carries over two lists of
 * mostly the same runs and asks where the two are the same again (a version keyed beside
 * another): the other version's carry, held as WHAT DIFFERS from the pass's and never as a
 * copy. It is made where the two are the same carry; it holds the other's parts that are not
 * numbers, and the other's numbers for the lists at which the two differ, so it costs the
 * lists that differ, a move costs the lists the run counts in WHATEVER IS HELD APART (no
 * move and no `same` lists, scans or copies what differs), and `same` reads no number.
 *
 * THE RULE: from the moment it is made, the pass's carry moves ONLY through `advanceOurs`.
 * Moved any other way, the other carry is wrong at the lists moved.
 */
export class CarryBeside {
  /** The pass's carry, to read (a run's key, a rendering): moved by `advanceOurs` alone. */
  readonly ours: RenderCarry;
  /**
   * The other carry, to read (a run of the other list rendered alone): a view, which reads
   * the two as they stand at each read and is not to be kept past a move of either.
   */
  readonly theirs: RenderCarry;
  readonly #ours: PassCarry;
  // The other carry's parts that are not numbers, and in `listNumbers` WHAT DIFFERS: a list
  // with no entry has, on the other side, the pass's numbers; a list with an entry has the
  // entry's, an empty array where the other side has none and the pass's has some.
  readonly #theirs: PassCarry;

  /**
   * `ours`: the pass's own carry, which the other is the same as at this moment. `apart`: a
   * carry made for this pair (`initialCarry()`), which the pair owns from here and holds
   * what differs in; nothing else reads or moves it.
   */
  constructor(ours: PassCarry, apart: PassCarry) {
    apart.hasOutput = ours.hasOutput;
    apart.abutsProtected = ours.abutsProtected;
    if (ours.previousListId === undefined) delete apart.previousListId;
    else apart.previousListId = ours.previousListId;
    apart.continuedListLevels = ours.continuedListLevels;
    apart.footnoteBase = ours.footnoteBase;
    this.ours = this.#ours = ours;
    this.#theirs = apart;
    this.theirs = {
      get hasOutput() { return apart.hasOutput; },
      get abutsProtected() { return apart.abutsProtected; },
      get previousListId() { return apart.previousListId; },
      get continuedListLevels() { return apart.continuedListLevels; },
      get footnoteBase() { return apart.footnoteBase; },
      listNumbers: {
        // A reader sees a carry written one way: a list with no number is absent.
        get: listId => {
          let differs = apart.listNumbers.get(listId);
          if (differs === undefined) return ours.listNumbers.get(listId);
          return differs.length > 0 ? differs : undefined;
        },
      },
    };
  }

  /** Moves the pass's carry past a run of its own list. */
  advanceOurs(summary: RunSummary): void {
    this.#advance(this.#ours, summary);
  }

  /** Moves the other carry past a run of the other list. */
  advanceTheirs(summary: RunSummary): void {
    this.#advance(this.#theirs, summary);
  }

  /** Whether the two are the same carry, part for part. */
  same(): boolean {
    let ours = this.#ours, theirs = this.#theirs;
    return theirs.listNumbers.size === 0 && ours.hasOutput === theirs.hasOutput &&
      ours.abutsProtected === theirs.abutsProtected &&
      ours.previousListId === theirs.previousListId &&
      ours.footnoteBase === theirs.footnoteBase &&
      sameList(ours.continuedListLevels, theirs.continuedListLevels);
  }

  // Moves `side`, one of the two, past a run. Of the numbers it reads and writes the entries
  // of the lists the run counts in, on both sides, and nothing else: no step lists what is
  // held apart.
  #advance(side: PassCarry, summary: RunSummary): void {
    let ours = this.#ours.listNumbers, apart = this.#theirs.listNumbers;
    let listIds = Object.keys(summary.lists);
    // Each list the run counts in is held apart for the move: where it was not, the other
    // side's numbers were the pass's as they stand.
    for (let listId of listIds) {
      if (!apart.has(listId)) apart.set(listId, ours.get(listId) ?? []);
    }
    advanceCarry(side, summary);
    // And stays apart only where the two sides differ after it. A move of the other side may
    // have left out a list it emptied: the empty array says so where the pass holds numbers.
    for (let listId of listIds) {
      let theirs = apart.get(listId);
      if (sameList(ours.get(listId) ?? [], theirs ?? [])) apart.delete(listId);
      else if (theirs === undefined) apart.set(listId, []);
    }
  }
}

/**
 * The ids of the lists `elements` name, body and cells, sorted: what `RunSummary.listIds`
 * holds, for a caller that must load a run's lists before it renders the run.
 */
export function namedListIds(elements: readonly StructuralElement[]): string[] {
  let listIds = new Set<string>();
  let name = (content: readonly StructuralElement[]) => {
    for (let { paragraph, table } of content) {
      if (paragraph?.bullet) listIds.add(paragraph.bullet.listId);
      for (let row of table?.tableRows ?? []) {
        for (let cell of row.tableCells ?? []) name(cell.content ?? []);
      }
    }
  };
  name(elements);
  return [...listIds].toSorted();
}

function internalDocsDestination(kind: "bookmark" | "heading", id: string, tabId?: string): string {
  let tab = tabId ? `?tab=${encodeURIComponent(tabId)}` : "";
  return `${tab}#${kind}=${encodeURIComponent(id)}`;
}

function docsLinkDestination(link: TextStyle["link"]): string | undefined {
  if (!link) return undefined;
  if ("url" in link) return link.url;
  if ("tabId" in link) return `?tab=${encodeURIComponent(link.tabId)}`;
  if ("bookmark" in link) {
    return internalDocsDestination("bookmark", link.bookmark.id, link.bookmark.tabId);
  }
  if ("heading" in link) {
    return internalDocsDestination("heading", link.heading.id, link.heading.tabId);
  }
  if ("bookmarkId" in link) return internalDocsDestination("bookmark", link.bookmarkId);
  return internalDocsDestination("heading", link.headingId);
}

/**
 * The text one paragraph element shows in a tab's Markdown before any formatting: a run's content,
 * a chip's name, title or date, or the placeholder of an element with no text of its own.
 */
export function paragraphElementText(element: ParagraphElement): string | undefined {
  // A run's text needs nothing of its style.
  if (element.textRun) return element.textRun.content;
  return visibleParagraphElement(element)?.text;
}

function visibleParagraphElement(element: ParagraphElement): VisibleParagraphElement | undefined {
  let textRun = element.textRun;
  if (textRun) {
    return {
      text: textRun.content,
      style: textRun.textStyle,
      link: docsLinkDestination(textRun.textStyle.link),
    };
  }

  let person = element.person;
  let personText = person?.personProperties?.name || person?.personProperties?.email;
  if (personText) return { text: personText, style: person?.textStyle ?? {} };

  let richLink = element.richLink;
  let richLinkText = richLink?.richLinkProperties?.title;
  if (richLinkText) {
    return {
      text: richLinkText,
      style: richLink?.textStyle ?? {},
      link: richLink?.richLinkProperties?.uri,
    };
  }

  let dateElement = element.dateElement;
  let dateText = dateElement?.dateElementProperties?.displayText;
  if (dateText) return { text: dateText, style: dateElement?.textStyle ?? {} };

  let autoText = element.autoText;
  if (autoText) {
    let text: string;
    switch (autoText.type) {
      case "PAGE_NUMBER": text = "[Page number]"; break;
      case "PAGE_COUNT": text = "[Page count]"; break;
      default: text = "[Auto text]";
    }
    return { text, style: autoText.textStyle ?? {} };
  }

  // Elements with no text of their own render as a fixed placeholder.
  if (element.inlineObjectElement) {
    return { text: "[Image]", style: element.inlineObjectElement.textStyle ?? {} };
  }
  if (element.equation) return { text: "[Equation]", style: {} };
  if (element.footnoteReference) {
    let { footnoteNumber, textStyle } = element.footnoteReference;
    return { text: footnoteNumber ? `[${footnoteNumber}]` : "[Footnote]", style: textStyle ?? {} };
  }
  if (element.pageBreak) {
    return { text: "[Page break]", style: element.pageBreak.textStyle ?? {} };
  }
  if (element.columnBreak) {
    return { text: "[Column break]", style: element.columnBreak.textStyle ?? {} };
  }

  return undefined;
}

/**
 * The text one paragraph element renders as, or `undefined` when it renders as nothing. The
 * paragraph's trailing newline is dropped here so both renderings read a paragraph the same way.
 */
function paragraphRun(
  element: ParagraphElement,
  isLast: boolean,
): VisibleParagraphElement | undefined {
  let visible = visibleParagraphElement(element);
  if (!visible) return undefined;
  if (element.textRun && isLast) visible.text = visible.text.replace(/\n$/, "");
  return visible.text ? visible : undefined;
}

function positionedImageText(paragraph: Paragraph): string {
  return "[Image] ".repeat(paragraph.positionedObjectIds?.length ?? 0).trimEnd();
}

/** Whether a paragraph holds nothing but text: no positioned object, image or chip. */
function holdsOnlyText(paragraph: Paragraph): boolean {
  return !paragraph.positionedObjectIds?.length && paragraph.elements.every(element =>
    !!element.textRun && !element.textRun.content.includes(CHIP_PLACEHOLDER));
}

/** An editable text: where it is, and where its paragraph starts. */
type RenderedText = { start: number; end: number; docStart: number };

/** Rendered HTML with the editable texts in it, as ranges counted from its first character. */
type RenderedHtml = { html: string; texts: readonly RenderedText[] };

const NO_TEXTS: readonly RenderedText[] = [];

function shiftTexts(texts: readonly RenderedText[], offset: number): readonly RenderedText[] {
  return offset === 0 ? texts : texts.map(text => ({
    ...text, start: text.start + offset, end: text.end + offset,
  }));
}

/**
 * A rendered cell: its HTML, and what the HTML shows of the cell. Its texts are counted from the
 * first character of its first line.
 */
type RenderedCell = RenderedHtml &
  Pick<TableCellMapping, "rowSpan" | "columnSpan" | "nested" | "lines" | "emptyParagraph">;

/** A rendered table: its HTML, its look, and its rows when it is a table of the tab body. */
type RenderedTable = { html: string } & Pick<TableMapping, "look" | "rows">;

/** The elements that are not text, whose suggestions a cell's deletion discards. */
const SUGGESTED_ELEMENTS = [
  "autoText", "horizontalRule", "pageBreak", "columnBreak", "footnoteReference", "equation",
  "inlineObjectElement", "person", "richLink", "dateElement", "dropdown",
] as const satisfies readonly Exclude<keyof ParagraphElement, "startIndex" | "endIndex" | "textRun">[];

/** How many suggested insertions, deletions, style changes and chip property changes `value` is marked with. */
function suggestionsOf(value: {
  suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[];
  suggestedTableRowStyleChanges?: Record<string, object>;
  suggestedTableCellStyleChanges?: Record<string, object>;
  suggestedTextStyleChanges?: Record<string, object>;
  suggestedParagraphStyleChanges?: Record<string, object>;
  suggestedBulletChanges?: Record<string, object>;
  suggestedPersonPropertiesChanges?: Record<string, object>;
  suggestedRichLinkPropertiesChanges?: Record<string, object>;
  suggestedDateElementPropertiesChanges?: Record<string, object>;
  suggestedDropdownPropertiesChanges?: Record<string, object>;
}): number {
  return (value.suggestedInsertionIds?.length ?? 0) + (value.suggestedDeletionIds?.length ?? 0) +
    Object.keys(value.suggestedTableRowStyleChanges ?? {}).length +
    Object.keys(value.suggestedTableCellStyleChanges ?? {}).length +
    Object.keys(value.suggestedTextStyleChanges ?? {}).length +
    Object.keys(value.suggestedParagraphStyleChanges ?? {}).length +
    Object.keys(value.suggestedBulletChanges ?? {}).length +
    Object.keys(value.suggestedPersonPropertiesChanges ?? {}).length +
    Object.keys(value.suggestedRichLinkPropertiesChanges ?? {}).length +
    Object.keys(value.suggestedDateElementPropertiesChanges ?? {}).length +
    Object.keys(value.suggestedDropdownPropertiesChanges ?? {}).length;
}

/** Whether a table, a row or a cell is itself a suggested insertion or deletion. */
function insertsOrDeletes(
  value: { suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] },
): boolean {
  return !!value.suggestedInsertionIds?.length || !!value.suggestedDeletionIds?.length;
}

/**
 * What suggestions `paragraph`, which stands at `[docStart, docEnd)`, holds
 * (`ParagraphSuggestions`), or `undefined` where it holds none.
 */
function paragraphSuggestions(
  paragraph: Paragraph, docStart: number, docEnd: number,
): ParagraphSuggestions | undefined {
  let runs = paragraph.elements.flatMap(part => part.textRun && holdsSuggestion(part.textRun)
    ? [{ docStart: part.startIndex, docEnd: part.endIndex }] : []);
  let own = holdsOwnSuggestion(paragraph);
  if (!own && runs.length === 0) return undefined;
  return { docStart, docEnd, ...(own ? { own: true as const } : {}), runs };
}

/**
 * How many suggestions the table, its rows and its cells are marked with, those on the text,
 * the other elements (images, smart chips, rules) and the paragraphs of its cells and those of a table inside one of its cells
 * included: deleting the cell discards that suggestion too. The table's own fields count beside
 * those of its rows and cells, since a table that is itself a suggestion may mark only itself.
 */
function suggestionsIn(table: Table): number {
  let count = suggestionsOf(table);
  for (let row of table.tableRows ?? []) {
    count += suggestionsOf(row);
    for (let cell of row.tableCells ?? []) {
      count += suggestionsOf(cell);
      for (let element of cell.content ?? []) {
        if (element.table) count += suggestionsIn(element.table);
        if (!element.paragraph) continue;
        count += suggestionsOf(element.paragraph);
        for (let part of element.paragraph.elements) {
          if (part.textRun) count += suggestionsOf(part.textRun);
          for (let kind of SUGGESTED_ELEMENTS) if (part[kind]) count += suggestionsOf(part[kind]);
        }
      }
    }
  }
  return count;
}

/** What the tab says of a table that its HTML does not show. */
function tableDocMapping(
  element: StructuralElement, table: Table,
): Pick<TableMapping, "docStart" | "docEnd" | "pinnedRows" | "suggested"> {
  let rows = table.tableRows ?? [];
  let suggested = suggestionsIn(table);
  let pinnedRows = 0;
  while (rows[pinnedRows]?.tableRowStyle?.tableHeader === true) pinnedRows++;
  return {
    docStart: element.startIndex,
    docEnd: element.endIndex,
    ...(pinnedRows > 0 ? { pinnedRows } : {}),
    ...(suggested > 0 ? { suggested } : {}),
  };
}

/**
 * Render a table as raw HTML, which Markdown preserves without inventing a header row. A table of
 * the tab body is given `mdStart`, where its HTML starts in the tab's Markdown, and its rows are
 * mapped from there; a table inside a cell is given none, so it has no rows mapped and none of
 * its text is editable.
 */
function tableToHtml(
  table: Table,
  lists: GoogleDocsTab["lists"],
  tally: RunTally,
  subtitleItalic: boolean,
  mdStart?: number,
): RenderedTable {
  let look = lookOfTable(table);
  let tags = renderLook(look);
  let lines: string[] = [];
  // Where the next line starts.
  let next = mdStart ?? 0;
  let add = (line: string) => {
    lines.push(line);
    next += line.length + 1;
  };
  add(`<table${tags.table}>`);
  if (tags.colgroup !== undefined) add(`  ${tags.colgroup}`);
  let rows: TableRowMapping[] = [];
  for (let [rowIndex, row] of (table.tableRows ?? []).entries()) {
    let rowStart = next;
    add(`  <tr${tags.rows[rowIndex]}>`);
    let cells: TableCellMapping[] = [];
    for (let [column, cell] of (row.tableCells ?? []).entries()) {
      // Google puts text sent to a cell that a merged cell covers into the merged cell, whose
      // own text has ordinary indexes: a covered cell lists no text.
      // Nor does a cell of a table, row or cell a suggestion inserts or deletes.
      let inSuggestion =
        insertsOrDeletes(table) || insertsOrDeletes(row) || insertsOrDeletes(cell);
      let editable =
        mdStart !== undefined && look.cells[rowIndex][column] !== null && !inSuggestion;
      let rendered = tableCellToHtml(
        cell, lists, tally, subtitleItalic, editable, tags.cells[rowIndex][column]);
      if (mdStart !== undefined) cells.push(cellMapping(cell, rendered, next, lists, inSuggestion));
      add(rendered.html);
    }
    add("  </tr>");
    if (mdStart !== undefined) {
      rows.push({
        mdStart: rowStart, mdEnd: next, docStart: row.startIndex, docEnd: row.endIndex, cells,
      });
    }
  }
  lines.push("</table>");
  return { html: lines.join("\n"), look, rows };
}

/**
 * What the map says of one cell of a top-level table, from the cell and its rendering, whose
 * first line starts at `mdStart` of the tab's Markdown.
 */
function cellMapping(
  cell: TableCell,
  rendered: RenderedCell,
  mdStart: number,
  lists: GoogleDocsTab["lists"],
  inSuggestion: boolean,
): TableCellMapping {
  let elements = cell.content ?? [];
  let first = elements[0]?.paragraph;
  let copy = loneChipCopy(elements);
  let { html, texts, ...shown } = rendered;
  return {
    mdStart,
    mdEnd: mdStart + html.length + 1,
    docStart: cell.startIndex,
    ...shown,
    texts: texts.map(({ start, end, docStart }) => ({
      mdStart: mdStart + start, mdEnd: mdStart + end, docStart,
    })),
    numbered: someCellParagraph(elements, lists, isItemOfNumberingList),
    footnote: someCellParagraph(elements, lists, holdsFootnote),
    positioned: elements.some(element => !!element.paragraph?.positionedObjectIds?.length),
    // Google copies the style of a cell's first paragraph into a cell added beside it, and the
    // HTML does not say what that style is: a subtitle reads as a `<p>` in italics.
    styled: !first || !!first.bullet || first.paragraphStyle.namedStyleType !== "NORMAL_TEXT",
    loneChip: copy !== undefined,
    ...(copy && copy !== "unseen" ? { copies: copy } : {}),
    unshown: unshownElements(elements),
    ...cellSuggestions(elements),
    ...(inSuggestion ? { inSuggestion: true as const } : {}),
  };
}

/** The `suggested` field of a cell of `elements`, where a paragraph of them holds a suggestion. */
function cellSuggestions(
  elements: readonly StructuralElement[],
): Pick<TableCellMapping, "suggested"> {
  let suggested = elements.flatMap(({ paragraph, startIndex, endIndex }) => {
    let found = paragraph && paragraphSuggestions(paragraph, startIndex, endIndex);
    return found ? [found] : [];
  });
  return suggested.length > 0 ? { suggested } : {};
}

/** Whether a paragraph of `elements`, the cells of tables among them included, passes `test`. */
function someCellParagraph(
  elements: readonly StructuralElement[],
  lists: GoogleDocsTab["lists"],
  test: (paragraph: Paragraph, lists: GoogleDocsTab["lists"]) => boolean,
): boolean {
  return elements.some(element => element.paragraph
    ? test(element.paragraph, lists)
    : !!element.table?.tableRows?.some(row => !!row.tableCells?.some(cell =>
      someCellParagraph(cell.content ?? [], lists, test))));
}

/**
 * Whether a paragraph is an item of a list that numbers any of its levels, as `paragraphListItem`
 * reads a level. Only such an item can move a number the rendering shows; a bulleted item of the
 * list counts, since it restarts the numbered levels below it.
 */
function isItemOfNumberingList(paragraph: Paragraph, lists: GoogleDocsTab["lists"]): boolean {
  let levels = paragraph.bullet && lists[paragraph.bullet.listId]?.listProperties.nestingLevels;
  return !!levels?.some(({ glyphType }) => glyphType !== undefined && glyphType !== "NONE" &&
    glyphType !== "GLYPH_TYPE_UNSPECIFIED");
}

/** Whether a paragraph holds a footnote reference, which renders as the footnote's number. */
function holdsFootnote(paragraph: Paragraph): boolean {
  return paragraph.elements.some(element => !!element.footnoteReference);
}

/**
 * How many elements the paragraphs of `elements`, the cells of tables among them included, hold
 * that the rendering shows nothing for: a dropdown, or a smart chip that has no text of its own.
 */
function unshownElements(elements: readonly StructuralElement[]): number {
  let count = 0;
  for (let element of elements) {
    for (let part of element.paragraph?.elements ?? []) {
      if (!part.textRun && !part.horizontalRule && !visibleParagraphElement(part)) count++;
    }
    for (let row of element.table?.tableRows ?? []) {
      for (let cell of row.tableCells ?? []) count += unshownElements(cell.content ?? []);
    }
  }
  return count;
}

/** A paragraph of a cell that holds nothing, as a line of the cell's HTML. */
const EMPTY_PARAGRAPH = "<p></p>";

/** A cell's span as its tag writes it: 1 unless the cell spans more. */
function writtenSpan(span: number | undefined): number {
  return typeof span === "number" && Number.isInteger(span) && span > 1 ? span : 1;
}

/**
 * Render one cell, with `lookAttribute` after its spans. Its texts are counted from the first
 * character of its first line, and it lists none unless `editable`: a cell that a merged cell
 * covers and a cell of a table inside another cell are not. No other function writes a `<td>`.
 */
function tableCellToHtml(
  cell: TableCell,
  lists: GoogleDocsTab["lists"],
  tally: RunTally,
  subtitleItalic: boolean,
  editable: boolean,
  lookAttribute: string,
): RenderedCell {
  let rowSpan = writtenSpan(cell.tableCellStyle?.rowSpan);
  let columnSpan = writtenSpan(cell.tableCellStyle?.columnSpan);
  let attributes = (rowSpan > 1 ? ` rowspan="${rowSpan}"` : "") +
    (columnSpan > 1 ? ` colspan="${columnSpan}"` : "") + lookAttribute;
  let elements = cell.content ?? [];
  // Classify every element once: the list walk below revisits them as it groups nested items.
  let items = elements.map(({ paragraph }) => {
    if (paragraph) tally.notes(paragraph);
    return paragraph && paragraphListItem(paragraph, lists);
  });
  // A cell that holds anything but paragraphs, such as another table, lists no text either.
  editable &&= elements.every(element => element.paragraph);
  let parts: RenderedHtml[] = [];
  for (let index = 0; index < elements.length;) {
    if (items[index]) {
      let list = tableListToHtml(elements, items, index, tally, subtitleItalic, editable);
      parts.push(list);
      index = list.nextIndex;
      continue;
    }
    let part =
      tableCellElementToHtml(elements[index], lists, tally, subtitleItalic, editable);
    if (part !== undefined) parts.push(part);
    index++;
  }
  let content = parts.map(part => part.html).join("\n");
  let texts: RenderedText[] = [];
  let partStart = 0;
  for (let part of parts) {
    for (let text of shiftTexts(part.texts, partStart)) texts.push(text);
    partStart += part.html.length + 1;
  }
  let open = `    <td${attributes}>`;
  let shown = { rowSpan, columnSpan, nested: elements.some(element => !!element.table) };
  if (!content.includes("\n")) {
    return {
      html: `${open}${content}</td>`, texts: shiftTexts(texts, open.length),
      ...shown, lines: 1, emptyParagraph: content === EMPTY_PARAGRAPH,
    };
  }
  let lines = content.split("\n");
  return {
    html: `${open}\n${indentHtml(content, 6)}\n    </td>`,
    texts: indentedTexts(content, texts, 6, open.length + 1),
    ...shown, lines: lines.length, emptyParagraph: lines.includes(EMPTY_PARAGRAPH),
  };
}

/**
 * Where the `texts` of `html` are once `indentHtml` has indented it by `spaces` and `lead`
 * characters stand before it. Every line gains the indentation, so a text moves by it once for
 * its own line and once for each line before.
 */
function indentedTexts(
  html: string,
  texts: readonly RenderedText[],
  spaces: number,
  lead: number,
): RenderedText[] {
  let lines = 1;
  let nextBreak = html.indexOf("\n");
  // Texts are in order, so the line breaks before each offset are counted in one pass.
  let place = (offset: number) => {
    while (nextBreak >= 0 && nextBreak < offset) {
      lines++;
      nextBreak = html.indexOf("\n", nextBreak + 1);
    }
    return lead + offset + spaces * lines;
  };
  return texts.map(text => ({ ...text, start: place(text.start), end: place(text.end) }));
}

/**
 * Render the list starting at `startIndex`, which `items` must classify as a list item. Levels
 * between `level` and the list's own are filled with markerless items so its depth survives.
 */
function tableListToHtml(
  elements: StructuralElement[],
  items: readonly (ParagraphListItem | undefined)[],
  startIndex: number,
  tally: RunTally,
  subtitleItalic: boolean,
  editable: boolean,
  level = 0,
): RenderedHtml & { nextIndex: number } {
  let first = items[startIndex]!;
  let tag = first.listType === "numbered" ? "ol" : "ul";
  // The tag that opens a numbered list shows its first item's number.
  let html = htmlListOpeningTag(first, nextOrderedListNumber(first, tally));
  tally.shows(first);
  let texts: RenderedText[] = [];
  let index = startIndex;

  while (index < elements.length) {
    let item = items[index];
    let paragraph = elements[index].paragraph;
    if (!item || !paragraph || item.listId !== first.listId ||
        item.nestingLevel !== first.nestingLevel || item.listType !== first.listType) break;
    if (index > startIndex) nextOrderedListNumber(item, tally);

    let glyph = item.listType === "bullet" && item.glyphSymbol
      ? `${escapeHtml(item.glyphSymbol)} ` : "";
    let content = tableParagraphContentToHtml(paragraph, subtitleItalic);
    let headingLevel = paragraphHeadingLevel(paragraph);
    // The glyph shows the bullet and is not the item's text, so the text starts after it.
    html += headingLevel ? `<li><h${headingLevel}>${glyph}` : `<li>${glyph}`;
    if (editable && isEditableCellParagraph(paragraph)) {
      texts.push({
        start: html.length, end: html.length + content.length,
        docStart: elements[index].startIndex,
      });
    }
    html += headingLevel ? `${content}</h${headingLevel}>` : content;
    index++;
    while (index < elements.length) {
      let nested = items[index];
      if (!nested || nested.listId !== first.listId ||
          nested.nestingLevel <= first.nestingLevel) break;
      let child = tableListToHtml(
        elements, items, index, tally, subtitleItalic, editable, first.nestingLevel + 1);
      for (let text of shiftTexts(child.texts, html.length)) texts.push(text);
      html += child.html;
      index = child.nextIndex;
    }
    html += "</li>";
  }

  let skipped = first.nestingLevel - level;
  let lead = `${MARKERLESS_LIST}<li>`.repeat(skipped);
  return {
    html: `${lead}${html}</${tag}>` + "</li></ul>".repeat(skipped),
    texts: shiftTexts(texts, lead.length),
    nextIndex: index,
  };
}

function tableCellElementToHtml(
  element: StructuralElement,
  lists: GoogleDocsTab["lists"],
  tally: RunTally,
  subtitleItalic: boolean,
  editable: boolean,
): RenderedHtml | undefined {
  if (element.tableOfContents) return { html: "[Table of contents]", texts: NO_TEXTS };
  if (element.table) {
    let { html } = tableToHtml(element.table, lists, tally, subtitleItalic);
    return { html, texts: NO_TEXTS };
  }
  if (!element.paragraph) return undefined;
  let paragraph = element.paragraph;
  let content = tableParagraphContentToHtml(paragraph, subtitleItalic);
  if (content === "<hr>") return { html: content, texts: NO_TEXTS };
  let headingLevel = paragraphHeadingLevel(paragraph);
  let tag = headingLevel ? `h${headingLevel}` : "p";
  let start = tag.length + 2;
  return {
    html: `<${tag}>${content}</${tag}>`,
    texts: editable && isEditableCellParagraph(paragraph) ? [{
      start, end: start + content.length, docStart: element.startIndex,
    }] : NO_TEXTS,
  };
}

/**
 * Whether the text of a cell paragraph can be edited: it holds nothing but text, so its HTML is
 * exactly `cellInlineHtml` of its runs, and it is not a subtitle, whose HTML carries the italic
 * the style gives it.
 */
function isEditableCellParagraph(paragraph: Paragraph): boolean {
  return holdsOnlyText(paragraph) && paragraph.paragraphStyle.namedStyleType !== "SUBTITLE";
}

/**
 * The inline HTML of a cell paragraph. Adjacent elements that render with the same formatting
 * share one element, so the run boundaries Google keeps for styles this rendering does not show
 * (a colour, a font) leave no trace in it.
 */
function tableParagraphContentToHtml(paragraph: Paragraph, subtitleItalic: boolean): string {
  let inheritedItalic = subtitleItalic && paragraph.paragraphStyle.namedStyleType === "SUBTITLE";
  let lastElement = paragraph.elements.at(-1);
  let content = "";
  let italic = false;
  // The runs since the last rule or change of inherited italic, which nothing sets apart yet.
  let runs: CellInlineRun[] = [];
  let flush = () => {
    content += cellInlineHtml(runs);
    runs = [];
  };
  for (let part of paragraph.elements) {
    if (part.horizontalRule) {
      flush();
      content += italic ? "</em><hr>" : "<hr>";
      italic = false;
      continue;
    }
    let visible = paragraphRun(part, part === lastElement);
    if (!visible) continue;
    let nextItalic = inheritedItalic && (visible.style.italic ?? true);
    if (nextItalic !== italic) {
      flush();
      content += nextItalic ? "<em>" : "</em>";
      italic = nextItalic;
    }
    let { text, style, link } = visible;
    let mark = part.textRun && suggestionMark(part.textRun);
    runs.push({
      text,
      ...(mark ? { mark } : {}),
      bold: style.bold,
      // A subtitle's italic is the span around its runs, opened and closed above.
      italic: !inheritedItalic && style.italic,
      strikethrough: style.strikethrough,
      link: link && isSafeTableLink(link) ? link : undefined,
    });
  }
  flush();
  if (italic) content += "</em>";
  let images = positionedImageText(paragraph);
  return images && content ? `${images} ${content}` : images || content;
}

/** Permit inert web links and native Docs destinations in generated table HTML. */
export function isSafeTableLink(link: string): boolean {
  return /^(?:https?:|mailto:)/i.test(link) || parseInternalDocsLink(link) !== undefined;
}

/** One stretch of a cell paragraph's text with the formatting the table HTML shows. */
export type CellInlineRun = {
  text: string;
  /** The suggestion the text is, as the HTML marks it (`<ins>`, `<del>`); absent for none. */
  mark?: SuggestionMark;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  /** The destination as the HTML shows it, absent for text that is not linked. */
  link?: string;
};

/** The HTML of a cell paragraph's text: adjacent runs formatted alike share one element. */
function cellInlineHtml(runs: readonly CellInlineRun[]): string {
  let html = "";
  let text = "";
  let format: CellInlineRun | undefined;
  for (let run of runs) {
    if (!run.text) continue;
    if (format && !sameInlineFormat(format, run)) {
      html += formattedTextToHtml(text, format);
      text = "";
    }
    format = run;
    text += run.text;
  }
  return format ? html + formattedTextToHtml(text, format) : html;
}

function sameInlineFormat(left: CellInlineRun, right: CellInlineRun): boolean {
  return left.mark === right.mark && !left.bold === !right.bold && !left.italic === !right.italic &&
    !left.strikethrough === !right.strikethrough &&
    (left.link || undefined) === (right.link || undefined);
}

function formattedTextToHtml(text: string, format: CellInlineRun): string {
  let html = escapeHtml(text).replaceAll("\u000b", "<br>");
  if (format.strikethrough) html = `<s>${html}</s>`;
  if (format.italic) html = `<em>${html}</em>`;
  if (format.bold) html = `<strong>${html}</strong>`;
  if (format.link) html = `<a href="${escapeHtmlAttribute(format.link)}">${html}</a>`;
  if (format.mark === "deletion" || format.mark === "both") html = `<del>${html}</del>`;
  if (format.mark === "insertion" || format.mark === "both") html = `<ins>${html}</ins>`;
  return html;
}

function htmlListStartAttribute(value: number): string {
  return Number.isInteger(value) && value !== 1 ? ` start="${value}"` : "";
}

function htmlOrderedListType(glyphType: string): string | undefined {
  switch (glyphType) {
    case "ALPHA": return "a";
    case "UPPER_ALPHA": return "A";
    case "ROMAN": return "i";
    case "UPPER_ROMAN": return "I";
    default: return undefined;
  }
}

/** A list with hidden markers, for items whose glyph is written inline or absent. */
const MARKERLESS_LIST = '<ul style="list-style-type: none">';

function htmlListOpeningTag(item: ParagraphListItem, listNumber: number | undefined): string {
  if (item.listType === null) return MARKERLESS_LIST;
  if (item.glyphType === undefined) return item.glyphSymbol ? MARKERLESS_LIST : "<ul>";

  let type = htmlOrderedListType(item.glyphType);
  let typeAttribute = type ? ` type="${type}"` : "";
  let style = item.glyphType === "ZERO_DECIMAL"
    ? ' style="list-style-type: decimal-leading-zero"' : "";
  let startNumber = type && listNumber === 0 ? 1 : listNumber;
  return `<ol${typeAttribute}${style}${htmlListStartAttribute(startNumber ?? 1)}>`;
}

/**
 * Escape only what changes how the table markup parses. Deliberately narrower than the kit's
 * `escapeHtml()`: this output is read by an agent, so quotes and apostrophes in cell prose stay
 * as typed rather than becoming entities.
 */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escape text for a double-quoted attribute value of the table markup. */
export function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_[\]{}()#+\-.!|>~]/g, "\\$&");
}

function escapeMarkdownLinkDestination(url: string): string {
  return url.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function indentHtml(text: string, spaces: number): string {
  let prefix = " ".repeat(spaces);
  return prefix + text.replaceAll("\n", `\n${prefix}`);
}

/** Determine the Markdown prefix for a paragraph based on its style. */
function getParagraphPrefix(
  para: Paragraph,
  listItem: ParagraphListItem | undefined,
  listNumber: number | undefined,
): string {
  let prefix = "";
  if (listItem?.listType) {
    let indent = "  ".repeat(listItem.nestingLevel);
    prefix = listItem.listType === "numbered"
      ? `${indent}${listNumber ?? 1}. ` : `${indent}- `;
  }
  let headingLevel = paragraphHeadingLevel(para);
  return prefix + (headingLevel ? `${"#".repeat(headingLevel)} ` : "");
}

function paragraphListItem(
  paragraph: Paragraph,
  lists: GoogleDocsTab["lists"],
): ParagraphListItem | undefined {
  let bullet = paragraph.bullet;
  if (!bullet) return undefined;
  let nestingLevel = bullet.nestingLevel ?? 0;
  let level = lists[bullet.listId]?.listProperties.nestingLevels[nestingLevel];
  // A checklist level reports this placeholder in place of an absent glyph type; it is unordered.
  let glyphType = level?.glyphType === "GLYPH_TYPE_UNSPECIFIED" ? undefined : level?.glyphType;
  let listType: ListType | null = "bullet";
  if (glyphType === "NONE") listType = null;
  else if (glyphType !== undefined) listType = "numbered";
  return {
    listId: bullet.listId,
    listType,
    glyphType,
    glyphSymbol: level?.glyphSymbol,
    nestingLevel,
    startNumber: level?.startNumber ?? 1,
  };
}

function nextOrderedListNumber(
  item: ParagraphListItem | undefined,
  tally: RunTally,
): number | undefined {
  return item && tally.count(item);
}

function paragraphHeadingLevel(paragraph: Paragraph): number | undefined {
  switch (paragraph.paragraphStyle.namedStyleType) {
    case "TITLE":
    case "HEADING_1": return 1;
    case "HEADING_2": return 2;
    case "HEADING_3": return 3;
    case "HEADING_4": return 4;
    case "HEADING_5": return 5;
    case "HEADING_6": return 6;
    default: return undefined;
  }
}

type MarkdownFormat = { open: string; close: string };

const STRIKETHROUGH_FORMAT = { open: "~~", close: "~~" };
const BOLD_FORMAT = { open: "**", close: "**" };
const ITALIC_FORMAT = { open: "*", close: "*" };

function markdownFormats(
  style: TextStyle,
  link: string | undefined,
  inheritedItalic: boolean,
): MarkdownFormat[] {
  let formats: MarkdownFormat[] = [];
  if (link) formats.push({ open: "[", close: `](${escapeMarkdownLinkDestination(link)})` });
  if (style.strikethrough) formats.push(STRIKETHROUGH_FORMAT);
  if (style.bold) formats.push(BOLD_FORMAT);
  if (style.italic ?? inheritedItalic) formats.push(ITALIC_FORMAT);
  return formats;
}

function markdownFormatTransition(
  formats: readonly MarkdownFormat[],
  nextFormats: readonly MarkdownFormat[],
): string {
  let shared = 0;
  while (shared < formats.length && shared < nextFormats.length &&
      sameMarkdownFormat(formats[shared], nextFormats[shared])) shared++;

  let markdown = "";
  for (let index = formats.length - 1; index >= shared; index--) markdown += formats[index].close;
  for (let index = shared; index < nextFormats.length; index++) markdown += nextFormats[index].open;
  return markdown;
}

function sameMarkdownFormat(left: MarkdownFormat, right: MarkdownFormat): boolean {
  return left.open === right.open && left.close === right.close;
}
function emitParagraphContent(
  para: Paragraph, writer: MarkdownWriter, subtitleItalic: boolean,
): void {
  let formats: MarkdownFormat[] = [];
  // A subtitle's text is italic unless it says otherwise where its style makes it so.
  let isSubtitle = subtitleItalic && para.paragraphStyle.namedStyleType === "SUBTITLE";
  let lastElement = para.elements.at(-1);
  let images = positionedImageText(para);
  if (images) {
    writer.syntax(images);
    let hasContent = para.elements.some((element, index) =>
      !!element.horizontalRule || !!paragraphRun(element, index === para.elements.length - 1));
    if (hasContent) writer.syntax(" ");
  }

  for (let element of para.elements) {
    if (element.horizontalRule) {
      writer.syntax("<hr>");
      continue;
    }

    let visible = paragraphRun(element, element === lastElement);
    if (!visible) continue;

    let nextFormats = markdownFormats(visible.style, visible.link, isSubtitle);
    let transition = markdownFormatTransition(formats, nextFormats);
    if (transition) writer.syntax(transition);
    formats = nextFormats;

    if (element.textRun) {
      let [open, close] = markdownMarks(suggestionMark(element.textRun));
      if (open) writer.syntax(open);
      emitMappedTextRun(writer, visible.text, visible.style, element.startIndex, !!visible.link);
      if (close) writer.syntax(close);
    } else {
      writer.syntax(escapeMarkdownText(visible.text));
    }
  }

  let transition = markdownFormatTransition(formats, []);
  if (transition) writer.syntax(transition);
}

/**
 * What a suggestion on text is, as the rendering marks it: an insertion, a deletion, or both, a
 * deletion suggested of text another suggestion inserts. A suggested change of style is not
 * marked: the edits that would discard it are refused, and the refusal says so.
 */
export type SuggestionMark = "insertion" | "deletion" | "both";

/** What the text of `run` is as the rendering marks it; `undefined` for text it does not mark. */
function suggestionMark(run: TextRun): SuggestionMark | undefined {
  let inserted = !!run.suggestedInsertionIds?.length;
  let deleted = !!run.suggestedDeletionIds?.length;
  return inserted && deleted ? "both" : inserted ? "insertion" : deleted ? "deletion" : undefined;
}

/**
 * The marks a tab's Markdown writes around text a suggestion inserts and deletes, as
 * CriticMarkup spells them. A table cell's HTML writes `<ins>` and `<del>` instead.
 */
const MARKDOWN_MARKS = ["{++", "++}", "{--", "--}"] as const;

/** The marks written before and after text marked `mark`; empty for none. */
function markdownMarks(mark: SuggestionMark | undefined): readonly [string, string] {
  switch (mark) {
    case "insertion": return ["{++", "++}"];
    case "deletion": return ["{--", "--}"];
    case "both": return ["{++{--", "--}++}"];
    default: return ["", ""];
  }
}

/** How many times `markdown` holds `mark`, counted without overlaps. */
function marksIn(markdown: string, mark: string): number {
  return markdown.split(mark).length - 1;
}

/**
 * Throws, for the edit `op`, where `newMarkdown` holds one of the marks a tab's Markdown writes
 * around suggested text more times than `oldMarkdown` does: an edit cannot make a suggestion.
 * The marks of a suggestion the old text quotes may stand in the new text as they are, and so
 * may text the document holds that reads as a mark.
 */
export function refuseNewSuggestionMarks(
  op: string, oldMarkdown: string, newMarkdown: string,
): void {
  if (MARKDOWN_MARKS.some(mark => marksIn(newMarkdown, mark) > marksIn(oldMarkdown, mark))) {
    throw new Error(
      `${op}: the new text holds {++, ++}, {-- or --}, which getContent() writes around text ` +
      "a suggestion inserts or deletes. An edit cannot make a suggestion: use suggestEdit() " +
      "for that, and leave the marks of a suggestion the old text quotes as they are.");
  }
}

/**
 * Emit one text run, escaping the characters that would otherwise close a link label early. The
 * escape is syntax; the character it protects still maps to its document index.
 */
function emitMappedTextRun(
  writer: MarkdownWriter,
  text: string,
  style: TextStyle,
  docStart: number,
  escapeLinkLabel: boolean,
): void {
  let chunkStart = 0;
  if (escapeLinkLabel) {
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== "\\" && text[index] !== "[" && text[index] !== "]") continue;
      writer.mapped(text.slice(chunkStart, index), docStart + chunkStart, style);
      writer.syntax("\\");
      writer.mapped(text[index], docStart + index, style);
      chunkStart = index + 1;
    }
  }
  writer.mapped(text.slice(chunkStart), docStart + chunkStart, style);
}

// ---------------------------------------------------------------------------
// Markdown → Google Docs batchUpdate requests
// ---------------------------------------------------------------------------

/** Parsed representation of a Markdown block. */
type ParsedBlock = {
  /** Plain text content (no Markdown syntax). */
  plainText: string;
  /** Paragraph style: heading level (1-6), or null for normal text. */
  headingLevel: number | null;
  /** If this is a list item: "bullet" or "numbered". */
  listType: ListType | null;
  /** Number written in an ordered-list marker. */
  listNumber: number | null;
  /** Nesting level for list items (0-based). */
  nestingLevel: number;
  /** Inline formatting spans, relative to plainText. */
  spans: FormattingSpan[];
}

type FormattingSpan = {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: string;
}

/** The most blocks, one for each line, that the Markdown of one write may hold. */
export const MAX_MARKDOWN_BLOCKS = 2_000;
const MAX_MARKDOWN_FORMATTING_TOKENS = 5_000;
// The requests one replacement emits within those limits, which `parseMarkdownForWrite` enforces
// on everything it writes. The count leaves out the tabs a list item's own text starts with,
// which take up to three requests more for that item (their insert, its style reset, and the
// part of a formatting span that lies over them): `addRequest` refuses a batch that would pass
// the limit.
// A bullet removal, a paragraph style, and a subtitle override or bullet run (subtitles are never
// list items).
const REQUESTS_PER_BLOCK = 3;
// A content deletion, the insert, the style reset, and a deletion of the removed paragraphs after
// it. Each rewritten paragraph pairs with one block, so this is also bounded per block.
const REQUESTS_PER_REWRITTEN_PARAGRAPH = 4;
// A leading deletion, an insert and style reset before the first paragraph, and a bullet removal and
// paragraph style repairing a paragraph merged into the tab's last.
const REQUESTS_PER_REPLACEMENT = 5;
/** The most requests `addRequest` lets one batch hold. */
export const MAX_GOOGLE_DOC_REQUESTS = REQUESTS_PER_REPLACEMENT +
  (REQUESTS_PER_BLOCK + REQUESTS_PER_REWRITTEN_PARAGRAPH) * MAX_MARKDOWN_BLOCKS +
  MAX_MARKDOWN_FORMATTING_TOKENS;

/** Reject Markdown whose structure would consume excessive parser or Docs batch resources. */
export function assertMarkdownWriteComplexity(markdown: string): void {
  let blocks = markdown.length === 0 ? 0 : 1;
  let formattingTokens = 0;
  for (let index = 0; index < markdown.length; index++) {
    let character = markdown[index];
    if (character === "\n") {
      blocks++;
      if (blocks > MAX_MARKDOWN_BLOCKS) {
        throw new Error(`Google Doc action Markdown exceeds the ${MAX_MARKDOWN_BLOCKS}-block complexity limit.`);
      }
      continue;
    }
    if (character === "\\" && markdown[index + 1] &&
      isMarkdownPunctuation(markdown[index + 1])) {
      index++;
      continue;
    }
    if (character === "*") {
      formattingTokens++;
      while (markdown[index + 1] === "*") index++;
    } else if (character === "~" && markdown[index + 1] === "~") {
      formattingTokens++;
      while (markdown[index + 1] === "~") index++;
    } else if (character === "]" && markdown[index + 1] === "(") {
      formattingTokens++;
    }
    if (formattingTokens > MAX_MARKDOWN_FORMATTING_TOKENS) {
      throw new Error(
        `Google Doc action Markdown exceeds the ${MAX_MARKDOWN_FORMATTING_TOKENS}-formatting-token complexity limit.`,
      );
    }
  }
}

/**
 * Parse Markdown into one block per line. Between two lines, each pair of blank lines is an empty
 * paragraph, the inverse of how rendering separates paragraphs; before the first line every blank
 * line is one, and after the last all but the first are.
 */
function parseMarkdown(markdown: string): ParsedBlock[] {
  let blocks: ParsedBlock[] = [];
  let blankLines = 0;
  let pushEmpty = (count: number) => {
    for (let index = 0; index < count; index++) blocks.push(parseLine(""));
  };
  for (let line of markdown.split("\n")) {
    if (line === "") {
      blankLines++;
      continue;
    }
    pushEmpty(blocks.length > 0 ? blankLines >> 1 : blankLines);
    blocks.push(parseLine(line));
    blankLines = 0;
  }
  pushEmpty(blocks.length > 0 ? blankLines - 1 : blankLines);
  return blocks;
}

function parseMarkdownForWrite(markdown: string): ParsedBlock[] {
  assertMarkdownWriteComplexity(markdown);
  let blocks = parseMarkdown(markdown);
  let spanCount = 0;
  for (let block of blocks) {
    spanCount += block.spans.length;
    if (spanCount > MAX_MARKDOWN_FORMATTING_TOKENS) {
      throw new Error(
        `Google Doc action Markdown exceeds the ${MAX_MARKDOWN_FORMATTING_TOKENS}-formatting-span complexity limit.`,
      );
    }
  }
  return blocks;
}

/** Parse a single line of Markdown into a ParsedBlock. */
function parseLine(line: string): ParsedBlock {
  let headingLevel: number | null = null;
  let listType: "bullet" | "numbered" | null = null;
  let nestingLevel = 0;
  let listNumber: number | null = null;
  let content = line;

  let bulletMatch = content.match(/^( *)- /);
  let numberedMatch = content.match(/^( *)(\d+)\. /);
  if (bulletMatch) {
    listType = "bullet";
    nestingLevel = Math.floor(bulletMatch[1].length / 2);
    content = content.slice(bulletMatch[0].length);
  } else if (numberedMatch) {
    listType = "numbered";
    listNumber = Number(numberedMatch[2]);
    nestingLevel = Math.floor(numberedMatch[1].length / 2);
    content = content.slice(numberedMatch[0].length);
  }

  let headingMatch = content.match(/^(#{1,6}) /);
  if (headingMatch) {
    headingLevel = headingMatch[1].length;
    content = content.slice(headingMatch[0].length);
  }

  // Parse inline formatting.
  let { plainText, spans } = parseInlineFormatting(content);

  return { plainText, headingLevel, listType, listNumber, nestingLevel, spans };
}

type MarkdownLinkIndex = {
  nextCloseBracket: Int32Array;
  closeParen: Int32Array;
};

function indexMarkdownLinks(text: string): MarkdownLinkIndex {
  let closes = new Uint8Array(text.length);
  let closeParen = new Int32Array(text.length).fill(-1);
  let openParens: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\" && index + 1 < text.length) {
      index++;
    } else if (text[index] === "]") {
      closes[index] = 1;
    } else if (text[index] === "(") {
      openParens.push(index);
    } else if (text[index] === ")") {
      let open = openParens.pop();
      if (open !== undefined) closeParen[open] = index;
    }
  }

  let nextCloseBracket = new Int32Array(text.length + 1).fill(-1);
  let next = -1;
  for (let index = text.length - 1; index >= 0; index--) {
    if (closes[index]) next = index;
    nextCloseBracket[index] = next;
  }
  return { nextCloseBracket, closeParen };
}

function markdownLinkDestination(text: string, start: number, end: number): string {
  let url = "";
  for (let index = start; index < end; index++) {
    let escaped = text[index + 1];
    if (text[index] === "\\" && (escaped === "\\" || escaped === "(" || escaped === ")")) {
      url += escaped;
      index++;
    } else {
      url += text[index];
    }
  }
  return url;
}

function matchMarkdownLink(
  text: string,
  index: number,
  links: MarkdownLinkIndex,
): { label: string; url: string; end: number } | undefined {
  if (text[index] !== "[") return undefined;
  let closeBracket = links.nextCloseBracket[index + 1];
  if (closeBracket < 0 || text[closeBracket + 1] !== "(") return undefined;
  let end = links.closeParen[closeBracket + 1];
  if (end < 0) return undefined;
  return {
    label: text.slice(index + 1, closeBracket),
    url: markdownLinkDestination(text, closeBracket + 2, end),
    end,
  };
}

function escapeMarkdownLinkLabelText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function isMarkdownPunctuation(character: string): boolean {
  let code = character.charCodeAt(0);
  return code >= 0x21 && code <= 0x2f || code >= 0x3a && code <= 0x40 ||
    code >= 0x5b && code <= 0x60 || code >= 0x7b && code <= 0x7e;
}

function startsMarkdownEscape(markdown: string, index: number): boolean {
  if (index < 0 || markdown[index] !== "\\" ||
      !markdown[index + 1] || !isMarkdownPunctuation(markdown[index + 1])) return false;
  let preceding = 0;
  while (markdown[index - preceding - 1] === "\\") preceding++;
  return preceding % 2 === 0;
}

function assertMarkdownEscapeBoundaries(markdown: string, start: number, end: number): void {
  if (startsMarkdownEscape(markdown, start - 1) || startsMarkdownEscape(markdown, end - 1)) {
    throw new Error(
      "replaceText: Markdown escape syntax cannot be edited partially. " +
      "Include its backslash in oldMarkdown.",
    );
  }
}

function markdownTokenSplits(markdown: string): Uint8Array {
  let links = indexMarkdownLinks(markdown);
  let ranges: MarkdownRange[] = inlineMarkdownRanges(markdown, links);
  for (let index = 0; index < markdown.length;) {
    let link = matchMarkdownLink(markdown, index, links);
    if (!link) {
      index++;
      continue;
    }
    ranges.push({ mdStart: index, mdEnd: link.end + 1 });
    index = link.end + 1;
  }

  let deltas = new Int32Array(markdown.length + 1);
  for (let range of ranges) {
    deltas[range.mdStart + 1]++;
    deltas[range.mdEnd]--;
  }

  let splits = new Uint8Array(markdown.length + 1);
  let activeRanges = 0;
  let backslashes = 0;
  for (let index = 1; index <= markdown.length; index++) {
    activeRanges += deltas[index];
    if (activeRanges > 0) splits[index] = 1;

    backslashes = markdown[index - 1] === "\\" ? backslashes + 1 : 0;
    if (backslashes % 2 === 1 && markdown[index] && isMarkdownPunctuation(markdown[index])) {
      splits[index] = 1;
    }
    if (index < markdown.length && markdown[index - 1] === markdown[index] &&
        (markdown[index] === "*" || markdown[index] === "~")) splits[index] = 1;
  }
  return splits;
}

/** The marker that opens a heading or list item, at the start of its line, with its space. */
const BLOCK_MARKER = /(?:#{1,6}| *-| *\d+\.) /y;

/**
 * The block marker of the line of `markdown` that `index` is in, as [start, end), when `index`
 * lies inside it: from its first character, or with `within` from its second.
 */
function blockMarkerAround(
  markdown: string, index: number, within: boolean,
): { start: number; end: number } | undefined {
  let start = markdown.lastIndexOf("\n", index - 1) + 1;
  BLOCK_MARKER.lastIndex = start;
  let marker = BLOCK_MARKER.exec(markdown);
  if (!marker) return undefined;
  let end = start + marker[0].length;
  return (within ? start < index : start <= index) && index < end ? { start, end } : undefined;
}

/**
 * Shared replacement bounds that never split Markdown syntax tokens, or a surrogate pair: two
 * emoji can share their high surrogate, and Google refuses to delete half of a pair. Nor do they
 * split a grapheme cluster of either text, or leave one across the place the new text is put
 * once the old is deleted (`atGraphemeBoundary`, `joinsGraphemes`), so that the new text lands,
 * and is styled, where the replacement shows it.
 *
 * Nor do they leave part of a block marker the new Markdown writes in the text the two share,
 * where the old Markdown has those characters as a line's text and not as a marker: `one two`
 * replaced by `one\n- two` shares ` two`, and the marker's space with it. The whole marker
 * then counts as changed, so that the line is written as the heading or list item it reads as
 * and not as text that happens to hold a marker's characters.
 */
function markdownReplacementBounds(oldMarkdown: string, newMarkdown: string): {
  prefixLen: number;
  suffixLen: number;
} {
  let oldTokenSplits = markdownTokenSplits(oldMarkdown);
  let newTokenSplits = markdownTokenSplits(newMarkdown);
  let prefixLen = 0;
  while (prefixLen < oldMarkdown.length && prefixLen < newMarkdown.length &&
      oldMarkdown[prefixLen] === newMarkdown[prefixLen]) prefixLen++;
  while (prefixLen > 0 && (oldTokenSplits[prefixLen] || newTokenSplits[prefixLen] ||
      isHighSurrogate(oldMarkdown.charCodeAt(prefixLen - 1)) ||
      !atGraphemeBoundary(oldMarkdown, prefixLen) ||
      !atGraphemeBoundary(newMarkdown, prefixLen))) prefixLen--;
  let written = blockMarkerAround(newMarkdown, prefixLen, true);
  if (written && !blockMarkerAround(oldMarkdown, prefixLen, true)) prefixLen = written.start;

  let suffixLen = 0;
  while (suffixLen < oldMarkdown.length - prefixLen &&
      suffixLen < newMarkdown.length - prefixLen &&
      oldMarkdown[oldMarkdown.length - suffixLen - 1] ===
        newMarkdown[newMarkdown.length - suffixLen - 1]) suffixLen++;
  let splitsToken = () => suffixLen > 0 &&
    (oldTokenSplits[oldMarkdown.length - suffixLen] ||
      newTokenSplits[newMarkdown.length - suffixLen] ||
      isLowSurrogate(oldMarkdown.charCodeAt(oldMarkdown.length - suffixLen)) ||
      !atGraphemeBoundary(oldMarkdown, oldMarkdown.length - suffixLen) ||
      !atGraphemeBoundary(newMarkdown, newMarkdown.length - suffixLen) ||
      joinsGraphemes(oldMarkdown, prefixLen, suffixLen));
  while (splitsToken()) suffixLen--;
  written = blockMarkerAround(newMarkdown, newMarkdown.length - suffixLen, false);
  if (suffixLen > 0 && written &&
      !blockMarkerAround(oldMarkdown, oldMarkdown.length - suffixLen, false)) {
    suffixLen = newMarkdown.length - written.end;
    while (splitsToken()) suffixLen--;
  }

  return { prefixLen, suffixLen };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function canonicalizeMarkdownFragment(markdown: string): string {
  let start = 0;
  while (markdown[start] === "\n") start++;
  let end = markdown.length;
  while (end > start && markdown[end - 1] === "\n") end--;
  return markdown.slice(0, start) + canonicalizeMarkdownForWrite(markdown.slice(start, end)) +
    markdown.slice(end);
}

function normalizeChangedListOrdinal(
  oldMarkdown: string,
  newMarkdown: string,
  changeStart: number,
): string {
  let oldLineStart = oldMarkdown.lastIndexOf("\n", changeStart - 1) + 1;
  let newLineStart = newMarkdown.lastIndexOf("\n", changeStart - 1) + 1;
  let oldMarker = /^( *)(\d+)\. /.exec(oldMarkdown.slice(oldLineStart));
  let newMarker = /^( *)(\d+)\. /.exec(newMarkdown.slice(newLineStart));
  if (!oldMarker || !newMarker || oldMarker[0] === newMarker[0] || newMarker[2] === "1") {
    return newMarkdown;
  }

  let numberStart = newLineStart + newMarker[1].length;
  return newMarkdown.slice(0, numberStart) + "1" +
    newMarkdown.slice(numberStart + newMarker[2].length);
}

/** Canonicalize changed Markdown while preserving copied document text. */
export function canonicalizeMarkdownReplacement(
  oldMarkdown: string,
  newMarkdown: string,
): string {
  let bounds = markdownReplacementBounds(oldMarkdown, newMarkdown);
  let normalized = normalizeChangedListOrdinal(oldMarkdown, newMarkdown, bounds.prefixLen);
  if (normalized !== newMarkdown) {
    newMarkdown = normalized;
    bounds = markdownReplacementBounds(oldMarkdown, newMarkdown);
  }
  let { prefixLen, suffixLen } = bounds;
  let changed = canonicalizeMarkdownFragment(
    newMarkdown.slice(prefixLen, newMarkdown.length - suffixLen),
  );
  let canonical = oldMarkdown.slice(0, prefixLen) + changed +
    oldMarkdown.slice(oldMarkdown.length - suffixLen);
  return normalizeChangedBlockBoundaries(canonical, prefixLen, prefixLen + changed.length);
}

const BOLD_STATE = 1;
const ITALIC_STATE = 2;
const STRIKETHROUGH_STATE = 4;
const INLINE_STYLE_STATES = [BOLD_STATE, ITALIC_STATE, STRIKETHROUGH_STATE] as const;

type InlineToken = { start: number; end: number; marker: "asterisk" | "strikethrough" };

function inlineTokens(text: string, links: MarkdownLinkIndex): InlineToken[] {
  let tokens: InlineToken[] = [];
  for (let index = 0; index < text.length;) {
    let escaped = text[index + 1];
    if (text[index] === "\\" && escaped && isMarkdownPunctuation(escaped)) {
      index += 2;
      continue;
    }
    let link = matchMarkdownLink(text, index, links);
    if (link) {
      index = link.end + 1;
      continue;
    }
    if (text.startsWith("~~", index)) {
      let end = index + 2;
      while (text[end] === "~") end++;
      let length = end - index;
      if (length === 2 || length === 4) {
        tokens.push({ start: index, end: index + 2, marker: "strikethrough" });
        if (length === 4) {
          tokens.push({ start: index + 2, end, marker: "strikethrough" });
        }
      }
      index = end;
      continue;
    }
    if (text[index] === "*") {
      let end = index + 1;
      while (text[end] === "*") end++;
      tokens.push({ start: index, end, marker: "asterisk" });
      index = end;
      continue;
    }
    index++;
  }
  return tokens;
}

function inlineTransition(state: number, token: InlineToken): number | undefined {
  if (token.marker === "strikethrough") return state ^ STRIKETHROUGH_STATE;
  switch (token.end - token.start) {
    case 1: return state ^ ITALIC_STATE;
    case 2: return state ^ BOLD_STATE;
    case 3: return state ^ BOLD_STATE ^ ITALIC_STATE;
    case 4: return state & ITALIC_STATE ? state ^ BOLD_STATE : undefined;
    default: return undefined;
  }
}

function completableInlineStates(tokens: InlineToken[]): Uint8Array {
  let completable = new Uint8Array(tokens.length + 1);
  completable[tokens.length] = 1;
  for (let index = tokens.length - 1; index >= 0; index--) {
    let nextStates = completable[index + 1];
    let states = nextStates;
    for (let state = 0; state < 8; state++) {
      let next = inlineTransition(state, tokens[index]);
      if (next !== undefined && nextStates & (1 << next)) states |= 1 << state;
    }
    completable[index] = states;
  }
  return completable;
}

function inlineMarkdownRanges(
  markdown: string,
  links: MarkdownLinkIndex,
): (MarkdownRange & { style: number })[] {
  let ranges: (MarkdownRange & { style: number })[] = [];
  let starts = new Map<number, number>();
  let state = 0;
  let tokens = inlineTokens(markdown, links);
  let completable = completableInlineStates(tokens);

  for (let index = 0; index < tokens.length; index++) {
    let token = tokens[index];
    let nextToken = tokens[index + 1];
    if (state & STRIKETHROUGH_STATE && token.marker === "strikethrough" &&
        nextToken?.marker === "strikethrough" && token.end === nextToken.start &&
        completable[index + 2] & (1 << state)) {
      index++;
      continue;
    }

    let next = inlineTransition(state, token);
    if (next === undefined || !(completable[index + 1] & (1 << next))) continue;
    let previousToken = tokens[index - 1];
    if (token.marker === "strikethrough" && state & STRIKETHROUGH_STATE &&
        previousToken?.marker === "strikethrough" && previousToken.end === token.start &&
        starts.get(STRIKETHROUGH_STATE) === previousToken.start) {
      starts.delete(STRIKETHROUGH_STATE);
      state = next;
      continue;
    }
    for (let style of INLINE_STYLE_STATES) {
      if (!(state & style) && next & style) starts.set(style, token.start);
      if (state & style && !(next & style)) {
        ranges.push({ mdStart: starts.get(style)!, mdEnd: token.end, style });
        starts.delete(style);
      }
    }
    state = next;
  }
  return ranges;
}

function inlineSpanStyle(
  state: number,
): Pick<FormattingSpan, "bold" | "italic" | "strikethrough"> {
  switch (state) {
    case BOLD_STATE: return { bold: true };
    case ITALIC_STATE: return { italic: true };
    default: return { strikethrough: true };
  }
}

/** `text` without the characters Google removes from inserted text. */
export function stripUnwritableCharacters(text: string): string {
  let kept = "";
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (!isGoogleDocsStrippedCharacter(text.charCodeAt(index))) continue;
    kept += text.slice(start, index);
    start = index + 1;
  }
  return start === 0 ? text : kept + text.slice(start);
}

function coalesceFormattingSpans(spans: FormattingSpan[]): FormattingSpan[] {
  let coalesced: FormattingSpan[] = [];
  for (let span of spans) {
    let previous = coalesced.at(-1);
    if (previous && previous.end === span.start && previous.bold === span.bold &&
      previous.italic === span.italic && previous.strikethrough === span.strikethrough &&
      previous.link === span.link) {
      previous.end = span.end;
    } else {
      coalesced.push(span);
    }
  }
  return coalesced;
}

function sanitizeGoogleDocsParsedText(
  plainText: string,
  spans: FormattingSpan[],
): { plainText: string; spans: FormattingSpan[] } {
  let firstRemoved = -1;
  for (let index = 0; index < plainText.length; index++) {
    if (isGoogleDocsStrippedCharacter(plainText.charCodeAt(index))) {
      firstRemoved = index;
      break;
    }
  }
  if (firstRemoved === -1) return { plainText, spans: coalesceFormattingSpans(spans) };

  let removedBefore = new Uint32Array(plainText.length + 1);
  let chunks = [plainText.slice(0, firstRemoved)];
  let chunkStart = firstRemoved + 1;
  let removed = 1;
  removedBefore[chunkStart] = removed;
  for (let index = chunkStart; index < plainText.length; index++) {
    if (isGoogleDocsStrippedCharacter(plainText.charCodeAt(index))) {
      chunks.push(plainText.slice(chunkStart, index));
      chunkStart = index + 1;
      removed++;
    }
    removedBefore[index + 1] = removed;
  }

  chunks.push(plainText.slice(chunkStart));
  return {
    plainText: chunks.join(""),
    spans: coalesceFormattingSpans(spans.map(span => ({
      ...span,
      start: span.start - removedBefore[span.start],
      end: span.end - removedBefore[span.end],
    }))),
  };
}

function parseInlineFormatting(text: string): { plainText: string; spans: FormattingSpan[] } {
  let plainText = "";
  let spans: FormattingSpan[] = [];
  let starts = new Map<number, number>();
  let state = 0;
  let links = indexMarkdownLinks(text);
  let tokens = inlineTokens(text, links);
  let completable = completableInlineStates(tokens);
  let tokenIndex = 0;

  for (let index = 0; index < text.length;) {
    let escaped = text[index + 1];
    if (text[index] === "\\" && escaped && isMarkdownPunctuation(escaped)) {
      plainText += escaped;
      index += 2;
      continue;
    }

    let link = matchMarkdownLink(text, index, links);
    if (link) {
      let end = link.end + 1;
      if (!link.label) {
        plainText += text.slice(index, end);
      } else {
        let start = plainText.length;
        let inner = parseInlineFormatting(link.label);
        plainText += inner.plainText;
        spans.push({ start, end: plainText.length, link: link.url });
        for (let span of inner.spans) {
          spans.push({ ...span, start: start + span.start, end: start + span.end });
        }
      }
      index = end;
      continue;
    }

    let token = tokens[tokenIndex];
    if (token?.start === index) {
      let nextToken = tokens[tokenIndex + 1];
      if (state & STRIKETHROUGH_STATE && token.marker === "strikethrough" &&
          nextToken?.marker === "strikethrough" && token.end === nextToken.start &&
          completable[tokenIndex + 2] & (1 << state)) {
        index = nextToken.end;
        tokenIndex += 2;
        continue;
      }

      let next = inlineTransition(state, token);
      if (next !== undefined && completable[tokenIndex + 1] & (1 << next)) {
        let previousToken = tokens[tokenIndex - 1];
        if (token.marker === "strikethrough" && state & STRIKETHROUGH_STATE &&
            previousToken?.marker === "strikethrough" && previousToken.end === token.start &&
            starts.get(STRIKETHROUGH_STATE) === plainText.length) {
          plainText += text.slice(previousToken.start, token.end);
          starts.delete(STRIKETHROUGH_STATE);
          state = next;
        } else {
          for (let style of INLINE_STYLE_STATES) {
            if (!(state & style) && next & style) starts.set(style, plainText.length);
            if (state & style && !(next & style)) {
              spans.push({
                start: starts.get(style)!,
                end: plainText.length,
                ...inlineSpanStyle(style),
              });
              starts.delete(style);
            }
          }
          state = next;
        }
      } else {
        plainText += text.slice(token.start, token.end);
      }
      index = token.end;
      tokenIndex++;
      continue;
    }

    plainText += text[index++];
  }

  return sanitizeGoogleDocsParsedText(plainText, spans);
}

function canonicalInlineMarkdown(block: ParsedBlock): string {
  let boundaries = [...new Set([
    0,
    block.plainText.length,
    ...block.spans.flatMap(span => [span.start, span.end]),
  ])].toSorted((left, right) => left - right);
  let starts = block.spans.toSorted((left, right) => left.start - right.start);
  let ends = block.spans.toSorted((left, right) => left.end - right.end);
  let startIndex = 0;
  let endIndex = 0;
  let bold = 0;
  let italic = 0;
  let strikethrough = 0;
  let links = new Map<string, number>();
  let formats: MarkdownFormat[] = [];
  let markdown = "";

  function adjust(span: FormattingSpan, amount: 1 | -1): void {
    if (span.bold) bold += amount;
    if (span.italic) italic += amount;
    if (span.strikethrough) strikethrough += amount;
    if (!span.link) return;
    let count = (links.get(span.link) ?? 0) + amount;
    if (count) links.set(span.link, count);
    else links.delete(span.link);
  }

  for (let index = 0; index < boundaries.length - 1; index++) {
    let start = boundaries[index];
    let end = boundaries[index + 1];
    while (starts[startIndex]?.start === start) adjust(starts[startIndex++], 1);
    while (ends[endIndex]?.end === start) adjust(ends[endIndex++], -1);
    let style: TextStyle = {
      bold: bold > 0,
      italic: italic > 0,
      strikethrough: strikethrough > 0,
    };
    let link = links.keys().next().value;
    let nextFormats = markdownFormats(style, link && canonicalLinkDestination(link), false);
    markdown += markdownFormatTransition(formats, nextFormats);
    let text = block.plainText.slice(start, end);
    markdown += link ? escapeMarkdownLinkLabelText(text) : text;
    formats = nextFormats;
  }

  return markdown + markdownFormatTransition(formats, []);
}

/** Normalize supported Markdown to the form returned after writing and rereading it. */
export function canonicalizeMarkdownForWrite(markdown: string): string {
  let result = "";
  let lastListType: ListType | null = null;
  for (let block of parseMarkdownForWrite(markdown)) {
    if (result && (!lastListType || !block.listType || lastListType !== block.listType)) {
      result += "\n";
    }
    if (block.listType) {
      result += "  ".repeat(block.nestingLevel) + (block.listType === "numbered" ? "1. " : "- ");
    }
    if (block.headingLevel !== null) result += `${"#".repeat(block.headingLevel)} `;
    result += canonicalInlineMarkdown(block) + "\n";
    lastListType = block.listType;
  }
  return result.slice(0, -1);
}

type DocsLink = NonNullable<TextStyle["link"]>;

type MarkdownWriteOptions = {
  /**
   * The paragraph written into, and the source blocks of the rewrite it belongs to. New paragraphs
   * inherit `container`'s attributes; the block at `pairedIndex` replaces its content.
   */
  source?: {
    blocks: BlockMapping[];
    /** The source blocks' links, keyed by Markdown destination. */
    links: Map<string, DocsLink>;
    markdown: string;
    container: BlockMapping;
    pairedIndex?: number;
  };
  /** Whether blocks with no source counterpart must be reset to a plain paragraph first. */
  resetParagraphs?: boolean;
  /** Whether paragraphs reset to plain also lose their indent, which removing a bullet leaves. */
  resetIndent?: boolean;
  /** Style to apply across the insertion, for an edit that stays inside one text run. */
  sourceTextStyle?: TextStyle;
  /** Leave the paragraph before an inserted separator unchanged. */
  preserveLeadingParagraph?: boolean;
  /** Keep a fragment's final paragraph break. */
  preserveTrailingNewline?: boolean;
  /**
   * Make the paragraph that a kept final break splits off a plain one: it takes the list and
   * style of the paragraph written into, which the Markdown does not show on it. `list` says
   * whether that paragraph is a list item, whose bullet and indent then go. `restyle` says
   * whether its named style is not normal text; naming a style resets the look its text has on
   * every run, so `runs`, its kept text's bold, italic, strikethrough and links counted from its
   * start, are then written again.
   */
  resetTrailingParagraph?: {
    list: boolean; restyle: boolean; runs: { start: number; end: number; textStyle: TextStyle }[];
  };
  /** Receives the index of each block needing bullets, for a caller that creates them itself. */
  bulleted?: (index: number) => void;
  /**
   * The tab's blocks, for a write that creates its own bullets: they say what the paragraph
   * written into is, and which list items lie before it, which decides the nesting a new list
   * item gets (`addBulletRequests`).
   */
  tabBlocks?: readonly BlockMapping[];
};

function parseInternalDocsLink(destination: string): DocsLink | undefined {
  let match = /^(?:\?tab=([^#&]+))?(?:#(bookmark|heading)=([^#&]+))?$/.exec(destination);
  if (!match || !match[1] && !match[2]) return undefined;

  try {
    let tabId = match[1] ? decodeURIComponent(match[1]) : undefined;
    let id = match[3] ? decodeURIComponent(match[3]) : undefined;
    if (!match[2]) return tabId ? { tabId } : undefined;
    if (!id) return undefined;
    if (match[2] === "bookmark") {
      return tabId ? { bookmark: { id, tabId } } : { bookmarkId: id };
    }
    return tabId ? { heading: { id, tabId } } : { headingId: id };
  } catch {
    return undefined;
  }
}

/** A link destination spelled as a rendering spells it, however it was written. */
export function canonicalLinkDestination(destination: string): string {
  return docsLinkDestination(parseInternalDocsLink(destination)) ?? destination;
}

/** The link a destination written in table HTML or Markdown stands for. */
export function docsLinkForDestination(destination: string): DocsLink {
  return parseInternalDocsLink(destination) ?? { url: destination };
}

/**
 * A link destination as a table cell of tab `tabId` reads once it is written: a heading or
 * bookmark named without a tab is one of that tab, as a read returns it.
 */
export function cellLinkDestination(destination: string, tabId: string): string {
  let link = parseInternalDocsLink(destination);
  if (!link) return destination;
  if ("headingId" in link) link = { heading: { id: link.headingId, tabId } };
  else if ("bookmarkId" in link) link = { bookmark: { id: link.bookmarkId, tabId } };
  return docsLinkDestination(link) ?? destination;
}

function sourceLinks(blocks: BlockMapping[]): Map<string, DocsLink> {
  let links = new Map<string, DocsLink>();
  for (let block of blocks) {
    for (let segment of block.segments) {
      if ("syntaxOnly" in segment || !segment.textStyle.link) continue;
      let destination = docsLinkDestination(segment.textStyle.link);
      if (destination !== undefined && !links.has(destination)) {
        // A copy: the model changes the elements a rendering was made from in place, and a
        // batch is stored and sent as it was built.
        links.set(destination, structuredClone(segment.textStyle.link));
      }
    }
  }
  return links;
}

function linkForWrite(source: MarkdownWriteOptions["source"], destination: string): DocsLink {
  return source?.links.get(destination) ?? docsLinkForDestination(destination);
}

function targetNamedStyle(block: ParsedBlock, source?: BlockMapping): string {
  if (block.headingLevel !== null) {
    return block.headingLevel === 1 && source?.namedStyleType === "TITLE"
      ? "TITLE"
      : `HEADING_${block.headingLevel}`;
  }
  return source?.namedStyleType === "SUBTITLE" && block.listType === null
    ? "SUBTITLE"
    : "NORMAL_TEXT";
}

function sourceBlockText(source: BlockMapping, markdown: string): string {
  let text = "";
  for (let segment of source.segments) {
    if (!("syntaxOnly" in segment)) text += markdown.slice(segment.mdStart, segment.mdEnd);
  }
  return text;
}

function sameBlockShape(source: BlockMapping, target: ParsedBlock): boolean {
  return source.listType === target.listType && source.listNestingLevel === target.nestingLevel &&
    source.namedStyleType === targetNamedStyle(target, source);
}

function blocksMatch(source: BlockMapping, sourceText: string, target: ParsedBlock): boolean {
  return sourceText === target.plainText && sameBlockShape(source, target);
}

function canPreserveListItem(
  source: BlockMapping,
  target: ParsedBlock,
  markdown: string,
): boolean {
  if (source.listId === undefined || source.listType !== target.listType) return false;
  if (source.listType === null) return true;
  return source.listNestingLevel === target.nestingLevel &&
    (target.listType !== "numbered" || target.listNumber !== null &&
      markdown.startsWith(
        `${"  ".repeat(target.nestingLevel)}${target.listNumber}. `, source.mdStart));
}

/** Whether a new paragraph, which inherits `container`'s list, can stay in it. */
function continuesList(container: BlockMapping, target: ParsedBlock): boolean {
  return container.listId !== undefined && target.listType !== null &&
    container.listType === target.listType && container.listNestingLevel === target.nestingLevel;
}

/** Whether `target` renders exactly as `source` already does. */
function isUnchangedBlock(source: BlockMapping, target: ParsedBlock, markdown: string): boolean {
  return JSON.stringify(parseLine(markdown.slice(source.mdStart, source.mdEnd - 1))) ===
    JSON.stringify(target);
}

/** Beyond this many block pairs, a rewrite's changed middle is anchored only by unique blocks. */
const MAX_ALIGNED_BLOCK_PAIRS = 250_000;

/**
 * Pair each source block with the target block that rewrites it. Unmatched sources are removed;
 * unmatched targets are new paragraphs.
 */
function alignSourceBlocks(
  sources: BlockMapping[],
  targets: ParsedBlock[],
  markdown: string,
): [number, number][] {
  let texts = sources.map(source => sourceBlockText(source, markdown));
  let match = (s: number, t: number) => blocksMatch(sources[s], texts[s], targets[t]);

  let head = 0;
  while (head < sources.length && head < targets.length && match(head, head)) head++;
  let sourceEnd = sources.length;
  let targetEnd = targets.length;
  while (sourceEnd > head && targetEnd > head && match(sourceEnd - 1, targetEnd - 1)) {
    sourceEnd--;
    targetEnd--;
  }

  let matches = Array.from({ length: head }, (_, index): [number, number] => [index, index]);
  let rows = sourceEnd - head;
  let columns = targetEnd - head;
  if (rows * columns <= MAX_ALIGNED_BLOCK_PAIRS) {
    // Row-major (rows + 1) x (columns + 1); a length never exceeds sqrt(MAX_ALIGNED_BLOCK_PAIRS).
    let width = columns + 1;
    let lengths = new Uint16Array((rows + 1) * width);
    for (let s = rows - 1; s >= 0; s--) {
      for (let t = columns - 1; t >= 0; t--) {
        let cell = s * width + t;
        lengths[cell] = match(head + s, head + t)
          ? lengths[cell + width + 1] + 1
          : Math.max(lengths[cell + width], lengths[cell + 1]);
      }
    }
    for (let s = 0, t = 0; s < rows && t < columns;) {
      let cell = s * width + t;
      if (lengths[cell] === lengths[cell + width]) s++;
      else if (lengths[cell] === lengths[cell + 1]) t++;
      else matches.push([head + s++, head + t++]);
    }
  } else {
    let key = (text: string, listType: ListType | null, nestingLevel: number) =>
      JSON.stringify([text, listType, nestingLevel]);
    let anchors = uniqueAnchors(
      sources.slice(head, sourceEnd).map((source, index) =>
        key(texts[head + index], source.listType, source.listNestingLevel)),
      targets.slice(head, targetEnd).map(target =>
        key(target.plainText, target.listType, target.nestingLevel)),
      (s, t) => match(head + s, head + t),
    );
    matches.push(...anchors.map(([s, t]): [number, number] => [head + s, head + t]));
  }
  for (let offset = 0; sourceEnd + offset <= sources.length; offset++) {
    matches.push([sourceEnd + offset, targetEnd + offset]);
  }

  let pairs: [number, number][] = [];
  let gapSource = 0;
  let gapTarget = 0;
  for (let [s, t] of matches) {
    pairs.push(...pairGap(sources, targets, gapSource, s, gapTarget, t));
    if (s < sources.length) pairs.push([s, t]);
    gapSource = s + 1;
    gapTarget = t + 1;
  }
  return pairs;
}

/** Pairs of keys unique on both sides, reduced to the longest run ordered on both. */
function uniqueAnchors(
  sourceKeys: string[],
  targetKeys: string[],
  match: (s: number, t: number) => boolean,
): [number, number][] {
  let uniqueIndices = (keys: string[]) => {
    let indices = new Map<string, number>();
    keys.forEach((key, index) => indices.set(key, indices.has(key) ? -1 : index));
    return indices;
  };
  let targetIndices = uniqueIndices(targetKeys);
  let candidates = [...uniqueIndices(sourceKeys)].flatMap(([key, s]): [number, number][] => {
    let t = targetIndices.get(key) ?? -1;
    return s >= 0 && t >= 0 && match(s, t) ? [[s, t]] : [];
  });

  let tails: number[] = [];
  let previous: number[] = [];
  candidates.forEach(([, t], index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      let middle = (low + high) >> 1;
      if (candidates[tails[middle]][1] < t) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? tails[low - 1] : -1;
    tails[low] = index;
  });
  let anchors: [number, number][] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) {
    anchors.push(candidates[index]);
  }
  return anchors.toReversed();
}

/**
 * Pair the unmatched blocks between two matches, so edited paragraphs keep their own lists and
 * styles. Pairs extend from each end while the blocks' shapes agree; any surplus sits where they
 * first diverge, so a new list item lands beside the items it continues.
 */
function pairGap(
  sources: BlockMapping[],
  targets: ParsedBlock[],
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  targetEnd: number,
): [number, number][] {
  let count = Math.min(sourceEnd - sourceStart, targetEnd - targetStart);
  let sameShape = (s: number, t: number) => sameBlockShape(sources[s], targets[t]);
  let front = 0;
  while (front < count && sameShape(sourceStart + front, targetStart + front)) front++;
  let back = 0;
  while (front + back < count && sameShape(sourceEnd - 1 - back, targetEnd - 1 - back)) back++;
  return [
    ...Array.from({ length: count - back },
      (_, index): [number, number] => [sourceStart + index, targetStart + index]),
    ...Array.from({ length: back },
      (_, index): [number, number] => [sourceEnd - back + index, targetEnd - back + index]),
  ];
}

/** Append `request` to a batch, refusing a batch larger than `MAX_GOOGLE_DOC_REQUESTS`. */
export function addRequest(requests: GoogleDocsRequest[], request: GoogleDocsRequest): void {
  if (requests.length >= MAX_GOOGLE_DOC_REQUESTS) {
    throw new Error(`Google Doc action exceeds the ${MAX_GOOGLE_DOC_REQUESTS}-request batch limit.`);
  }
  requests.push(request);
}

/**
 * Merge each range into its predecessor when the two abut and `same` holds. A paragraph-range
 * request applies to every paragraph it touches, so abutting paragraphs that need the same change
 * can share one request.
 */
function coalesceRanges<T extends { startIndex: number; endIndex: number }>(
  ranges: readonly T[],
  same: (previous: T, next: T) => boolean,
): T[] {
  let merged: T[] = [];
  for (let range of ranges) {
    let previous = merged.at(-1);
    if (previous?.endIndex === range.startIndex && same(previous, range)) {
      previous.endIndex = range.endIndex;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * One `updateParagraphStyle` request. At least one of a style change or an indent reset must be
 * asked for, since Google rejects a request that names no fields.
 */
function updateParagraphStyleRequest(
  range: { startIndex: number; endIndex: number; tabId: string },
  namedStyleType: string | undefined,
  clearIndent: boolean,
): any {
  let paragraphStyle: Record<string, unknown> = {};
  let fields: string[] = [];
  if (namedStyleType !== undefined) {
    paragraphStyle.namedStyleType = namedStyleType;
    fields.push("namedStyleType");
  }
  if (clearIndent) {
    paragraphStyle.indentStart = { magnitude: 0, unit: "PT" };
    paragraphStyle.indentFirstLine = { magnitude: 0, unit: "PT" };
    fields.push("indentStart", "indentFirstLine");
  }
  return { updateParagraphStyle: { range, paragraphStyle, fields: fields.join(",") } };
}

/**
 * Convert a Markdown string into Google Docs batchUpdate request objects that insert the content
 * at the given index inside tab `tabId`.
 *
 * Every emitted coordinate names that tab: tab bodies have independent index spaces, so an
 * unqualified index lands in whichever tab Google picks.
 *
 * Returns requests in the order they should appear in the batchUpdate array.
 */
export function markdownToDocRequests(
  markdown: string,
  insertAt: number,
  tabId: string,
  options: MarkdownWriteOptions = {},
): any[] {
  return blocksToDocRequests(parseMarkdownForWrite(markdown), insertAt, tabId, options, []);
}

/**
 * Append to `requests` those that fill the empty paragraph at `insertAt` with `text` as plain
 * paragraphs, one per line, none of the text bold, italic, struck through or linked. The
 * paragraphs are reset as well: none is a list item, a heading or indented, whatever the
 * paragraph was, and empty text only resets it. With `keepParagraphStyle` they are left as
 * the paragraph is, and empty text sends nothing.
 */
export function plainTextToDocRequests(
  text: string,
  insertAt: number,
  tabId: string,
  requests: GoogleDocsRequest[],
  keepParagraphStyle = false,
): void {
  let blocks = text.split("\n").map((plainText): ParsedBlock => ({
    plainText, headingLevel: null, listType: null, listNumber: null, nestingLevel: 0, spans: [],
  }));
  blocksToDocRequests(blocks, insertAt, tabId,
    keepParagraphStyle ? {} : { resetParagraphs: true, resetIndent: true }, requests);
}

/** Append to `requests` the requests that insert `blocks` at `insertAt`. */
function blocksToDocRequests(
  blocks: ParsedBlock[],
  insertAt: number,
  tabId: string,
  options: MarkdownWriteOptions,
  requests: GoogleDocsRequest[],
): GoogleDocsRequest[] {
  if (blocks.length === 0) return requests;
  let { source, resetParagraphs = false } = options;
  let preserveLists = blocks.map((block, index) => source !== undefined &&
    (index === source.pairedIndex
      ? canPreserveListItem(source.container, block, source.markdown)
      : continuesList(source.container, block)));
  // A list run whose first item is rebuilt is rebuilt whole, so it stays one list.
  for (let start = 0; start < blocks.length;) {
    let end = start + 1;
    while (end < blocks.length && blocks[end].listType === blocks[start].listType) end++;
    if (blocks[start].listType && !preserveLists[start]) preserveLists.fill(false, start, end);
    start = end;
  }
  // Positions are known from the text lengths alone, so lay every block out in one pass.
  let offset = insertAt;
  let positioned = blocks.map((written, index) => {
    let paired = index === source?.pairedIndex ? source.container : undefined;
    let preserveList = preserveLists[index];
    let fresh = written.listType !== null && !preserveList;
    // `createParagraphBullets` reads every tab a paragraph starts with as nesting and removes
    // it, so a new item is laid out behind the tabs of its level alone, and the tabs its own
    // text starts with are written once its bullet is made (`addBulletRequests`).
    let textTabs = fresh ? leadingTabs(written) : undefined;
    let block = textTabs ? blockTextSlice(written, textTabs.plainText.length) : written;
    let prefix = fresh ? levelTabs(block.nestingLevel) : "";
    let paragraphStart = offset;
    offset += prefix.length + block.plainText.length + 1;
    return {
      block,
      textTabs,
      paired,
      preserveList,
      targetStyle: targetNamedStyle(block, paired),
      prefix,
      paragraphStart,
      textStart: paragraphStart + prefix.length,
      paragraphEnd: offset,
      preserveStyle: options.preserveLeadingParagraph && index === 0,
    };
  });
  let fullText = positioned.map(({ block, prefix }) => prefix + block.plainText).join("\n");
  if (options.preserveTrailingNewline) fullText += "\n";

  if (fullText.length > 0) {
    addRequest(requests, { insertText: { location: { index: insertAt, tabId }, text: fullText } });
  }

  let paragraphChanges = positioned.map(({ paired, preserveList, preserveStyle, targetStyle,
    paragraphStart, paragraphEnd }) => {
    let change = {
      startIndex: paragraphStart,
      endIndex: paragraphEnd,
      deleteBullets: false,
      namedStyleType: undefined as string | undefined,
      clearIndent: false,
    };
    if (preserveStyle) return change;
    // A rewrite's paragraphs can only have inherited their container's list.
    let resetList = !preserveList &&
      (source ? source.container.listId !== undefined : resetParagraphs);
    change.deleteBullets = resetList;
    change.clearIndent = resetList && (source !== undefined || options.resetIndent === true);
    if (paired ? paired.namedStyleType !== targetStyle
      : resetParagraphs || targetStyle !== "NORMAL_TEXT") {
      change.namedStyleType = targetStyle;
    }
    return change;
  });
  let trailing = options.preserveTrailingNewline ? options.resetTrailingParagraph : undefined;
  if (trailing) {
    paragraphChanges.push({
      startIndex: offset, endIndex: offset + 1, deleteBullets: trailing.list,
      namedStyleType: trailing.restyle ? "NORMAL_TEXT" : undefined, clearIndent: trailing.list,
    });
  }
  // Bullets go first: removing them indents each paragraph to keep its nesting visible, and the
  // indent reset below undoes that.
  for (let { startIndex, endIndex } of coalesceRanges(
    paragraphChanges.filter(change => change.deleteBullets), () => true)) {
    addRequest(requests, { deleteParagraphBullets: { range: { startIndex, endIndex, tabId } } });
  }
  for (let { startIndex, endIndex, namedStyleType, clearIndent } of coalesceRanges(
    paragraphChanges.filter(change => change.namedStyleType !== undefined || change.clearIndent),
    (previous, next) => previous.namedStyleType === next.namedStyleType &&
      previous.clearIndent === next.clearIndent)) {
    addRequest(requests, updateParagraphStyleRequest(
      { startIndex, endIndex, tabId }, namedStyleType, clearIndent));
  }
  for (let run of trailing?.restyle ? trailing.runs : []) {
    let fields = (["bold", "italic", "strikethrough", "link"] as const)
      .filter(field => run.textStyle[field]);
    addRequest(requests, {
      updateTextStyle: {
        range: { startIndex: offset + run.start, endIndex: offset + run.end, tabId },
        textStyle: run.textStyle, fields: fields.join(","),
      },
    });
  }

  // Reset inherited inline styling across all inserted text in one request. Starting at the first
  // character of text leaves a leading inserted newline, which terminates the paragraph before the
  // insertion, with the style it already has.
  let textBlocks = positioned.filter(({ block }) => block.plainText.length > 0);
  let firstText = textBlocks[0];
  let lastText = textBlocks.at(-1);
  if (firstText && lastText) {
    addRequest(requests, {
      updateTextStyle: {
        range: {
          startIndex: firstText.textStart,
          endIndex: lastText.textStart + lastText.block.plainText.length,
          tabId,
        },
        textStyle: options.sourceTextStyle ?? {},
        fields: "bold,italic,strikethrough,link",
      },
    });
  }
  for (let { block, targetStyle, textStart } of textBlocks) {
    if (targetStyle !== "SUBTITLE") continue;
    addRequest(requests, {
      updateTextStyle: {
        range: { startIndex: textStart, endIndex: textStart + block.plainText.length, tabId },
        textStyle: { italic: false },
        fields: "italic",
      },
    });
  }

  for (let { block, textStart } of positioned) {
    for (let span of block.spans) {
      let startIndex = textStart + span.start;
      let endIndex = textStart + span.end;
      if (startIndex >= endIndex) continue;

      let textStyle: Record<string, unknown> = {};
      let fields: string[] = [];
      if (span.bold) { textStyle.bold = true; fields.push("bold"); }
      if (span.italic) { textStyle.italic = true; fields.push("italic"); }
      if (span.strikethrough) { textStyle.strikethrough = true; fields.push("strikethrough"); }
      if (span.link) {
        textStyle.link = linkForWrite(options.source, span.link);
        fields.push("link");
      }
      if (fields.length === 0) continue;
      addRequest(requests, {
        updateTextStyle: {
          range: { startIndex, endIndex, tabId }, textStyle, fields: fields.join(","),
        },
      });
    }
  }

  let isNewItem = ({ block, preserveList }: (typeof positioned)[number]) =>
    block.listType !== null && !preserveList;
  if (options.bulleted) {
    positioned.forEach((paragraph, index) => {
      if (isNewItem(paragraph)) options.bulleted!(index);
    });
    return requests;
  }
  // The first block is written into a paragraph of the tab: it begins where that paragraph
  // does and, where the write leaves that paragraph as it is, is the list item it is.
  let tabBlocks = options.tabBlocks ?? [];
  let written = tabBlocks.findIndex(block => block.docStart <= insertAt && insertAt < block.docEnd);
  let container = written < 0 ? undefined : tabBlocks[written];
  let keptItem = options.preserveLeadingParagraph || !resetParagraphs ? container : undefined;
  addBulletRequests(requests, positioned.map((paragraph, index): LaidParagraph => {
    let { block, textTabs, paragraphStart, paragraphEnd } = paragraph;
    if (isNewItem(paragraph)) {
      return {
        startIndex: paragraphStart, endIndex: paragraphEnd,
        listType: block.listType, nestingLevel: block.nestingLevel, fresh: true,
        ...(textTabs ? { textTabs } : {}),
      };
    }
    let kept = index === 0 ? keptItem : undefined;
    return {
      startIndex: index === 0 && container ? container.docStart : paragraphStart,
      endIndex: paragraphEnd,
      listType: kept?.listType ?? null,
      nestingLevel: kept?.listNestingLevel ?? 0,
      ...(kept?.positioned ? { positioned: true as const } : {}),
      ...(kept?.offPreset ? { offPreset: true as const } : {}),
      ...(kept?.tabbed ? { tabbed: true as const } : {}),
    };
  }), tabId, tabBlocks.slice(0, Math.max(written, 0)));
  return requests;
}

/** A paragraph of a write once its text is laid out, as the bullets are created over it. */
type LaidParagraph = {
  startIndex: number;
  endIndex: number;
  /** The kind of list it is, or is to be, an item of; null for a paragraph outside any list. */
  listType: ListType | null;
  nestingLevel: number;
  /** Set for a paragraph still to be bulleted, which starts with its nesting level in tabs. */
  fresh?: true;
  /** Set for a paragraph of the tab that a positioned object is anchored to. */
  positioned?: true;
  /** Set for an item of a list no new item joins, as `BlockMapping.offPreset` says. */
  offPreset?: true;
  /**
   * The tabs the paragraph's own text starts with, where the write holds that text.
   * `createParagraphBullets` reads them as nesting and removes them, so a fresh paragraph is
   * laid out without them, a paragraph taken in has them counted toward its level, and either
   * way they are written at the start of its text once the bullets are made.
   */
  textTabs?: ParsedBlock;
  /**
   * Set for a paragraph of the tab the write leaves as it is whose text starts with a tab, as
   * `BlockMapping.tabbed` says. It comes as a block mapping, without its text, so it has no
   * `textTabs`.
   */
  tabbed?: true;
};

/** `block` with only its text from `start` to `end`, and the formatting that text has. */
function blockTextSlice(
  block: ParsedBlock, start: number, end = block.plainText.length,
): ParsedBlock {
  return {
    ...block,
    plainText: block.plainText.slice(start, end),
    spans: block.spans.flatMap(span => {
      let from = Math.max(span.start, start);
      let to = Math.min(span.end, end);
      return from < to ? [{ ...span, start: from - start, end: to - start }] : [];
    }),
  };
}

/**
 * The tabs `block`'s text starts with, as the text of a plain paragraph with the formatting
 * they have; undefined when it starts with none.
 */
function leadingTabs(block: ParsedBlock): ParsedBlock | undefined {
  let count = block.plainText.length - block.plainText.replace(/^\t+/, "").length;
  return count === 0 ? undefined
    : { ...blockTextSlice(block, 0, count), headingLevel: null, listType: null };
}

/**
 * The refusal of a new list item that only bulleting again an item before the lines the write
 * changes, whose text starts with a tab, would place.
 */
export const TABBED_ITEM_BEFORE =
  "a list item cannot be written shallower than the list item before it while that item, or " +
  "one between it and an item as shallow, has text that starts with a tab: placing the new " +
  "item would make a list item of that item again, and Google Docs would read its tab as a " +
  "nesting level and remove it. Remove the tab from that item's text first, or write the new " +
  "item at that item's level.";

/** The refusal of a new list item that only rewriting an item with a positioned image would place. */
export const POSITIONED_ITEM_BEFORE =
  "a list item cannot be written shallower than the list item before it while that item, or " +
  "one between it and an item as shallow, holds a positioned image: placing the new item " +
  "would rewrite that item, and whether the image stays with it is not known. Write the item " +
  "at that item's level, or move the image in Google Docs first.";

/** The refusal of a list item written deeper than the last level a list has. */
export const LIST_LEVEL_TOO_DEEP =
  "a list item cannot be written deeper than the ninth nesting level: a list in Google Docs " +
  "has nine levels. Write the item at most that deep, with at most sixteen spaces before its " +
  "marker.";

/**
 * The tabs that write nesting level `level` at the start of a paragraph still to be bulleted,
 * which `createParagraphBullets` counts and removes. Throws `LIST_LEVEL_TOO_DEEP` for a level
 * a list does not have.
 */
function levelTabs(level: number): string {
  // What Google Docs does with a tenth level is not on record, so none is sent. This stands
  // until a recording shows it.
  if (level >= LIST_LEVELS) throw new Error(LIST_LEVEL_TOO_DEEP);
  return "\t".repeat(level);
}

/**
 * Append the requests that make list items of the `fresh` paragraphs of `paragraphs`, which
 * abut in document order; `lead` holds the tab's blocks before the first of them.
 *
 * `createParagraphBullets` does not nest a paragraph by its leading tabs alone. A range joins
 * the list of the item directly before it, and each of its paragraphs lands at that item's
 * level plus its own tabs, less the fewest tabs any paragraph of the range has; a range with
 * no such item before it starts a list and counts from 0. So a run of new items is bulleted
 * as it is only when its shallowest item is at the level of the item before it. Otherwise:
 * - a run with an item shallower than the item before it takes in the items before it, up to
 *   one no deeper than its shallowest: their bullets are removed and their levels written as
 *   tabs, and they are bulleted again with the run, which puts them back in the list they
 *   were in, at their levels; an item a positioned object is anchored to is never taken in,
 *   since what its anchor does then is not on record: the write is refused;
 * - a run whose shallowest item is deeper than the item before it is bulleted behind an
 *   empty paragraph carrying that item's level in tabs, which is deleted afterwards.
 *
 * The tabs an item's own text starts with (`LaidParagraph.textTabs`) would be read as nesting
 * too. A new item is laid out without them; an item taken in has them counted toward its
 * level's tabs; and they are written at the start of the item's text once the bullets are
 * made. An item of `lead` whose text starts with a tab (`tabbed`) comes as a block mapping,
 * without its text, so its tab is not written back: like one a positioned object is anchored
 * to, it is never taken in, and the write is refused.
 *
 * Which list Google joins is on record for lists made by these presets. An item of any other
 * list (`BlockMapping.offPreset`) is taken for one the range does not join, so a run behind it
 * is laid out as a run that starts a list, and the item is never taken in. That is inferred,
 * in `madeByPreset`.
 */
function addBulletRequests(
  requests: any[],
  paragraphs: readonly LaidParagraph[],
  tabId: string,
  lead: readonly BlockMapping[] = [],
): void {
  // The paragraph at `index`; a negative index counts back into `lead`, for as long as its
  // blocks abut: a table or another element between ends the paragraphs a range can join.
  let earlier: LaidParagraph[] = [];
  let at = (index: number): LaidParagraph | undefined => {
    if (index >= 0) return paragraphs[index];
    while (earlier.length < -index) {
      let block = lead[lead.length - 1 - earlier.length];
      if (block?.docEnd !== (earlier.at(-1) ?? paragraphs[0]).startIndex) return undefined;
      earlier.push({
        startIndex: block.docStart, endIndex: block.docEnd,
        listType: block.listType, nestingLevel: block.listNestingLevel,
        ...(block.positioned ? { positioned: true as const } : {}),
        ...(block.offPreset ? { offPreset: true as const } : {}),
        ...(block.tabbed ? { tabbed: true as const } : {}),
      });
    }
    return earlier[-index - 1];
  };
  let insert = (index: number, text: string) =>
    addRequest(requests, { insertText: { location: { index, tabId }, text } });

  // The paragraphs taken in whose own tabs their bullets removed with their level's.
  let rebulleted = new Set<LaidParagraph>();
  // Last to first: creating bullets strips each paragraph's leading tabs, shifting later indices.
  for (let last = paragraphs.length - 1; last >= 0; last--) {
    let { listType } = paragraphs[last];
    if (!paragraphs[last].fresh || listType === null) continue;
    let first = last;
    let shallowest = paragraphs[last].nestingLevel;
    // The level of the item the range joins behind, which its paragraphs' levels count from.
    let level = 0;
    for (;;) {
      let before = at(first - 1);
      if (before?.listType !== listType || before.offPreset) break;
      if (!before.fresh && before.nestingLevel <= shallowest) {
        level = before.nestingLevel;
        break;
      }
      // Another new item of the run, an item deeper than the run's shallowest, or a new item
      // beyond such an item: each is bulleted with the run.
      shallowest = Math.min(shallowest, before.nestingLevel);
      first--;
    }
    let members: LaidParagraph[] = [];
    for (let index = first; index <= last; index++) members.push(at(index)!);
    let { startIndex } = members[0];

    // The items taken in become plain paragraphs that start with their levels in tabs, as the
    // new ones do. Tabs go in last to first, so that no insertion moves one still to be made.
    let taken = members.filter(member => !member.fresh);
    if (taken.some(member => member.positioned)) throw new Error(POSITIONED_ITEM_BEFORE);
    // An item of `lead` whose text starts with a tab is never taken in either: its tab would
    // be read as nesting and removed, and `lead` holds block mappings, not the items' text, so
    // nothing here writes the tab back.
    if (taken.some(member => member.tabbed)) throw new Error(TABBED_ITEM_BEFORE);
    for (let range of coalesceRanges(taken, () => true)) {
      let unlisted = { startIndex: range.startIndex, endIndex: range.endIndex, tabId };
      addRequest(requests, { deleteParagraphBullets: { range: unlisted } });
      // A removed bullet leaves its indent behind.
      addRequest(requests, updateParagraphStyleRequest(unlisted, undefined, true));
    }
    let inserted = 0;
    for (let member of taken.toReversed()) {
      // The tabs its own text starts with count as nesting too. Its level is made up with the
      // tabs it lacks, or the tabs it has over its level are deleted, and its own are written
      // back once the bullets are made.
      let own = member.textTabs?.plainText.length ?? 0;
      let lacking = member.nestingLevel - own;
      if (lacking > 0) insert(member.startIndex, levelTabs(member.nestingLevel).slice(own));
      if (lacking < 0) {
        addRequest(requests, { deleteContentRange: {
          range: { startIndex: member.startIndex, endIndex: member.startIndex - lacking, tabId },
        } });
      }
      inserted += lacking;
      if (own > 0) rebulleted.add(member);
    }
    let scaffold = shallowest > level;
    if (scaffold) {
      insert(startIndex, levelTabs(level) + "\n");
      inserted += level + 1;
    }
    addRequest(requests, {
      createParagraphBullets: {
        range: { startIndex, endIndex: members.at(-1)!.endIndex + inserted, tabId },
        bulletPreset: BULLET_PRESET[listType],
      },
    });
    // Its tabs are stripped with the others', which leaves the empty paragraph's break.
    if (scaffold) {
      addRequest(requests, {
        deleteContentRange: { range: { startIndex, endIndex: startIndex + 1, tabId } },
      });
    }
    last = first;
  }
  // The tabs an item's own text starts with go in at the start of its text once every bullet
  // is made. Each paragraph then starts earlier than it was laid out by what the bullets took
  // off the paragraphs before it: a new item's level in tabs, a taken-in item's own tabs. Last
  // to first, so that no insertion moves one still to be made. That Google Docs keeps a tab
  // written there as text, at the item's level, is not on record: the recorder's scenarios
  // `tab-typed-into-list-item`, `tab-starts-new-list-item` and `tab-item-bulleted-again` are
  // there to record it.
  let removedBefore = 0;
  let writes: { index: number; tabs: ParsedBlock }[] = [];
  for (let paragraph of paragraphs) {
    let { startIndex, nestingLevel, fresh, textTabs } = paragraph;
    let removed = fresh || rebulleted.has(paragraph) ? textTabs : undefined;
    if (removed) writes.push({ index: startIndex - removedBefore, tabs: removed });
    removedBefore += fresh ? nestingLevel : removed?.plainText.length ?? 0;
  }
  for (let { index, tabs } of writes.toReversed()) {
    blocksToDocRequests([tabs], index, tabId, {}, requests);
  }
}

// ---------------------------------------------------------------------------
// Replace operations: map a Markdown edit back to doc operations
// ---------------------------------------------------------------------------

/** The refusal of an edit that touches rendered content `replaceText()` must leave alone. */
export class StructuredContentError extends Error {
  constructor() {
    super("replaceText: structured content cannot be edited. Narrow the match to plain text.");
  }
}

/** Refuse edits that would modify or bridge structural content without a safe source mapping. */
export function assertMarkdownRangeEditable(
  protectedRanges: readonly MarkdownRange[],
  mdStart: number,
  mdEnd: number,
): void {
  if (protectedRanges.some(range => markdownRangeTouches(mdStart, mdEnd, range))) {
    throw new StructuredContentError();
  }
}

/** Where the line that holds `index` starts in `markdown`. */
export function lineStart(markdown: string, index: number): number {
  return index <= 0 ? 0 : markdown.lastIndexOf("\n", index - 1) + 1;
}

/** The kind of list item the line starting at `start` reads as, or `null` for any other line. */
function listLineType(markdown: string, start: number): ListType | null {
  while (markdown[start] === " ") start++;
  if (markdown.startsWith("- ", start)) return "bullet";
  let numberStart = start;
  while (markdown.charCodeAt(start) >= 48 && markdown.charCodeAt(start) <= 57) start++;
  return start > numberStart && markdown.startsWith(". ", start) ? "numbered" : null;
}

type TextEdit = { start: number; end: number; text: string };

function separatorBefore(markdown: string, currentStart: number): TextEdit | undefined {
  let start = currentStart;
  while (start > 0 && markdown[start - 1] === "\n") start--;
  let length = currentStart - start;
  if (start === 0 || length === 0 || markdown[currentStart] === "\n") return undefined;
  let previousType = listLineType(markdown, lineStart(markdown, start - 1));
  let expected = length > 2 ? length + length % 2
    : previousType !== null && previousType === listLineType(markdown, currentStart) ? 1 : 2;
  return length === expected ? undefined : { start, end: currentStart, text: "\n".repeat(expected) };
}

function changedSeparatorBefore(
  markdown: string,
  currentStart: number,
  changeStart: number,
  changeEnd: number,
): TextEdit | undefined {
  let edit = separatorBefore(markdown, currentStart);
  if (edit && edit.end - edit.start === 2 &&
      (edit.end <= changeStart || edit.start >= changeEnd)) return undefined;
  return edit;
}

function nextLineStart(markdown: string, start: number): number | undefined {
  let next = markdown.indexOf("\n", start);
  if (next < 0) return undefined;
  while (markdown[next] === "\n") next++;
  return next < markdown.length ? next : undefined;
}

function normalizeChangedBlockBoundaries(
  markdown: string,
  changeStart: number,
  changeEnd: number,
): string {
  let nextChangedLine = markdown[changeStart] === "\n"
    ? nextLineStart(markdown, changeStart)
    : undefined;
  let first = nextChangedLine !== undefined && nextChangedLine < changeEnd
    ? nextChangedLine
    : lineStart(markdown, changeStart);
  let last = lineStart(markdown, changeEnd > changeStart ? changeEnd - 1 : changeStart);
  let next = nextLineStart(markdown, last);
  let before = changedSeparatorBefore(markdown, first, changeStart, changeEnd);
  let after = next === undefined
    ? undefined
    : changedSeparatorBefore(markdown, next, changeStart, changeEnd);

  for (let edit of [after, before]) {
    if (edit) markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  }
  return markdown;
}

/**
 * Slice rendered Markdown, escaping the parts that came from document text so a re-parse reads
 * them as the literal characters they are. Syntax the renderer emitted is left alone, so it
 * re-parses back into the formatting it stands for.
 */
function literalMarkdownSlice(
  sourceMap: SourceMap,
  markdown: string,
  start: number,
  end: number,
): string {
  let result = "";
  let cursor = start;
  for (let block of sourceMap.blocks) {
    if (block.mdEnd <= start) continue;
    if (block.mdStart >= end) break;
    for (let index = 0; index < block.segments.length; index++) {
      let segment = block.segments[index];
      if ("syntaxOnly" in segment || segment.mdEnd <= start || segment.mdStart >= end) continue;
      let overlapStart = Math.max(start, segment.mdStart);
      let overlapEnd = Math.min(end, segment.mdEnd);
      result += markdown.slice(cursor, overlapStart);
      let content = markdown.slice(overlapStart, overlapEnd);
      let previous = block.segments[index - 1];
      let alreadyEscaped = previous && "syntaxOnly" in previous && previous.mdStart >= start &&
        previous.mdEnd === overlapStart && markdown.slice(previous.mdStart, previous.mdEnd) === "\\";
      result += alreadyEscaped ? content[0] + escapeMarkdownText(content.slice(1))
        : escapeMarkdownText(content);
      cursor = overlapEnd;
    }
  }
  return result + markdown.slice(cursor, end);
}

/**
 * A line opening a heading or list item. `m` so it matches any line of a multi-line string, which
 * is what makes this usable both on caller-supplied Markdown and on one rendered block.
 */
const BLOCK_SYNTAX_LINE = /^(?:#{1,6}| *-| *\d+\.) /m;

function markdownRangeTouches(
  mdStart: number,
  mdEnd: number,
  range: MarkdownRange,
): boolean {
  return mdStart === mdEnd
    ? mdStart >= range.mdStart && mdStart < range.mdEnd
    : mdStart < range.mdEnd && mdEnd > range.mdStart;
}

type BlockReplacementRange = MarkdownRange & {
  docStart: number;
  docEnd: number;
  blocks: BlockMapping[];
};

type DocRange = { start: number; end: number; startsAfterParagraph?: true };

function blockReplacementRange(
  sourceMap: SourceMap,
  mdStart: number,
  mdEnd: number,
  force: boolean,
  deletesBreak: boolean,
): BlockReplacementRange | undefined {
  let replaceWholeBlocks = force || deletesBreak;
  let blocks: BlockMapping[] = [];

  for (let block of sourceMap.blocks) {
    if (block.mdStart > mdEnd) break;
    // A deleted break joins the blocks on either side of it, so those count as touched.
    if (deletesBreak ? block.mdEnd < mdStart : !markdownRangeTouches(mdStart, mdEnd, block)) {
      continue;
    }
    blocks.push(block);
    replaceWholeBlocks ||= block.segments.some(segment =>
      "syntaxOnly" in segment && markdownRangeTouches(mdStart, mdEnd, segment));
  }
  replaceWholeBlocks ||= blocks.length > 1;
  let first = blocks[0];
  let last = blocks.at(-1);
  if (!replaceWholeBlocks || !first || !last) return undefined;
  return {
    mdStart: first.mdStart,
    mdEnd: last.mdEnd,
    docStart: first.docStart,
    docEnd: Math.max(last.docStart, last.docEnd - 1),
    blocks,
  };
}

function textStylesEqual(left: TextStyle, right: TextStyle): boolean {
  return left.bold === right.bold && left.italic === right.italic &&
    left.strikethrough === right.strikethrough &&
    docsLinkDestination(left.link) === docsLinkDestination(right.link);
}

function mappedTextStyle(
  sourceMap: SourceMap,
  mdStart: number,
  mdEnd: number,
): TextStyle | undefined {
  let preceding: TextStyle | undefined;
  let matched: TextStyle | undefined;
  for (let block of sourceMap.blocks) {
    // Inclusive: a block ending exactly at an insertion point still supplies `preceding`.
    if (block.mdEnd < mdStart) continue;
    if (block.mdStart > mdEnd) break;
    for (let segment of block.segments) {
      if ("syntaxOnly" in segment) continue;
      if (markdownRangeTouches(mdStart, mdEnd, segment)) {
        if (mdStart === mdEnd) return structuredClone(segment.textStyle);
        if (matched && !textStylesEqual(matched, segment.textStyle)) return undefined;
        matched ??= segment.textStyle;
      } else if (mdStart === mdEnd && mdStart === segment.mdEnd) {
        preceding = segment.textStyle;
      }
    }
  }
  // A copy: the model changes the elements a rendering was made from in place, and a batch
  // is stored and sent as it was built.
  let found = matched ?? preceding;
  return found && structuredClone(found);
}

/**
 * Where the lines start that the trimmed range `[mdStart, mdEnd)` takes whole, when it ends in
 * front of a list item's line break: at `mdStart` where a block starts there, and at the start
 * of a list item's line where only the item's indentation lies before `mdStart` (the item
 * quoted from its marker). Undefined for every other range.
 */
function itemLinesStart(
  sourceMap: SourceMap, markdown: string, mdStart: number, mdEnd: number,
): number | undefined {
  let { blocks } = sourceMap;
  // By its place first: of the tab's blocks, only the one that ends there is read.
  if (!blocks.some(block => block.mdEnd - 1 === mdEnd && block.listType !== null)) return undefined;
  let first = blocks.find(block => block.mdStart <= mdStart && mdStart < block.mdEnd);
  if (!first) return undefined;
  let indented = first.listType !== null && /^ +$/.test(markdown.slice(first.mdStart, mdStart));
  return first.mdStart === mdStart || indented ? first.mdStart : undefined;
}

/**
 * Compute the batch-update operations that replace one range in a tab's Markdown rendering.
 *
 * Unchanged leading and trailing text is trimmed before document indices are calculated;
 * `trimmedOld` and `trimmedNew` report what was left to change after that trimming.
 */
export function computeReplaceOperations(
  sourceMap: SourceMap,
  markdown: string,
  matchStart: number,
  matchEnd: number,
  newMarkdown: string,
  tabId: string,
): { requests: any[]; trimmedOld: string; trimmedNew: string } {
  let oldText = markdown.slice(matchStart, matchEnd);
  if (oldText === newMarkdown) {
    return { requests: [], trimmedOld: "", trimmedNew: "" };
  }
  assertMarkdownEscapeBoundaries(markdown, matchStart, matchEnd);
  let { prefixLen, suffixLen } = markdownReplacementBounds(oldText, newMarkdown);

  let trimmedMatchStart = matchStart + prefixLen;
  let trimmedMatchEnd = matchEnd - suffixLen;
  let trimmedNew = newMarkdown.slice(prefixLen, newMarkdown.length - suffixLen);
  let trimmedOld = oldText.slice(prefixLen, oldText.length - suffixLen);
  assertMarkdownRangeEditable(sourceMap.protectedRanges, trimmedMatchStart, trimmedMatchEnd);

  let rewriteRange = (start: number, end: number, crossesBreak: boolean): any[] | undefined => {
    let rewrite = blockRewrite(sourceMap, markdown, start, end, trimmedNew, crossesBreak);
    return rewrite &&
      rewriteBlocks(sourceMap, markdown, rewrite.blockRange.blocks, rewrite.targets, tabId);
  };
  let rewritten: any[] | undefined;
  // Lines replaced by nothing up to the end of a list item's text go whole, with that item's
  // line break, as they do when the break is quoted too: without it the first line's paragraph
  // would stay, empty, and where it is a list item's, out of its list, which splits the list.
  let linesStart = trimmedNew === ""
    ? itemLinesStart(sourceMap, markdown, trimmedMatchStart, trimmedMatchEnd) : undefined;
  if (linesStart !== undefined) {
    try {
      assertMarkdownRangeEditable(sourceMap.protectedRanges, linesStart, trimmedMatchEnd + 1);
      rewritten = rewriteRange(linesStart, trimmedMatchEnd + 1, true);
    } catch (error) {
      // Where the builders refuse the lines with the break (they end their section behind an
      // item of another level or list, or a line beside them cannot be edited), the lines are
      // replaced without it, below. Anything else thrown is not a refusal.
      let refused = error instanceof StructuredContentError ||
        error instanceof Error && Object.getPrototypeOf(error) === Error.prototype;
      if (!refused) throw error;
    }
  }
  rewritten ??= rewriteRange(
    linesStart ?? trimmedMatchStart, trimmedMatchEnd, trimmedOld.includes("\n"));
  if (rewritten) return { requests: rewritten, trimmedOld, trimmedNew };

  let { docRange, insertMarkdown, writeOptions } =
    inlineWrite(sourceMap, markdown, trimmedMatchStart, trimmedMatchEnd, trimmedNew);
  if (!docRange.startsAfterParagraph) {
    writeOptions.sourceTextStyle = mappedTextStyle(sourceMap, trimmedMatchStart, trimmedMatchEnd);
  }

  let requests: any[] = [];
  if (docRange.start < docRange.end) {
    addRequest(requests, {
      deleteContentRange: {
        range: { startIndex: docRange.start, endIndex: docRange.end, tabId },
      },
    });
  }
  if (insertMarkdown.length > 0) {
    blocksToDocRequests(
      parseMarkdownForWrite(insertMarkdown), docRange.start, tabId, writeOptions, requests);
  }
  return { requests, trimmedOld, trimmedNew };
}

/**
 * Where a trimmed replacement that edits inside a paragraph writes, what it writes there, and how:
 * whether its first paragraph keeps the style of the one written into.
 */
function inlineWrite(
  sourceMap: SourceMap, markdown: string, trimmedMatchStart: number, trimmedMatchEnd: number,
  trimmedNew: string,
): { docRange: DocRange; insertMarkdown: string; writeOptions: MarkdownWriteOptions } {
  let docRange = mdRangeToDocRange(sourceMap, trimmedMatchStart, trimmedMatchEnd);
  if (!docRange) {
    throw new Error(
      "replaceText: could not map the Markdown range to document indices. " +
      "The match may span unsupported content.");
  }
  let insertMarkdown = fragmentInsertMarkdown(
    markdown, trimmedMatchStart, trimmedMatchEnd, trimmedNew, docRange.startsAfterParagraph);
  let preserveTrailingNewline = /[^\n]\n+$/.test(insertMarkdown);
  // Paragraphs split off the one written into would inherit its list and style. Text that ends in
  // a break, written at the start of a paragraph's line, before any marker, holds only paragraphs
  // split off ahead of it. Written after a marker it is inside the item or heading, which its
  // first paragraph then is.
  let start = docRange.start;
  let atLineStart = trimmedMatchStart === 0 || markdown[trimmedMatchStart - 1] === "\n";
  let ahead = !docRange.startsAfterParagraph && preserveTrailingNewline && atLineStart
    ? sourceMap.blocks.find(block => block.docStart === start) : undefined;
  // Written inside a paragraph, such text splits off the rest of it, which the Markdown shows as
  // a plain paragraph.
  let { end } = docRange;
  let split = !ahead && preserveTrailingNewline && !docRange.startsAfterParagraph
    ? sourceMap.blocks.find(block => block.docStart <= end && end < block.docEnd) : undefined;
  let restyle = split !== undefined && split.namedStyleType !== "NORMAL_TEXT";
  // A subtitle's text reads italic by its style where the style makes it so, and normal text
  // would not, which the write cannot tell.
  if (split?.namedStyleType === "SUBTITLE" && end < split.docEnd - 1) {
    throw new Error(
      "replaceText: a paragraph break written inside a subtitle would make the rest of it a " +
      "normal paragraph, without the subtitle's look. Write the break at the subtitle's end, " +
      "or replace the whole subtitle.");
  }
  let runs: { start: number; end: number; textStyle: TextStyle }[] = [];
  for (let segment of restyle ? split!.segments : []) {
    if ("syntaxOnly" in segment) continue;
    let from = Math.max(segment.docStart, end);
    let to = Math.min(segment.docEnd, split!.docEnd - 1);
    let { bold, italic, strikethrough, link } = segment.textStyle;
    let textStyle: TextStyle = {
      ...bold ? { bold } : {}, ...italic ? { italic } : {},
      ...strikethrough ? { strikethrough } : {}, ...link ? { link } : {},
    };
    if (from < to && Object.keys(textStyle).length > 0) {
      runs.push({ start: from - end, end: to - end, textStyle });
    }
  }
  return {
    docRange, insertMarkdown,
    writeOptions: {
      resetParagraphs: true,
      // A removed bullet leaves its indent behind.
      resetIndent: ahead?.listId !== undefined,
      preserveLeadingParagraph: !ahead ||
        ahead.listId === undefined && ahead.namedStyleType === "NORMAL_TEXT",
      preserveTrailingNewline,
      // The tab's blocks, as an append has them: the list item the write starts behind, and
      // the items before it, decide the level a new list item is bulleted at.
      tabBlocks: sourceMap.blocks,
      ...(split && (restyle || split.listId !== undefined)
        ? { resetTrailingParagraph: { list: split.listId !== undefined, restyle, runs } } : {}),
    },
  };
}

function newlineRun(text: string, index: number, step: 1 | -1): number {
  let count = 0;
  while (text[index + count * step] === "\n") count++;
  return count;
}

/**
 * Resize the newline runs at a fragment's edges so that, joined with the newlines around the edit,
 * each side holds as many paragraph breaks as its whole run renders. After a paragraph, the edit
 * lands before that paragraph's own break, so every existing break follows it.
 */
function fragmentInsertMarkdown(
  markdown: string,
  start: number,
  end: number,
  fragment: string,
  startsAfterParagraph = false,
): string {
  let breaks = (run: number) => Math.ceil(run / 2);
  let before = newlineRun(markdown, start - 1, -1);
  let after = newlineRun(markdown, end, 1);
  let existing = breaks(before + after);
  let lead = newlineRun(fragment, 0, 1);
  if (lead === fragment.length) return "\n".repeat(breaks(before + lead + after) - existing);
  let trail = newlineRun(fragment, fragment.length - 1, -1);
  let [precedingBreaks, followingBreaks] = startsAfterParagraph
    ? [0, existing]
    : [breaks(before), breaks(after)];
  return "\n".repeat(breaks(before + lead) - precedingBreaks) +
    fragment.slice(lead, fragment.length - trail) +
    "\n".repeat(Math.max(0, breaks(trail + after) - followingBreaks));
}

/**
 * The whole blocks a trimmed replacement rewrites, and the blocks it writes in their place, when it
 * takes that path: when it writes block syntax or crosses a paragraph break.
 */
function blockRewrite(
  sourceMap: SourceMap, markdown: string, trimmedMatchStart: number, trimmedMatchEnd: number,
  trimmedNew: string, crossesBreak: boolean,
): { blockRange: NonNullable<ReturnType<typeof blockReplacementRange>>; targets: ParsedBlock[] } | undefined {
  let blockRange = blockReplacementRange(
    sourceMap, trimmedMatchStart, trimmedMatchEnd, BLOCK_SYNTAX_LINE.test(trimmedNew), crossesBreak,
  );
  if (!blockRange) return undefined;
  assertMarkdownRangeEditable(sourceMap.protectedRanges, blockRange.mdStart, blockRange.mdEnd - 1);
  let rewritten = (
    literalMarkdownSlice(sourceMap, markdown, blockRange.mdStart, trimmedMatchStart) +
    trimmedNew +
    literalMarkdownSlice(sourceMap, markdown, trimmedMatchEnd, blockRange.mdEnd)
  ).replace(/\n$/, "");
  // Leading newlines extend the separator before the range, which already holds its breaks.
  let lead = newlineRun(rewritten, 0, 1);
  let before = newlineRun(markdown, blockRange.mdStart - 1, -1);
  let blockMarkdown = "\n".repeat(Math.ceil((before + lead) / 2) - Math.ceil(before / 2)) +
    rewritten.slice(lead);
  // The range's last block ends at its final break, so each break a trailing run renders after
  // the text adds an empty paragraph.
  let trail = /[^\n]\n+$/.test(blockMarkdown)
    ? newlineRun(blockMarkdown, blockMarkdown.length - 1, -1) : 0;
  let targets = parseMarkdownForWrite(blockMarkdown.slice(0, blockMarkdown.length - trail));
  for (let empty = 0; empty < Math.ceil(trail / 2); empty++) targets.push(parseLine(""));
  return { blockRange, targets };
}

/**
 * Rewrite whole source blocks paragraph by paragraph, so each kept paragraph keeps its own list and
 * style. Requests run from the end of the range backwards, so earlier indices stay valid.
 */
function rewriteBlocks(
  sourceMap: SourceMap,
  markdown: string,
  sources: BlockMapping[],
  targets: ParsedBlock[],
  tabId: string,
): any[] {
  let requests: any[] = [];
  let links = sourceLinks(sources);
  // Bullets are created once the whole range is laid out: Google joins a new list only to the list
  // before it, and pairs are written last to first.
  let bulleted = new Set<number>();
  let keptLengths = new Map<number, number>();
  // The source paragraph each target is left as or written into.
  let containers: BlockMapping[] = [];
  let write = (blocks: ParsedBlock[], first: number, at: number, container: BlockMapping,
    options: MarkdownWriteOptions = {}, pairedIndex?: number) => blocksToDocRequests(blocks, at,
    tabId, {
      ...options, resetParagraphs: true,
      source: { blocks: sources, links, markdown, container, pairedIndex },
      bulleted: index => bulleted.add(first + index),
    }, requests);
  let remove = (startIndex: number, endIndex: number) =>
    addRequest(requests, { deleteContentRange: { range: { startIndex, endIndex, tabId } } });

  let blockStarts = new Set(sourceMap.blocks.map(block => block.docStart));
  let pairs = alignSourceBlocks(sources, targets, markdown);
  for (let index = pairs.length - 1; index >= 0; index--) {
    let [s, t] = pairs[index];
    let [nextSource, nextTarget] = pairs[index + 1] ?? [sources.length, targets.length];
    let source = sources[s];
    let removed = sources.slice(s + 1, nextSource);
    let last = removed.at(-1);
    if (last && (nextSource < sources.length ||
        blockStarts.has(last.docEnd))) {
      remove(removed[0].docStart, last.docEnd);
    } else if (last) {
      // The paragraph break before a table or at the tab's end can't be deleted, so the kept
      // paragraph merges into it and takes on formatting that must match or be repairable.
      if (source.listId !== undefined && (source.listId !== last.listId ||
          source.listNestingLevel !== last.listNestingLevel)) {
        throw new Error(
          "replaceText: cannot keep a list item while deleting the paragraphs that end its " +
          "section. Delete them in an edit that leaves the list item alone.");
      }
      remove(source.docEnd - 1, last.docEnd - 1);
      let clearList = source.listId === undefined && last.listId !== undefined;
      if (clearList) {
        addRequest(requests, { deleteParagraphBullets: {
          range: { startIndex: source.docStart, endIndex: source.docEnd, tabId },
        } });
      }
      if (clearList || source.namedStyleType !== last.namedStyleType) {
        addRequest(requests, updateParagraphStyleRequest(
          { startIndex: source.docStart, endIndex: source.docEnd, tabId },
          source.namedStyleType, clearList));
      }
    }

    let before = index === 0 ? targets.slice(0, t) : [];
    let after = targets.slice(t + 1, nextTarget);
    for (let target = t - before.length; target < nextTarget; target++) containers[target] = source;
    if (isUnchangedBlock(source, targets[t], markdown)) {
      keptLengths.set(t, source.docEnd - source.docStart);
      if (after.length > 0) {
        write([parseLine(""), ...after], t, source.docEnd - 1, source,
          { preserveLeadingParagraph: true });
      }
      if (before.length > 0) {
        write(before, 0, source.docStart, source, { preserveTrailingNewline: true });
      }
    } else {
      if (source.docStart < source.docEnd - 1) remove(source.docStart, source.docEnd - 1);
      write([...before, targets[t], ...after], t - before.length, source.docStart, source, {},
        before.length);
    }
  }
  if (pairs[0][0] > 0) remove(sources[0].docStart, sources[pairs[0][0]].docStart);
  let offset = sources[0].docStart;
  // A target that is not bulleted here is the list item it reads as: it is left as it was, or
  // it keeps the list of the paragraph it was written into.
  addBulletRequests(requests, targets.map((target, index): LaidParagraph => {
    let startIndex = offset;
    let isNew = bulleted.has(index);
    let textTabs = leadingTabs(target);
    // A new item is laid out behind its level's tabs and without the tabs of its own text.
    offset += keptLengths.get(index) ?? (isNew
      ? target.nestingLevel - (textTabs?.plainText.length ?? 0) : 0) + target.plainText.length + 1;
    return {
      startIndex, endIndex: offset, listType: target.listType,
      nestingLevel: target.nestingLevel, ...(isNew ? { fresh: true as const } : {}),
      ...(textTabs ? { textTabs } : {}),
      ...(!isNew && containers[index].offPreset ? { offPreset: true as const } : {}),
    };
  }), tabId, sourceMap.blocks.slice(0, sourceMap.blocks.indexOf(sources[0])));
  return requests;
}

/**
 * Map a Markdown character range [mdStart, mdEnd) to a Google Docs
 * character range, using the source map.
 *
 * Content segments have 1:1 character mapping between Markdown and Doc.
 * Syntax-only segments (Markdown markers like "**", "# ") have no Doc
 * counterpart. If the range falls entirely within syntax-only segments,
 * we expand to the surrounding content boundaries.
 */
function mdRangeToDocRange(
  sourceMap: SourceMap,
  mdStart: number,
  mdEnd: number,
): DocRange | null {
  if (mdStart === mdEnd) {
    let precedingBlock = sourceMap.blocks.find(block => block.mdEnd === mdStart);
    if (precedingBlock) {
      let index = Math.max(precedingBlock.docStart, precedingBlock.docEnd - 1);
      return { start: index, end: index, startsAfterParagraph: true };
    }
    let docIndex = mdPointToDocIndex(sourceMap, mdStart);
    return docIndex === null ? null : { start: docIndex, end: docIndex };
  }

  let docStart: number | null = null;
  let docEnd: number | null = null;

  for (let block of sourceMap.blocks) {
    // Skip blocks entirely before or after our range.
    if (block.mdEnd <= mdStart) continue;
    if (block.mdStart >= mdEnd) break;

    for (let seg of block.segments) {
      // Skip segments entirely outside our range.
      if (seg.mdEnd <= mdStart) continue;
      if (seg.mdStart >= mdEnd) break;

      if ("syntaxOnly" in seg) {
        // Syntax-only segment overlaps the range. We can't map to doc indices
        // directly, but we need to extend to the nearest content boundary.
        // Use the block's doc range as a fallback.
        if (docStart === null) docStart = block.docStart;
        docEnd = block.docEnd;
        continue;
      }

      // Content segment — compute the overlapping doc range.
      let overlapMdStart = Math.max(mdStart, seg.mdStart);
      let overlapMdEnd = Math.min(mdEnd, seg.mdEnd);

      // 1:1 character mapping within content segments.
      let segDocStart = seg.docStart + (overlapMdStart - seg.mdStart);
      let segDocEnd = seg.docStart + (overlapMdEnd - seg.mdStart);

      if (docStart === null || segDocStart < docStart) docStart = segDocStart;
      if (docEnd === null || segDocEnd > docEnd) docEnd = segDocEnd;
    }
  }

  if (docStart === null || docEnd === null) return null;
  return { start: docStart, end: docEnd };
}

function mdPointToDocIndex(sourceMap: SourceMap, mdPoint: number): number | null {
  for (let block of sourceMap.blocks) {
    if (mdPoint < block.mdStart) continue;
    if (mdPoint > block.mdEnd) continue;

    let preceding: number | undefined;
    for (let seg of block.segments) {
      if ("syntaxOnly" in seg) continue;
      if (mdPoint < seg.mdStart) return preceding ?? seg.docStart;
      if (mdPoint <= seg.mdEnd) return seg.docStart + (mdPoint - seg.mdStart);
      preceding = seg.docEnd;
    }

    if (preceding !== undefined) return preceding;
    return block.docStart;
  }

  return null;
}
