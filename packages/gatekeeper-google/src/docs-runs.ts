// The one place a Google Doc's tab becomes stored runs and a stored run becomes elements
// again: where a tab's body is cut, by content, and the form a run is stored in, in which
// every position and every footnote number is counted from the run's own start.

import type { ParagraphElement, StructuralElement, TableCell, TableRow } from "./docs-api";
import { wholeFootnoteNumber } from "./docs-content";

/** The sizes runs are cut to, in characters of a run's stored JSON. */
export type RunSizes = {
  /** No run ends by its content before it holds this much. */
  readonly least: number;
  /** What a run holds on average. */
  readonly target: number;
  /** No run of several elements holds more: an element that would pass it starts a run. */
  readonly most: number;
  /** The most elements a run holds. For tests, which force short runs. */
  readonly elements: number;
};

/**
 * The sizes a tab is cut to: about 32 KiB a run of paragraphs, and 64 KiB at most for a run
 * of several elements. A table is a run of its own whatever its size, and so is a paragraph
 * larger than that: such a run is as large as its one element.
 */
export const RUN_SIZES: RunSizes = {
  least: 8_192, target: 32_768, most: 65_536, elements: Infinity,
};

/**
 * Whether a run ends after the element stored as `json`, by the element's content alone:
 * true for an element in `(target - least) / json.length` or so, read off a hash of the
 * string's code units in which THE DIGITS AND MINUS SIGNS OF JSON NUMBERS ARE LEFT OUT AND
 * EVERY JSON STRING IS WHOLE. What counts from the run's start is a JSON number in the stored
 * form (every index, and a footnote's number), so where a run starts does not move the cut
 * after it; a size or a colour is a number too and spreads no cut; text, a style's name and
 * an id are strings, so two elements that differ only in the digits of their text cut apart.
 * A stretch of elements that are the same in everything but their place is cut by size
 * alone, and its runs are then the same run. A STRETCH DRAWN FROM A FEW DISTINCT ELEMENTS IS
 * NOT SPREAD EITHER: each of them ends a run wherever it stands or nowhere (a paragraph of 250
 * characters does one time in a hundred, so a few dozen distinct ones mostly hold none). Where
 * none does, the stretch is cut by size alone, its runs differ, and an element put in or taken
 * out moves the cuts after it (`cutRuns`); where one does, a run ends at each place it recurs
 * past `sizes.least`, so the runs are shorter than `target`.
 * The hash is cheap (one pass, no allocation) and
 * is no security boundary: it only spreads the cuts. Its definition decides where every run
 * is cut and so every run's id; it is derived code (`DOC_DERIVED`), and a stored tab reads
 * the same whatever cut it. What a change of it costs is sharing: a tab cut after the change
 * shares next to no run with a version cut before it, so each tab is stored whole once more.
 */
export function endsRun(json: string, sizes: RunSizes): boolean {
  let hash = 0x811c9dc5;
  let hashed = 0;
  let quoted = false;
  for (let at = 0; at < json.length; at++) {
    let unit = json.charCodeAt(at);
    if (quoted) {
      if (unit === 0x5c) {
        // An escape: the unit after it is text, whatever it is.
        hash = Math.imul(hash ^ unit, 0x01000193);
        hashed++;
        unit = json.charCodeAt(++at);
      } else if (unit === 0x22) {
        quoted = false;
      }
    } else if (unit === 0x22) {
      quoted = true;
    } else if ((unit >= 0x30 && unit <= 0x39) || unit === 0x2d) {
      // A digit or the sign of a JSON number.
      continue;
    }
    hash = Math.imul(hash ^ unit, 0x01000193);
    hashed++;
  }
  // The last characters of every element are the same brackets: mix the whole hash down.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) % Math.max(1, sizes.target - sizes.least) < hashed;
}

/** One run of a tab as it is stored. */
export type CutRun = {
  /** The run's stored JSON: an array of its elements in their stored form. */
  readonly json: string;
  /**
   * Its elements, in order: the objects the cut was given, as it was given them (not their
   * stored form), for a caller that renders the run it has just stored.
   */
  readonly elements: readonly StructuralElement[];
  /**
   * Its length in document indexes: where its last element ends less the run's first index.
   * Always an integer: an element whose `endIndex` is not one ends where the element before
   * it does (the run's first index for the run's first element).
   */
  readonly size: number;
  /** How many footnote references it holds, those of table cells included. */
  readonly footnotes: number;
  /** What its first element is, for an error that names it; `"element"` for an empty body. */
  readonly holds: "paragraph" | "table" | "element";
};

/** A part of a tab that holds indexes: an element, a row, a cell or a paragraph's element. */
type Indexed = StructuralElement | TableRow | TableCell | ParagraphElement;

/** A part in its stored form: the part's own keys in their order, to be written as JSON. */
type Stored = Record<string, unknown>;

/** What the stored form of an element counts from, and the footnote references counted in it. */
type Origin = {
  /** The first index of the element's run. */
  readonly first: number;
  /** How many footnote references the runs before that run hold. */
  readonly footnoteBase: number;
  /** How many the parts of the element stored so far hold. */
  footnotes: number;
};

const INDEXES = ["startIndex", "endIndex"] as const;

/** A copy of `part` whose indexes that are integers are counted from `first`. */
function storedPart(part: Indexed, first: number): Stored {
  let stored: Stored = { ...part };
  for (let key of INDEXES) {
    let index = part[key];
    if (Number.isInteger(index)) stored[key] = index - first;
  }
  return stored;
}

/**
 * The stored form of one element, whose footnote references `origin` counts: a copy of each
 * part that holds an index or a footnote number (the element, its paragraph and paragraph
 * elements, a table's rows and cells, and their elements again) around the element's own
 * styles and text, so that a paragraph's list is stored under the key `listId` and under no
 * other, which the store reads a run's lists by inside storage.
 */
function storedElement(element: StructuralElement, origin: Origin): Stored {
  let stored = storedPart(element, origin.first);
  let { paragraph, table } = element;
  if (paragraph?.elements) {
    stored.paragraph = {
      ...paragraph,
      elements: paragraph.elements.map(part => {
        let storedInline = storedPart(part, origin.first);
        let reference = part.footnoteReference;
        if (!reference) return storedInline;
        origin.footnotes++;
        let number = wholeFootnoteNumber(reference.footnoteNumber);
        if (number !== undefined) {
          storedInline.footnoteReference =
            { ...reference, footnoteNumber: number - origin.footnoteBase };
        }
        return storedInline;
      }),
    };
  }
  if (table?.tableRows) {
    stored.table = {
      ...table,
      tableRows: table.tableRows.map(row => {
        let storedRow = storedPart(row, origin.first);
        if (row.tableCells) {
          storedRow.tableCells = row.tableCells.map(cell => {
            let storedCell = storedPart(cell, origin.first);
            if (cell.content) {
              storedCell.content = cell.content.map(inner => storedElement(inner, origin));
            }
            return storedCell;
          });
        }
        return storedRow;
      }),
    };
  }
  return stored;
}

/**
 * Cuts `content`, the elements of a tab's body in order, into runs, one at a time: the body is
 * read once, element by element, and need not be an array (a caller that stores a fetch as it
 * reads it hands the elements as they come), and a caller that stores each run as it comes
 * holds one run's JSON and elements at a time. A table is alone in its run. Any other run ends
 * after an element `endsRun` says ends it, once it holds `sizes.least`; before an element that
 * would take it past `sizes.most`; and at `sizes.elements`. So an element larger than
 * `sizes.most` is alone too. A cut `endsRun` made stands where its element stands, so a change
 * early in a tab moves the cuts near it and no other WHERE THE ELEMENTS AFTER IT END RUNS. A
 * cut made at `sizes.most` stands where the run's length put it: in a stretch longer than
 * `sizes.most` none of whose elements ends a run (a few elements repeated, see `endsRun`), an
 * element put in or taken out can move every later cut, and so give every later run another
 * id, until both cuts end a run after the same element, which they do at the next table at
 * the latest.
 *
 * THE STORED FORM, of which `decodeRun` is the inverse for every input:
 * - every `startIndex` and `endIndex` (of a body element, a paragraph element, a table row, a
 *   table cell and the elements of a cell) that is an integer is counted from the run's first
 *   index: where the element before the run ends, and for a tab's first run the start of its
 *   first element (0 where it holds none). One that is absent stays absent (Google leaves out
 *   the start of the section break that opens a body), and one that is anything else than an
 *   integer is stored as it is: the decoder adds to integers only, so both read back;
 * - WHERE AN ELEMENT ENDS, for the next run's first index and for `CutRun.size`, is its
 *   `endIndex` where that is an integer and otherwise where the element before it ends, so
 *   both are integers for any input (a tab with such an element takes no edit: the model
 *   cannot follow it, `hasModelIndexes`);
 * - a footnote reference's number that is a whole number (`wholeFootnoteNumber`) is stored AS
 *   A JSON NUMBER, the number less the count of references before the run in the tab; any
 *   other text is stored as the string it is. So everything that counts from the run's start
 *   is a JSON number, every JSON string is the document's own, and the type says which a
 *   decoder adds to;
 * - THE SECTION BREAK THAT OPENS A BODY IS STORED AS GOOGLE SENDS IT, WITH NO START INDEX: a
 *   start index of 0 on a section break that is the body's first element (the model writes
 *   one, a test fixture may) is not stored. So in a stored run a section break with no start
 *   index opens a body and is never written, one with a start index stands after the body's
 *   start and always is, and the first run of a tab the model made is the first run of the
 *   tab Google sent.
 * Key order is the elements' own. Nothing of `content` is changed. A body of no element is
 * one run of none (`[]`), so that an empty tab is stored and read back as one.
 * @param footnotes How many footnote references the tab holds before `content`: 0 for a
 * body, and the count before the stretch for a stretch of one. A stored footnote number counts
 * from the references before its run, so the runs cut from a stretch that stands after some
 * are the runs a cut of the whole body stores for the same elements.
 */
export function* cutRuns(
  content: Iterable<StructuralElement>, sizes: RunSizes, footnotes = 0,
): Generator<CutRun> {
  let opened = false;
  // The first index of the run in hand, and where the last element read ends.
  let first = 0;
  let end = 0;
  // The footnote references before the run in hand, and of the run in hand.
  let footnoteBase = footnotes;
  let held = 0;
  // The run's elements, their stored strings, and the length of its JSON so far: its opening
  // bracket, and each string with the comma or the bracket after it.
  let elements: StructuralElement[] = [];
  let strings: string[] = [];
  let length = 1;

  let store = (element: StructuralElement, opensBody: boolean) => {
    let origin: Origin = { first, footnoteBase, footnotes: 0 };
    let stored = storedElement(element, origin);
    if (opensBody && element.sectionBreak && element.startIndex === 0) delete stored.startIndex;
    return { json: JSON.stringify(stored), footnotes: origin.footnotes };
  };
  let take = (): CutRun => {
    let [opening] = elements;
    let run: CutRun = {
      json: `[${strings.join(",")}]`,
      elements,
      size: end - first,
      footnotes: held,
      holds: opening?.table ? "table" : opening?.paragraph ? "paragraph" : "element",
    };
    first = end;
    footnoteBase += held;
    held = 0;
    elements = [];
    strings = [];
    length = 1;
    return run;
  };

  for (let element of content) {
    let opensBody = !opened;
    if (opensBody) {
      opened = true;
      first = end = Number.isInteger(element.startIndex) ? element.startIndex : 0;
    }
    if (element.table && elements.length > 0) yield take();
    let stored = store(element, opensBody);
    if (elements.length > 0 && length + stored.json.length + 1 > sizes.most) {
      yield take();
      // Its indexes and footnote numbers count from the run it starts.
      stored = store(element, opensBody);
    }
    elements.push(element);
    strings.push(stored.json);
    length += stored.json.length + 1;
    held += stored.footnotes;
    if (Number.isInteger(element.endIndex)) end = element.endIndex;
    if (
      element.table || elements.length >= sizes.elements ||
      (length >= sizes.least && endsRun(stored.json, sizes))
    ) {
      yield take();
    }
  }
  if (!opened || elements.length > 0) yield take();
}

/** Adds `first` to each index of `part` that is an integer. */
function placePart(part: Indexed, first: number): void {
  for (let key of INDEXES) {
    if (Number.isInteger(part[key])) part[key] += first;
  }
}

/**
 * Gives the parts of `content`, stored elements, the indexes and footnote numbers they have
 * in their tab, in place, and answers how many footnote references they hold.
 */
function placeContent(
  content: readonly StructuralElement[], at: { readonly first: number; readonly footnotes: number },
): number {
  let footnotes = 0;
  for (let element of content) {
    placePart(element, at.first);
    for (let part of element.paragraph?.elements ?? []) {
      placePart(part, at.first);
      let reference = part.footnoteReference;
      if (!reference) continue;
      footnotes++;
      // A number is a count from the run's start; a string is the document's own text.
      let stored: unknown = reference.footnoteNumber;
      if (typeof stored === "number") reference.footnoteNumber = String(stored + at.footnotes);
    }
    for (let row of element.table?.tableRows ?? []) {
      placePart(row, at.first);
      for (let cell of row.tableCells ?? []) {
        placePart(cell, at.first);
        footnotes += placeContent(cell.content ?? [], at);
      }
    }
  }
  return footnotes;
}

/**
 * The elements of the run stored as `json`, with the indexes and footnote numbers they have
 * in their tab; `undefined` where `json` is not a stored run (not JSON, or not an array). No
 * element for `"[]"`, the run of an empty body. The inverse of the stored form: each index
 * that is an integer counted from `at.first`, each footnote number stored as a JSON number
 * counted from `at.footnotes` and made the string Google sends; and, for `at.exact`, a
 * section break that starts the run with no start index gets `at.first` as its own (the
 * model's tabs hold every index). So a tab decodes to itself, but for a start index of 0 on
 * its opening section break, which a tab the model did not make reads back without.
 * @param at Where the run stands: its first index (the tab's first index and the sizes of the
 * runs before it), how many footnote references the runs before it hold, and whether its
 * version is one the model made.
 */
export function decodeRun(
  json: string, at: { readonly first: number; readonly footnotes: number; readonly exact: boolean },
): { elements: StructuralElement[]; footnotes: number } | undefined {
  let elements: StructuralElement[];
  try {
    // The parser's message quotes its input, which is a document's content: it goes nowhere.
    let parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    elements = parsed;
  } catch {
    return undefined;
  }
  let footnotes = placeContent(elements, at);
  let first: Partial<StructuralElement> | undefined = elements[0];
  if (at.exact && first?.sectionBreak && first.startIndex === undefined) {
    first.startIndex = at.first;
  }
  return { elements, footnotes };
}
