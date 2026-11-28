// Where a tab with its pending edits applied differs from the tab as saved, as elements: what a
// preview lays over its drawing of the saved tab. Found from the two versions' lists of runs,
// and decoded from the runs that differ alone.

import type { GoogleDocsTab, StructuralElement } from "./docs-api";
import type { DocStore, DocVersion, StoredRun } from "./docs-store";
import { namedListIds } from "./markdown-converter";

/** Elements of a pending tab, and the range of the saved tab they stand in place of. */
export type ChangedElements = {
  /** The saved tab's indexes replaced, `[start, end)`: empty where the elements are only added. */
  readonly start: number;
  readonly end: number;
  /** The pending tab's top-level elements there, indexed as in it: none where the range is only removed. */
  readonly elements: readonly StructuralElement[];
};

/** Some consecutive runs of a version, and where the first starts, counted from the tab's first index. */
type Span = { readonly at: number; readonly runs: readonly StoredRun[] };

/** Past this many comparisons of two stretches' elements, what differs between them is one change. */
const MOST_COMPARISONS = 1_000_000;

/** One version's runs as a walk of two versions reads them: those read that no run of the other matched yet. */
class Side {
  readonly held: StoredRun[] = [];
  /** Where the first run held starts, counted from the tab's first index. */
  at = 0;
  /** Where the first run held of each content stands among those held. */
  readonly #places = new Map<string, number>();
  readonly #next: () => StoredRun | undefined;

  constructor(next: () => StoredRun | undefined) {
    this.#next = next;
  }

  /** Reads the next run, if the list holds one more. */
  read(): boolean {
    let run = this.#next();
    if (!run) return false;
    this.#note(run.content, this.held.length);
    this.held.push(run);
    return true;
  }

  #note(content: string, place: number): void {
    if (!this.#places.has(content)) this.#places.set(content, place);
  }

  /** Where the first run held that holds `content` stands among those held. */
  place(content: string): number | undefined {
    return this.#places.get(content);
  }

  /** Lets go of the first `count` runs held: the span they stand in. */
  take(count = this.held.length): Span {
    let span = { at: this.at, runs: this.held.splice(0, count) };
    this.at += span.runs.reduce((sum, run) => sum + run.size, 0);
    this.#places.clear();
    this.held.forEach(({ content }, place) => this.#note(content, place));
    return span;
  }
}

/** How many runs each side holds before the next run both hold: none once both lists have ended. */
function common(a: Side, b: Side): [number, number] | undefined {
  for (;;) {
    // The side that holds fewer reads first, so neither runs ahead of the other.
    let [first, second] = a.held.length <= b.held.length ? [a, b] : [b, a];
    let side = first.read() ? first : second.read() ? second : undefined;
    if (!side) return undefined;
    let other = side === a ? b : a;
    let own = side.held.length - 1, at = other.place(side.held[own].content);
    if (at !== undefined) return side === a ? [own, at] : [at, own];
  }
}

/**
 * The stretches of runs in which two versions of a tab differ: each as the runs of `a` and those
 * of `b` that stand between two runs both hold. A run both hold is one content, which holds the
 * same elements wherever it stands and however a list numbers it, with nothing decoded.
 */
function* differing(a: Side, b: Side): Generator<readonly [Span, Span]> {
  for (;;) {
    let cut = common(a, b);
    let spans = [a.take(cut?.[0]), b.take(cut?.[1])] as const;
    if (spans[0].runs.length || spans[1].runs.length) yield spans;
    if (!cut) return;
    a.take(1);
    b.take(1);
  }
}

/** The elements of `span`, runs of a tab whose first index is `first`, indexed as in that tab. */
function elementsOf({ at, runs }: Span, first: number): StructuralElement[] {
  return runs.flatMap(run => {
    let elements = run.elements(first + at);
    at += run.size;
    return elements;
  });
}

/** An element as it reads wherever it stands: without its indexes. */
const read = (element: StructuralElement): string =>
  JSON.stringify(element, (key, value) => key === "startIndex" || key === "endIndex" ? undefined : value);

/**
 * Where two lists differ, each difference as `[from, to]` of `a` and `[from, to]` of `b`: what
 * stands between the items of a longest common subsequence.
 */
function differences(a: readonly string[], b: readonly string[]): [number, number, number, number][] {
  let head = 0, aEnd = a.length, bEnd = b.length;
  while (head < aEnd && head < bEnd && a[head] === b[head]) head++;
  while (aEnd > head && bEnd > head && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  let rows = aEnd - head, columns = bEnd - head, width = columns + 1;
  if (!rows && !columns) return [];
  if (!rows || !columns || rows * columns > MOST_COMPARISONS) return [[head, aEnd, head, bEnd]];

  // longest[i * width + j]: the longest common subsequence of `a` from `head + i` and `b` from `head + j`.
  let longest = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      longest[i * width + j] = a[head + i] === b[head + j]
        ? longest[(i + 1) * width + j + 1] + 1
        : Math.max(longest[(i + 1) * width + j], longest[i * width + j + 1]);
    }
  }
  let found: [number, number, number, number][] = [];
  let i = 0, j = 0, from = 0, bFrom = 0;
  let close = () => {
    if (i > from || j > bFrom) found.push([head + from, head + i, head + bFrom, head + j]);
  };
  while (i < rows && j < columns) {
    if (a[head + i] === b[head + j]) {
      close();
      from = ++i;
      bFrom = ++j;
    } else if (longest[(i + 1) * width + j] >= longest[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  i = rows;
  j = columns;
  close();
  return found;
}

/**
 * What `pending`, a tab with its pending edits applied, holds in place of what `saved`, the tab
 * as fetched, holds: each change as the saved tab's range and the pending tab's elements there,
 * in order. A tab with no saved version (one a pending add makes) is one change, of all it holds.
 * Edits far apart are changes apart: a run both versions hold is passed by its name, and only
 * the runs of a stretch that differs are decoded, both versions', to be compared element by
 * element without their indexes. So an element whose rendering alone moved (an item of a list
 * renumbered) is no change, and a footnote's number counts from its run's first. For ONE
 * SYNCHRONOUS STRETCH, as the versions are.
 */
export function changedElements(
  store: DocStore, saved: DocVersion | undefined, pending: DocVersion,
): ChangedElements[] {
  if (saved?.id === pending.id) return [];
  let was = new Side(saved ? store.reader(saved, 0) : () => undefined);
  let is = new Side(store.reader(pending, 0));
  let stretches = [...differing(was, is)];
  // Every run is passed by now, so a tab starts where its body ends less its runs' sizes.
  let savedFirst = (saved?.bodyEndIndex ?? 0) - was.at, pendingFirst = pending.bodyEndIndex - is.at;

  return stretches.flatMap(([savedSpan, pendingSpan]) => {
    let before = elementsOf(savedSpan, savedFirst), after = elementsOf(pendingSpan, pendingFirst);
    let origin = savedFirst + savedSpan.at;
    return differences(before.map(read), after.map(read)).map(([from, to, afterFrom, afterTo]) => {
      let start = from < before.length
        ? before[from].startIndex ?? origin : before.at(-1)?.endIndex ?? origin;
      return {
        start, end: to > from ? before[to - 1].endIndex : start,
        elements: after.slice(afterFrom, afterTo),
      };
    });
  });
}

/**
 * The lists `changes` name that the pending edits make or change: the definition `pending` holds
 * of each, less those `saved` holds alike. Reads the definitions those elements name alone, of
 * each version, and nothing where they name no list.
 */
export function changedLists(
  store: DocStore, saved: DocVersion | undefined, pending: DocVersion,
  changes: readonly ChangedElements[],
): GoogleDocsTab["lists"] {
  let ids = namedListIds(changes.flatMap(({ elements }) => elements));
  let was = new Map(Object.entries(saved ? store.lists(saved, ids) : {}));
  return Object.fromEntries(Object.entries(store.lists(pending, ids)).filter(([id, list]) =>
    JSON.stringify(list) !== JSON.stringify(was.get(id))));
}
