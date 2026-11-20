// A whole rendering of a tab that fails on a read past a piece of it: what holds the request
// builders to reading, of a tab's content, the elements of the piece alone. It reads as the
// whole rendering does, so a builder handed it builds what it builds from the whole tab, and
// a read of content outside the piece's elements throws where the builder makes it. A helper
// and no test of its own.

import { ELEMENT_BLOCK, ELEMENT_PROTECTS, ELEMENT_TABLE } from "../src/markdown-converter";
import type { DocTabSnapshot } from "../src/markdown-converter";

/**
 * Thrown by a rendering `recorded` made for a read of content outside its range. The message
 * names the operation and the offsets or the entry read, and never any text of a document.
 */
export class ReadPastPiece extends Error {
  constructor(what: string) {
    super(`A read past the piece: ${what}`);
    this.name = "ReadPastPiece";
  }
}

/** A tab's whole rendering with what the pass that made it says of its elements. */
export type RecordedWhole = {
  /** The tab rendered whole (`docTabToMarkdown`). */
  readonly rendering: DocTabSnapshot;
  /** Where each body element's Markdown starts (`RunElements.starts`). */
  readonly starts: readonly number[];
  /** What each body element writes and owns (`RunElements.flags`). */
  readonly flags: readonly number[];
};

/** The properties of an entry of the source map that say where it stands, and nothing of it. */
const POSITIONS: ReadonlySet<PropertyKey> = new Set(["mdStart", "mdEnd", "docStart", "docEnd"]);

/**
 * The entries of `entries`, each handed out as itself where `inside` says its place is one of
 * the range's, and otherwise as a stand-in that throws on a read of anything but its position.
 * One stand-in an entry, so that an entry found twice is one object and `indexOf` finds it.
 * A write to the entries or to a stand-in throws a `TypeError`, as an unserved read of the
 * Markdown does, so that no caller takes it for a builder's refusal.
 */
function guardedEntries<T extends object>(
  kind: string, entries: T[], inside: (place: number) => boolean,
): T[] {
  let guards = new WeakMap<T, T>();
  let guarded = (entry: T, place: number): T => {
    if (inside(place)) return entry;
    let guard = guards.get(entry);
    if (!guard) {
      guard = new Proxy(entry, {
        get(target, property, receiver) {
          if (typeof property === "string" && !POSITIONS.has(property)) {
            throw new ReadPastPiece(`${kind}[${place}].${property}`);
          }
          return Reflect.get(target, property, receiver);
        },
        has(_target, property) {
          throw new ReadPastPiece(`${String(property)} in ${kind}[${place}]`);
        },
        ownKeys() {
          throw new ReadPastPiece(`the keys of ${kind}[${place}]`);
        },
        set() {
          throw new TypeError(`A builder wrote to ${kind}[${place}]`);
        },
      });
      guards.set(entry, guard);
    }
    return guard;
  };
  return new Proxy(entries, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(?:0|[1-9]\d*)$/.test(property)) {
        let place = Number(property);
        return place < target.length ? guarded(target[place], place) : undefined;
      }
      // The length and the methods, which read the entries through this stand-in.
      return Reflect.get(target, property, receiver);
    },
    set() {
      throw new TypeError(`A builder wrote to ${kind}`);
    },
  });
}

/**
 * `markdown`, as a stand-in that answers its length and serves the methods the builders call
 * on a tab's Markdown, each answering a primitive, and throws `ReadPastPiece` where one reads
 * a character outside `[from, to)`. An end that is `-Infinity` or `Infinity` is the tab's own:
 * a read past that end of the string is one the whole tab's string answers the same.
 */
function guardedMarkdown(markdown: string, from: number, to: number): string {
  let { length } = markdown;
  /** Throws where `[start, end)`, read by `operation`, holds a character outside the range. */
  let reads = (operation: string, start: number, end: number): void => {
    if (start < end && (start < from || end > to)) {
      throw new ReadPastPiece(`${operation} of [${start}, ${end}) outside [${from}, ${to})`);
    }
  };
  /** An offset an argument names, as `slice` counts it. */
  let offset = (value: number | undefined, absent: number) => {
    if (value === undefined) return absent;
    let whole = Math.trunc(value) || 0;
    return whole < 0 ? Math.max(0, length + whole) : Math.min(whole, length);
  };
  let methods: Record<string, (...given: never[]) => unknown> = {
    slice(start?: number, end?: number) {
      reads("slice", offset(start, 0), offset(end, length));
      return markdown.slice(start, end);
    },
    charCodeAt(index: number) {
      reads("charCodeAt", index, index + 1);
      return markdown.charCodeAt(index);
    },
    at(index: number) {
      let place = index < 0 ? length + index : index;
      reads("at", place, place + 1);
      return markdown.at(index);
    },
    // A search reads from where it starts to the end of what it finds, and to the string's
    // end where it finds nothing.
    indexOf(search: string, start?: number) {
      let found = markdown.indexOf(search, start);
      reads("indexOf", offset(start, 0), found < 0 ? length : found + search.length);
      return found;
    },
    lastIndexOf(search: string, start?: number) {
      let found = markdown.lastIndexOf(search, start);
      reads("lastIndexOf", found < 0 ? 0 : found,
        Math.min(length, offset(start, length) + search.length));
      return found;
    },
    startsWith(search: string, start?: number) {
      let place = offset(start, 0);
      reads("startsWith", place, Math.min(length, place + search.length));
      return markdown.startsWith(search, start);
    },
    includes(search: string, start?: number) {
      let found = markdown.indexOf(search, start);
      reads("includes", offset(start, 0), found < 0 ? length : found + search.length);
      return found >= 0;
    },
  };
  return new Proxy(new String(markdown), {
    get(_target, property) {
      if (property === "length") return length;
      if (typeof property === "string") {
        if (Object.hasOwn(methods, property)) return methods[property];
        if (/^-?\d+$/.test(property)) {
          let index = Number(property);
          reads("[index]", index, index + 1);
          return markdown[index];
        }
      }
      // Anything else reads the string in a way nothing here follows: a method no builder
      // called on a tab's Markdown before, or the string taken whole (a concatenation, a
      // regular expression). It is served once it is listed above, with what it reads. A
      // `TypeError`, so that no caller takes it for a builder's refusal.
      throw new TypeError(`The Markdown of a recorded rendering is asked ${String(property)}`);
    },
    has(_target, property) {
      throw new TypeError(`The Markdown of a recorded rendering is asked ${String(property)} in`);
    },
    set() {
      throw new TypeError("A builder wrote to the Markdown");
    },
  }) as unknown as string;
}

/**
 * `whole.rendering`, reading as it does, but throwing `ReadPastPiece` on a read of CONTENT
 * outside the body elements `[range.from, range.to)`: of the Markdown, any character before
 * the range's first element's start or from the range's end on; of the source map, any
 * property but its position (`mdStart`, `mdEnd`, `docStart`, `docEnd`) of an entry an element
 * outside the range owns. A range that reaches the tab's first or last element allows every
 * read to that end, past the string's own end included. Everything else of the rendering
 * (its identity, `bodyEndIndex`, a length, an entry's position) is the tab's and is read
 * freely. The Markdown is no primitive: it has no method but those the builders call
 * (`guardedMarkdown`), and `===` on it is identity. A write to the Markdown, to the source
 * map's arrays or to an entry outside the range throws a `TypeError`.
 * @param lineBreakBefore Allows a read of the line break that stands just before the range,
 * where one does: what a search back for the start of the range's first line reads. A piece's
 * own string starts there and answers that it holds none, which says the same; a card's walk
 * back to the text before its table makes that search, and no request builder does.
 */
export function recorded(
  whole: RecordedWhole, range: { readonly from: number; readonly to: number },
  lineBreakBefore = false,
): DocTabSnapshot {
  let { rendering, starts, flags } = whole;
  let { markdown, sourceMap } = rendering;
  let front = starts[range.from] - (lineBreakBefore && markdown[starts[range.from] - 1] === "\n" ? 1 : 0);
  /** How many entries the elements before `element` own, where `flag` marks an owner. */
  let ownedBefore = (flag: number, element: number) => {
    let owned = 0;
    for (let at = 0; at < element; at++) if (flags[at] & flag) owned++;
    return owned;
  };
  /** Whether an entry's place is one the range's elements own. */
  let inside = (flag: number) => {
    let first = ownedBefore(flag, range.from);
    let end = ownedBefore(flag, range.to);
    return (place: number) => place >= first && place < end;
  };
  return {
    ...rendering,
    markdown: guardedMarkdown(
      markdown,
      range.from === 0 ? -Infinity : front,
      range.to >= flags.length ? Infinity : starts[range.to]),
    sourceMap: {
      blocks: guardedEntries("blocks", sourceMap.blocks, inside(ELEMENT_BLOCK)),
      protectedRanges: guardedEntries(
        "protectedRanges", sourceMap.protectedRanges, inside(ELEMENT_PROTECTS)),
      tables: guardedEntries("tables", sourceMap.tables, inside(ELEMENT_TABLE)),
    },
  };
}
