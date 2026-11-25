// The copy of a Google Doc the Doc gatekeeper keeps between reads: each tab pruned to what the
// Markdown rendering and the model of `documents.batchUpdate` read, in Google's own shape, and
// what of a fetched document is kept (`./docs-store` stores it, `./docs-copy` keeps it fresh).
// Pending edits are replayed on it (`./docs-replay`).

import type {
  Bullet, Dimension, DocList, GoogleDocsDocument, GoogleDocsTab, NamedStyles, NestingLevel,
  OptionalColor, Paragraph, ParagraphElement, StructuralElement, Table, TableCell,
  TableCellBorder, TableCellStyle, TableRow, TextRun,
} from "./docs-api";
import { modelFollowing } from "./docs-model";
import type { ModelFollowing, ModelParagraphStyle, ModelTextStyle } from "./docs-model";
import { cutRuns, RUN_SIZES } from "./docs-runs";
import type { CutRun, RunSizes } from "./docs-runs";

/**
 * Version of the stored copy: of what `pruneTab` keeps, of the rows `DocStore` writes for a
 * tab, their tables' columns included (a store opened under another version makes its tables
 * again), and of the form a run is stored in (`cutRuns`). Bump it with any change to one of
 * them. A stored copy whose revision Google confirms is served
 * without being fetched again, so under an unchanged version a copy pruned by another whitelist
 * would go on lacking a field the rendering or the model reads. What code derives of a stored
 * tab is versioned apart, by the digest of that code (`DOC_DERIVED`).
 */
export const DOC_COPY_FORMAT_VERSION = 12;

// ---------------------------------------------------------------------------
// Named ranges and write markers
// ---------------------------------------------------------------------------

/** Name prefix of the named range that marks one write. Permanent: retries match on it. */
const WRITE_MARKER_PREFIX = "gadgets-write-";

/** A named range of a tab: its id, and its name (the collection's key where it has none). */
type GoogleDocNamedRange = { id: string; name: string };

/** The named ranges of a tab as Google returned it. Throws for a collection that is malformed. */
export function googleDocNamedRanges(tab: GoogleDocsTab): GoogleDocNamedRange[] {
  let result: GoogleDocNamedRange[] = [];
  for (const [fallbackName, collection] of Object.entries<unknown>(tab.namedRanges)) {
    if (!collection || typeof collection !== "object") {
      throw new Error("Google Docs returned invalid named ranges");
    }
    let ranges = (collection as { namedRanges?: unknown }).namedRanges;
    if (!Array.isArray(ranges)) {
      throw new Error("Google Docs returned invalid named ranges");
    }
    for (const range of ranges) {
      if (!range || typeof range !== "object") {
        throw new Error("Google Docs returned an invalid named range");
      }
      let {namedRangeId, name} = range as { namedRangeId?: unknown; name?: unknown };
      if (typeof namedRangeId !== "string" || namedRangeId.length === 0 ||
          (name !== undefined && typeof name !== "string")) {
        throw new Error("Google Docs returned an invalid named range");
      }
      result.push({ id: namedRangeId, name: name ?? fallbackName });
    }
  }
  return result;
}

/** The ids of the tab's named ranges called `name`. */
export function googleDocNamedRangeIds(tab: GoogleDocsTab, name: string): string[] {
  let ids = new Set<string>();
  for (let range of googleDocNamedRanges(tab)) {
    if (range.name === name) ids.add(range.id);
  }
  return [...ids];
}

/** The named range that marks one write, named so the write is recognizable on a retry. */
export function googleDocWriteMarkerName(writeId: string): string {
  return `${WRITE_MARKER_PREFIX}${writeId}`;
}

/** A write marker a tab held when it was fetched. */
export type DocWriteMarkerCopy = {
  /** The id of the write the marker names (`googleDocWriteMarkerName`). */
  readonly writeId: string;
  /** The id of the marker's named range, which deleting it names. */
  readonly id: string;
};

/**
 * The write markers of `tab`, as Google returned it, in the order it listed them. A marker and
 * its content go up in one atomic batch, so a marker naming a write id proves that write
 * committed, also where its response was lost and its action is still pending.
 */
function googleDocWriteMarkers(tab: GoogleDocsTab): DocWriteMarkerCopy[] {
  let markers: DocWriteMarkerCopy[] = [];
  for (let { id, name } of googleDocNamedRanges(tab)) {
    if (!name.startsWith(WRITE_MARKER_PREFIX)) continue;
    let writeId = name.slice(WRITE_MARKER_PREFIX.length);
    if (!markers.some(marker => marker.writeId === writeId && marker.id === id)) {
      markers.push({ writeId, id });
    }
  }
  return markers;
}

// ---------------------------------------------------------------------------
// What the copy keeps
//
// One table says what the copy keeps of each part of a tab. `pruneTab` and the fields asked of
// `documents.get` (`DOC_TAB_FIELDS`) are both read off it, so a field the copy keeps is a field
// Google is asked for. A part's fields are listed in the order the copy writes them.
//
// A part that has a type of its own is checked against it (`FieldsOf`): a name the type does not
// have does not compile. The fields of a part typed inline, which the table writes inline too
// (what a colour holds, a link's bookmark and heading, a paragraph element that is not a text
// run, a row's and a table's style, a list's properties, a named style, the body), are held by
// `docs-replica.test.ts`, which pins the fields a pruned tab holds and the text of the fields
// asked of Google.
// ---------------------------------------------------------------------------

/** What the copy keeps of one field of a part, and how `documents.get` can be asked for it. */
type Keep =
  /** A primitive, kept where Google sent one. */
  | { readonly kind: "value" }
  /** A list of primitives, copied where Google sent one. */
  | { readonly kind: "values" }
  /**
   * A part, pruned to `fields`; with no fields, `{}` for a part that is there. Where Google sent
   * none it is left out, unless `absent` says it is pruned as if it were `{}` (`"empty"`) or
   * that the tab is refused (`"throw"`). `whole`: Google is asked for the part by its name alone,
   * and not field by field: a part of which the table names every field Google has (a length, a
   * colour), or one that few paragraphs hold and that is small (a chip, a break). A part with no
   * fields is asked for by its name alone too, so that its being there never rests on what Google
   * answers for a part that has none of the fields asked of it.
   */
  | {
    readonly kind: "part";
    readonly fields: Fields;
    readonly absent?: "empty" | "throw";
    readonly whole?: true;
  }
  /**
   * A list of parts, each pruned to `fields`; `absent` as for a part, `"empty"` giving `[]`.
   * `nested`: the list holds body elements again (a cell's content), which Google is asked for
   * field by field only `MASKED_TABLE_LEVELS` tables deep, and whole below that.
   */
  | {
    readonly kind: "parts";
    readonly fields: Fields | (() => Fields);
    readonly absent?: "empty" | "throw";
    readonly nested?: true;
  }
  /**
   * A map keyed by id, each value pruned to `fields`. Google refuses a selection inside such a
   * map, so it is asked for whole.
   */
  | {
    readonly kind: "map";
    readonly fields: Fields;
    /** Absent from the copy where Google leaves it out; otherwise its absence is refused. */
    readonly absent?: "skip";
  }
  /**
   * Asked of Google for a reader other than the pruning, and `{}` in the copy: the named ranges,
   * of which `fetchedDoc` keeps the write markers beside the tab.
   */
  | { readonly kind: "read" }
  /**
   * What names and places a tab, kept where it is set. `GoogleDocsApi.getDocument` works it out
   * of the tab tree, so it is no field of the tab's content and is not asked for with it.
   */
  | { readonly kind: "given" };

/** The fields the copy keeps of one kind of part, in the order it writes them. */
type Fields = { readonly [field: string]: Keep };

/** `Fields` of a part of type `T`: a field `T` does not have does not compile. */
type FieldsOf<T> = { readonly [K in keyof T]?: Keep };

const value: Keep = { kind: "value" };
const values: Keep = { kind: "values" };
const given: Keep = { kind: "given" };
/** Only that the part is there. */
const present: Keep = { kind: "part", fields: {} };
const part = (fields: Fields): Keep => ({ kind: "part", fields });
/** A part Google is asked for whole. */
const whole = (fields: Fields): Keep => ({ kind: "part", fields, whole: true });
const parts = (fields: Fields): Keep => ({ kind: "parts", fields });

const DIMENSION = whole({ magnitude: value, unit: value } satisfies FieldsOf<Dimension>);

const COLOR = whole({
  color: part({ rgbColor: part({ red: value, green: value, blue: value }) }),
} satisfies FieldsOf<OptionalColor>);

/** A link's target, under whichever of Google's names it came. */
const LINK = whole({
  url: value, tabId: value, bookmarkId: value, headingId: value,
  bookmark: part({ id: value, tabId: value }),
  heading: part({ id: value, tabId: value }),
} satisfies FieldsOf<NonNullable<ModelTextStyle["link"]>>);

const TEXT_STYLE = {
  bold: value, italic: value, strikethrough: value, underline: value,
  link: LINK, foregroundColor: COLOR, fontSize: DIMENSION,
} satisfies FieldsOf<ModelTextStyle>;

/** The text style of an element that is not a text run, kept where it has one. */
const textStyle = part(TEXT_STYLE);

// What an element that is not text keeps of the suggestions it is part of, by ID: deleting its cell
// would discard them.
const ELEMENT_SUGGESTIONS = {
  suggestedInsertionIds: values,
  suggestedDeletionIds: values,
  suggestedTextStyleChanges: { kind: "map", fields: {}, absent: "skip" },
} satisfies Fields;

const PARAGRAPH_ELEMENT = {
  startIndex: value,
  endIndex: value,
  // The rendering reads a text run's style unguarded, so it is `{}` where Google sent none.
  textRun: part({
    content: value,
    textStyle: { kind: "part", fields: TEXT_STYLE, absent: "empty" },
    // The suggestions on the text, by ID: an edit of the text would discard them.
    suggestedInsertionIds: values,
    suggestedDeletionIds: values,
    suggestedTextStyleChanges: { kind: "map", fields: {}, absent: "skip" },
  } satisfies FieldsOf<TextRun>),
  autoText: whole({ type: value, textStyle, ...ELEMENT_SUGGESTIONS }),
  horizontalRule: whole(ELEMENT_SUGGESTIONS),
  pageBreak: whole({ textStyle, ...ELEMENT_SUGGESTIONS }),
  columnBreak: whole({ textStyle, ...ELEMENT_SUGGESTIONS }),
  footnoteReference: whole({ footnoteId: value, footnoteNumber: value, textStyle, ...ELEMENT_SUGGESTIONS }),
  equation: whole(ELEMENT_SUGGESTIONS),
  inlineObjectElement: whole({ inlineObjectId: value, textStyle, ...ELEMENT_SUGGESTIONS }),
  // A chip keeps, by ID, the changes to its properties suggested as well.
  person: whole({
    textStyle, personProperties: part({ name: value, email: value }), ...ELEMENT_SUGGESTIONS,
    suggestedPersonPropertiesChanges: { kind: "map", fields: {}, absent: "skip" },
  }),
  richLink: whole({
    textStyle, richLinkProperties: part({ title: value, uri: value }), ...ELEMENT_SUGGESTIONS,
    suggestedRichLinkPropertiesChanges: { kind: "map", fields: {}, absent: "skip" },
  }),
  dateElement: whole({
    textStyle, dateElementProperties: part({ displayText: value }), ...ELEMENT_SUGGESTIONS,
    suggestedDateElementPropertiesChanges: { kind: "map", fields: {}, absent: "skip" },
  }),
  dropdown: whole({
    dropdownId: value,
    textStyle,
    ...ELEMENT_SUGGESTIONS,
    dropdownProperties: part({
      dropdownDefinitionId: value, selectedOptionId: value, displayValue: value,
    }),
    suggestedDropdownPropertiesChanges: { kind: "map", fields: {}, absent: "skip" },
  }),
} satisfies FieldsOf<ParagraphElement>;

const PARAGRAPH_STYLE = {
  namedStyleType: value, headingId: value, alignment: value,
  indentStart: DIMENSION, indentFirstLine: DIMENSION,
} satisfies FieldsOf<ModelParagraphStyle>;

const PARAGRAPH = {
  elements: { kind: "parts", fields: PARAGRAPH_ELEMENT, absent: "throw" },
  paragraphStyle: { kind: "part", fields: PARAGRAPH_STYLE, absent: "throw" },
  bullet: part({ listId: value, nestingLevel: value } satisfies FieldsOf<Bullet>),
  positionedObjectIds: values,
  // The suggested changes to the paragraph's style and bullet, by ID, as for a text run.
  suggestedParagraphStyleChanges: { kind: "map", fields: {}, absent: "skip" },
  suggestedBulletChanges: { kind: "map", fields: {}, absent: "skip" },
} satisfies FieldsOf<Paragraph>;

const BORDER = part({
  color: COLOR, width: DIMENSION, dashStyle: value,
} satisfies FieldsOf<TableCellBorder>);

/** The ids of the suggestions that would insert or delete a table, a row or a cell. */
const SUGGESTIONS = {
  suggestedInsertionIds: values, suggestedDeletionIds: values,
} satisfies FieldsOf<Table | TableRow | TableCell>;

const CELL_STYLE = {
  rowSpan: value, columnSpan: value, contentAlignment: value,
  backgroundColor: COLOR,
  paddingTop: DIMENSION, paddingRight: DIMENSION, paddingBottom: DIMENSION, paddingLeft: DIMENSION,
  borderTop: BORDER, borderRight: BORDER, borderBottom: BORDER, borderLeft: BORDER,
} satisfies FieldsOf<TableCellStyle>;

const CELL = {
  startIndex: value,
  endIndex: value,
  content: { kind: "parts", fields: (): Fields => BODY_ELEMENT, nested: true },
  tableCellStyle: whole(CELL_STYLE),
  ...SUGGESTIONS,
  // Which style changes are suggested, by ID: a deletion of the cell would discard them.
  suggestedTableCellStyleChanges: { kind: "map", fields: {}, absent: "skip" },
} satisfies FieldsOf<TableCell>;

const ROW = {
  startIndex: value,
  endIndex: value,
  tableCells: parts(CELL),
  tableRowStyle: part({ tableHeader: value, minRowHeight: DIMENSION }),
  ...SUGGESTIONS,
  suggestedTableRowStyleChanges: { kind: "map", fields: {}, absent: "skip" },
} satisfies FieldsOf<TableRow>;

const TABLE = {
  tableRows: parts(ROW),
  tableStyle: whole({ tableColumnProperties: parts({ widthType: value, width: DIMENSION }) }),
  ...SUGGESTIONS,
} satisfies FieldsOf<Table>;

/** A start index is kept only where Google sent one: it leaves out one of 0. */
const BODY_ELEMENT = {
  startIndex: value,
  endIndex: value,
  paragraph: part(PARAGRAPH),
  table: part(TABLE),
  sectionBreak: present,
  tableOfContents: present,
} satisfies FieldsOf<StructuralElement>;

const LIST = {
  // The rendering reads a list's levels unguarded, so they are `[]` where Google sent none.
  listProperties: {
    kind: "part",
    fields: {
      nestingLevels: {
        kind: "parts",
        fields: {
          glyphType: value, glyphSymbol: value, startNumber: value,
        } satisfies FieldsOf<NestingLevel>,
        absent: "empty",
      },
    },
    absent: "empty",
  },
} satisfies FieldsOf<DocList>;

const NAMED_STYLES = {
  styles: parts({
    namedStyleType: value,
    textStyle: whole({ bold: value, italic: value, strikethrough: value }),
  }),
} satisfies FieldsOf<NamedStyles>;

/** A tab as `GoogleDocsApi.getDocument` hands it over. */
const TAB = {
  tabId: given,
  title: given,
  parentTabId: given,
  index: given,
  nestingLevel: given,
  body: {
    kind: "part",
    fields: { content: { kind: "parts", fields: BODY_ELEMENT, absent: "throw" } },
    absent: "throw",
  },
  lists: { kind: "map", fields: LIST },
  namedRanges: { kind: "read" },
  namedStyles: part(NAMED_STYLES),
} satisfies FieldsOf<GoogleDocsTab>;

/** A part of a tab as JSON holds it. */
type Part = Record<string, unknown>;

/** Refuses a tab in which a part lacks `field`, naming the field and nothing of the document. */
function missing(field: string): never {
  throw new TypeError(`Google Docs returned a part without its ${field}`);
}

/**
 * `source` pruned to `fields`: an object of its own, holding nothing of `source` but primitives.
 * A primitive is there when it is not `undefined`; a part or a list of parts is there when it is
 * neither `undefined` nor `null`. JSON from Google holds no `null`.
 */
function prunedPart(source: Part, fields: Fields): Part {
  let out: Part = {};
  for (let field in fields) {
    let keep = fields[field];
    let held = source[field];
    switch (keep.kind) {
      case "value":
      case "given":
        if (held !== undefined) out[field] = held;
        break;
      case "values":
        if (held !== undefined) out[field] = [...held as unknown[]];
        break;
      case "part":
        if (held == null) {
          if (keep.absent === "throw") missing(field);
          if (keep.absent !== "empty") break;
          held = {};
        }
        out[field] = prunedPart(held as Part, keep.fields);
        break;
      case "parts": {
        if (held == null) {
          if (keep.absent === "throw") missing(field);
          if (keep.absent !== "empty") break;
          held = [];
        }
        let inner = typeof keep.fields === "function" ? keep.fields() : keep.fields;
        out[field] = (held as Part[]).map(item => prunedPart(item, inner));
        break;
      }
      case "map":
        // A map Google leaves out or sends empty, as a cell's or a date's suggested changes, is
        // left out of the copy; the lists of a tab are always sent.
        if (keep.absent === "skip" && (held == null || Object.keys(held).length === 0)) break;
        // `Object.fromEntries` defines each id as a key of its own, whatever the id is.
        out[field] = Object.fromEntries(
          Object.entries(held as Record<string, Part>)
            .map(([id, item]) => [id, prunedPart(item, keep.fields)]),
        );
        break;
      case "read":
        out[field] = {};
        break;
    }
  }
  return out;
}

/**
 * `tab` with only what `docTabToMarkdown` and `applyDocsRequests` read, in Google's own shape and
 * with Google's own indexes (a start index is kept only where Google sent one), sharing nothing
 * with `tab`. Both functions give on the pruned tab what they give on `tab`: the same rendering,
 * and, for any batch, a tab that prunes to the same. Named ranges are left out (`namedRanges` is
 * `{}`): `fetchedDoc` keeps what the gatekeeper reads of them. Pruning a pruned tab changes nothing.
 */
export function pruneTab(tab: GoogleDocsTab): GoogleDocsTab {
  return prunedPart(tab, TAB) as GoogleDocsTab;
}

// ---------------------------------------------------------------------------
// The fields asked of Google
// ---------------------------------------------------------------------------

/**
 * How many tables deep, a table in a cell of a table, `documents.get` is asked for a cell's
 * content field by field. Below that the content is asked for whole, and never left out, so a
 * table nested deeper comes complete and is pruned as any other.
 */
const MASKED_TABLE_LEVELS = 1;

/**
 * The fields of `fields` as a `documents.get` field mask spells them: names separated by commas,
 * the fields of a part in parentheses after its name, a part asked for whole by its name alone.
 * `tables` is how many more tables deep a cell's content is spelled out.
 */
function fieldsMask(fields: Fields, tables: number): string {
  let asked: string[] = [];
  for (let field in fields) {
    let keep = fields[field];
    switch (keep.kind) {
      case "given":
        break;
      case "value":
      case "values":
      case "map":
      case "read":
        asked.push(field);
        break;
      case "part":
        if (keep.whole || Object.keys(keep.fields).length === 0) asked.push(field);
        else asked.push(`${field}(${fieldsMask(keep.fields, tables)})`);
        break;
      case "parts": {
        let inner = typeof keep.fields === "function" ? keep.fields() : keep.fields;
        if (!keep.nested) asked.push(`${field}(${fieldsMask(inner, tables)})`);
        else if (tables > 0) asked.push(`${field}(${fieldsMask(inner, tables - 1)})`);
        else asked.push(field);
        break;
      }
    }
  }
  return asked.join(",");
}

/**
 * What `documents.get` is asked for of a tab's content (Google's `documentTab`), as a field mask:
 * every field `pruneTab` keeps, and the named ranges whole, which `googleDocNamedRanges` reads.
 * Read off the same table as `pruneTab`, so the two cannot differ.
 */
export const DOC_TAB_FIELDS: string = fieldsMask(TAB, MASKED_TABLE_LEVELS);

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

/** What names and places a tab: a tab as Google returned it and a tab of a replay both have it. */
export type GoogleDocTabIdentity =
  Pick<GoogleDocsTab, "tabId" | "title" | "parentTabId" | "index" | "nestingLevel">;

/** `source` with only the fields `keys` name, those it has. */
function kept<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  let out = {} as Pick<T, K>;
  for (let key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** The identity of `tab`, with nothing else of it. */
export function tabIdentity(tab: GoogleDocTabIdentity): GoogleDocTabIdentity {
  return {
    tabId: tab.tabId,
    title: tab.title,
    ...kept(tab, ["parentTabId"]),
    index: tab.index,
    nestingLevel: tab.nestingLevel,
  };
}

// ---------------------------------------------------------------------------
// A fetched document, read once
// ---------------------------------------------------------------------------

/**
 * One tab of a fetched document as the store is handed it (`DocStore.keep`): what is known of
 * the tab before its body is read, and the body as runs.
 */
export type FetchedDocTab = {
  /** What names and places the tab. */
  readonly identity: GoogleDocTabIdentity;
  /** The write markers the tab held when it was fetched, in the order Google listed them. */
  readonly writeMarkers: readonly DocWriteMarkerCopy[];
  /**
   * The tab's lists and named styles, pruned: what a run's rendering reads beside it, and
   * what is stored as the tab's context. `namedStyles` is absent where Google sent none. A
   * reader takes it once a pass: a held document's tab makes it anew at each read.
   */
  readonly context: Pick<GoogleDocsTab, "lists" | "namedStyles">;
  /**
   * The tab's first index, as the cut counts it: the start index of the body's first element
   * where that is an integer, and 0 otherwise.
   */
  readonly first: number;
  /**
   * The body's runs in order, as `cutRuns` cuts the pruned elements. For a tab of
   * `fetchedDoc`: READ ONCE, and each element has left the parsed answer before the cut is
   * handed it. For a tab of a held document (`heldDoc`): each read decodes the runs anew.
   */
  readonly runs: Iterable<CutRun>;
  /**
   * Whether the model cannot follow the tab (`hasModelIndexes` or `hasModelFootnotes` fails
   * for the pruned tab). Says so of the whole tab ONLY ONCE `runs` HAS BEEN READ TO ITS END;
   * before that it speaks of the elements read so far.
   */
  unindexed(): boolean;
};

/** A document as fetched, for `DocStore.keep`, `DocStore.trial` and `heldDoc`. */
export type FetchedDoc = {
  /** Google's revision of the document, where it reported one. */
  readonly revision?: string;
  /** The clock when the fetch that brought the document began. */
  readonly fetchedAt: number;
  /**
   * The tabs in the document's order (depth-first, parents before children). For a document
   * of `fetchedDoc`: READ ONCE, each tab's `runs` to its end before the next tab is asked for.
   */
  readonly tabs: Iterable<FetchedDocTab>;
};

/**
 * The elements of `content`, a tab's body as the parsed answer holds it, pruned and in order.
 * Each is pruned straight out of its slot and the slot emptied before the element is handed
 * over: no variable names an element as Google sent it while a run is being stored, so what
 * the answer held of it can be collected. `following` is handed each pruned element.
 */
function* releasedBody(
  content: (StructuralElement | undefined)[], following: ModelFollowing,
): Generator<StructuralElement> {
  for (let at = 0; at < content.length; at++) {
    let element = prunedPart(content[at] as Part, BODY_ELEMENT) as StructuralElement;
    // The parsed answer lets go of the element. The slot stays: the walk is by index.
    content[at] = undefined;
    following.take(element);
    yield element;
  }
}

/**
 * Takes the tab at `at` out of `tabs` and opens it: reads what is known of it before its
 * body, and answers it with its body still to be read. What is read first is small, is read
 * beside every run (the lists and the named styles a rendering needs) or of no run (the
 * identity, the write markers), and is made of objects of its own; so once this has returned
 * nothing names the tab as Google sent it, its lists, its named ranges or its named styles,
 * and what is left of the answer for this tab is the body's elements.
 */
function openedTab(
  tabs: (GoogleDocsTab | undefined)[], at: number, sizes: RunSizes,
): FetchedDocTab {
  let tab = tabs[at] as GoogleDocsTab;
  // The parsed answer lets go of the tab. The slot stays: the walk is by index.
  tabs[at] = undefined;
  let identity = tabIdentity(tab);
  if (tab.body == null) missing("body");
  let { content } = tab.body;
  if (content == null) missing("content");
  let context = prunedPart(tab, { lists: TAB.lists, namedStyles: TAB.namedStyles }) as
    Pick<GoogleDocsTab, "lists" | "namedStyles">;
  let writeMarkers = googleDocWriteMarkers(tab);
  let start = content[0]?.startIndex;
  let following = modelFollowing(context.lists);
  return {
    identity,
    writeMarkers,
    context,
    first: Number.isInteger(start) ? start : 0,
    runs: cutRuns(releasedBody(content, following), sizes),
    unindexed: () => !following.followed(),
  };
}

/**
 * The tabs of a fetched document, each taken out of `tabs` and opened when it is asked for.
 * The tab is opened in a call of its own (`openedTab`): a variable naming it here would keep
 * it, with everything it holds beside its body, for as long as its runs are being stored.
 */
function* openedTabs(
  tabs: (GoogleDocsTab | undefined)[], sizes: RunSizes,
): Generator<FetchedDocTab> {
  for (let at = 0; at < tabs.length; at++) yield openedTab(tabs, at, sizes);
}

/**
 * `document`, as `GoogleDocsApi.getDocument` answered it, as the store is handed it: THE ONE
 * WALK OF A FETCHED DOCUMENT. Lazy: nothing is read until `tabs` is. IT TAKES `document`
 * OVER AND EMPTIES IT AS IT IS READ, so that what the parsed answer held of a part can be
 * collected once the part is stored: a tab is taken out of `document.tabs` when it is reached,
 * and a body element out of the tab's `body.content` when it is pruned, before the cut is
 * handed it. A caller reads nothing of `document` afterwards, and hands a document it means to
 * read again a copy.
 *
 * Of a tab, FIRST: its identity, its write markers (read off its named ranges), its lists and
 * named styles pruned, and its first index. They are small and hold nothing of the answer but
 * primitives; the tab is opened in a call that has returned before its first run is read, so
 * nothing keeps the tab or those collections past it. Then its body, element by element:
 * pruned to what the copy keeps (the table `pruneTab` reads), asked whether the model follows
 * it (`modelFollowing`), and cut (`cutRuns`). The pruned elements, the write markers and the
 * context are, field for field, those of `pruneTab(tab)` and of the tab's named ranges.
 *
 * @param fetchedAt The clock when the fetch began.
 * @param sizes The sizes the runs are cut to. Defaults to `RUN_SIZES`.
 * @throws As `tabs` is read, and never before: a `TypeError` naming the field for a tab with
 * no body or no content and for an element the pruning refuses (`pruneTab`'s refusals, with its
 * messages); an `Error` for named ranges that are malformed (`googleDocNamedRanges`).
 */
export function fetchedDoc(
  document: GoogleDocsDocument, fetchedAt: number, sizes: RunSizes = RUN_SIZES,
): FetchedDoc {
  return {
    ...(document.revisionId === undefined ? {} : { revision: document.revisionId }),
    fetchedAt,
    tabs: openedTabs(document.tabs, sizes),
  };
}

/** What a read answers where a tab of the stored copy cannot be served. */
export const DOC_COPY_UNREADABLE =
  "The stored copy of this Google Doc could not be read back. Read it again.";

/** Whether `error` says a stored copy could not be read back (`DOC_COPY_UNREADABLE`). */
export function isDocCopyUnreadable(error: unknown): boolean {
  return error instanceof Error && error.message === DOC_COPY_UNREADABLE;
}
