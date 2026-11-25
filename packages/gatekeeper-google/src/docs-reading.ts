// A stored Google Doc tab read for an edit: what the builders ask of the tab as a whole,
// answered from stored rows a run at a time, and the piece of it they read. Nothing here
// remembers anything past the stretch a reading is made for.

import {
  DocPieceError, DocRunRenderError, markdownHeld, PIECE_NAMES_NOTHING, runId,
  type DocPiece, type DocStore, type DocVersion, type PieceAt,
} from "./docs-store";
import { lineAbove } from "./docs-tables";
import type { DocTabSnapshot, OwnRange, TabReading } from "./markdown-converter";

// ---------------------------------------------------------------------------
// The fault, and the one way out of it
// ---------------------------------------------------------------------------

/**
 * Thrown by a stored reading for what is NOT a refusal of an edit: what storage threw
 * (`cause`), and nothing else: a `DocRunRenderError` and a `DocPieceError` pass as they
 * are. The builders call a reading inside the `try` whose every other throw is
 * a refusal, so whoever holds a stored reading leaves through `unwrapped`, which throws
 * `cause` on. The renderer's own throw on a run stays a `DocRunRenderError`.
 */
export class DocReadingFault extends Error {
  constructor(cause: unknown) {
    super("A stored Google Doc tab could not be read.", { cause });
    this.name = "DocReadingFault";
  }
}

/**
 * What `run` answers; where it throws a `DocReadingFault`, its `cause` is thrown in its
 * place, so that a caller above reads what storage threw (`DOC_COPY_UNREADABLE`'s text for
 * a copy that does not read back) and never the wrapper. EVERY function that makes a stored
 * reading runs its body in this.
 */
export function unwrapped<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw error instanceof DocReadingFault ? error.cause : error;
  }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** A scan for one text in Markdown handed a run at a time (`markdownScan`, `prefixScan`). */
export type MarkdownScan = {
  /**
   * Takes the next run's Markdown. `false` once the answer cannot change (a second place
   * was found, or the scan gave up): the caller hands no more.
   */
  take(run: string): boolean;
  /**
   * Once every run was taken: the one place the text stands at, or `"none"` or `"many"`
   * (two places that overlap are two).
   */
  done(): number | "none" | "many";
};

/** How many places a `markdownScan` follows across the end of a run at once. */
export const MAX_SCAN_FOLLOWED = 64;

// How many characters of a text find the places it may start at in a run.
const SCAN_HEAD = 16;

// How many characters a `markdownScan` may compare, at most, for each one it reads and each of
// its text's, before it answers `"crowded"`.
const SCAN_WORK = 32;

/**
 * A scan for `text` that holds `text` and about three runs' Markdown: the run in hand, a
 * copy of it with the tail of the run before in front (the string that is searched), and at
 * most the run before it (a tail of fewer than 16 characters may keep that string alive). A
 * place that starts in an earlier run is followed, run by run, by comparing the next part
 * of `text` with the run's start; places that start in the run are found by its first 16
 * characters (`indexOf`) and compared to the run's end. With `lineBreakBefore` the Markdown
 * is searched as if a line break stood before it, and a place that starts there is -1.
 * At most `MAX_SCAN_FOLLOWED` places are followed across a run's end at once: a text that
 * overlaps itself more than that (hundreds of equal rows replaced) makes `done` answer
 * `"crowded"`, and the caller scans again with `prefixScan`. So does a scan whose comparisons
 * could pass `SCAN_WORK` characters for each one read and each of `text` (repetitive Markdown
 * where many places start as `text` does and few go on as it does), which keeps its work linear.
 * @param text Not empty.
 */
export function markdownScan(text: string, lineBreakBefore = false):
  Omit<MarkdownScan, "done"> & { done(): number | "none" | "many" | "crowded" } {
  let head = text.slice(0, SCAN_HEAD);
  // The characters of the runs taken, and the last of them, one fewer than `head` holds.
  let read = 0;
  let tail = "";
  // Where the places start that read as `text` up to the end of the last run taken.
  let followed: number[] = [];
  let found: number | undefined;
  let ended: "many" | "crowded" | undefined;
  // The characters the comparisons could have compared, each counted as long as it may run.
  let work = 0;
  // A place the text stands at whole: the second ends the scan.
  let placed = (start: number): void => {
    if (found === undefined) found = start;
    else ended = "many";
  };
  let take = (run: string): boolean => {
    if (ended) return false;
    markdownHeld(text.length + run.length);
    let still: number[] = [];
    for (let start of followed) {
      let matched = read - start;
      let length = Math.min(text.length - matched, run.length);
      if (!text.startsWith(length === run.length ? run : run.slice(0, length), matched)) continue;
      if (matched + length < text.length) {
        still.push(start);
        continue;
      }
      placed(start);
      if (ended) return false;
    }
    followed = still;
    // A place that starts in the tail was not found before: its first characters were not
    // whole in the window of the run before.
    let window = tail + run;
    for (let at = window.indexOf(head); at >= 0; at = window.indexOf(head, at + 1)) {
      let held = Math.min(text.length, window.length - at);
      work += held;
      if (work > SCAN_WORK * (read + window.length + text.length)) {
        ended = "crowded";
        return false;
      }
      if (!window.startsWith(held === text.length ? text : text.slice(0, held), at)) continue;
      let start = read - tail.length + at;
      if (held === text.length) {
        placed(start);
      } else if (followed.length < MAX_SCAN_FOLLOWED) {
        followed.push(start);
      } else {
        ended = "crowded";
      }
      if (ended) return false;
    }
    read += run.length;
    tail = head.length > 1 ? window.slice(1 - head.length) : "";
    return true;
  };
  if (lineBreakBefore) {
    read = -1;
    take("\n");
  }
  return { take, done: () => ended ?? found ?? "none" };
}

/**
 * The same answer for a text `markdownScan` cannot follow, by Knuth-Morris-Pratt: the length of
 * `text` the characters read last match is carried from run to run, so every character is
 * compared a bounded number of times however long `text` is and however small the runs are, and
 * places that overlap are each found. HOLDS `text`, its table of prefixes (an `Int32Array` of
 * one entry a character, counted as two characters an entry) and the run in hand: about three
 * times the text and one run, counted as that (`markdownHeld`).
 */
export function prefixScan(text: string, lineBreakBefore = false): MarkdownScan {
  // `prefix[i]`: the length of the longest proper prefix of `text`'s first `i + 1` characters
  // that ends them too.
  let prefix = new Int32Array(text.length);
  for (let i = 1, length = 0; i < text.length; i++) {
    while (length > 0 && text.charCodeAt(i) !== text.charCodeAt(length)) length = prefix[length - 1];
    if (text.charCodeAt(i) === text.charCodeAt(length)) length++;
    prefix[i] = length;
  }
  let read = 0;
  // How many characters of `text` the characters read last match.
  let matched = 0;
  let found: number | undefined;
  let many = false;
  let take = (run: string): boolean => {
    if (many) return false;
    markdownHeld(3 * text.length + run.length);
    for (let i = 0; i < run.length; i++) {
      let code = run.charCodeAt(i);
      while (matched > 0 && code !== text.charCodeAt(matched)) matched = prefix[matched - 1];
      if (code === text.charCodeAt(matched)) matched++;
      if (matched < text.length) continue;
      if (found !== undefined) {
        many = true;
        return false;
      }
      found = read + i + 1 - text.length;
      matched = prefix[matched - 1];
    }
    read += run.length;
    return true;
  };
  if (lineBreakBefore) {
    read = -1;
    take("\n");
  }
  return { take, done: () => many ? "many" : found ?? "none" };
}

// ---------------------------------------------------------------------------
// The stored reading
// ---------------------------------------------------------------------------

/** A stored reading: `TabReading` over `version` in `store`, and what an edit takes of it. */
export type StoredTabReading = TabReading & {
  /** The version read. */
  readonly version: DocVersion;
  /**
   * The decoded runs of the last piece made, for the model's first slice
   * (`DocStore.slice`), once; AND THE READING LETS GO OF THAT PIECE: its rendering (the
   * Markdown and the source map) is remembered no longer, so nothing of it is in hand while
   * the model runs and the version is stored. Whoever reads the piece after the builders
   * (a table change's card) takes what it shows BEFORE the edit is made, as strings and
   * numbers; a piece asked for after this is made again from storage. `undefined` where no
   * piece was made since. Whoever is done with a piece and has no use for its runs calls
   * this and drops the answer: `docEditResult` where it finds the result stored, and a
   * table change's preparation once a new table's number is read.
   */
  takeDecoded(): DocPiece["decoded"] | undefined;
};

// What `read` answers of storage, its throw marked as storage's (`DocReadingFault`) unless it
// is the renderer's on a run or a piece's that names nothing.
function stored<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof DocRunRenderError || error instanceof DocPieceError) throw error;
    throw new DocReadingFault(error);
  }
}

/** Whether two own ranges name the same elements of a tab. */
function sameOwn(left: OwnRange, right: OwnRange): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if ("table" in left) return "table" in right && left.table === right.table;
  return "markdown" in right && left.markdown.mdStart === right.markdown.mdStart &&
    left.markdown.mdEnd === right.markdown.mdEnd;
}

/**
 * What the builders ask of `version` as a whole, answered from `store`: a scan of stored
 * Markdown a run at a time (`find`), passes over the runs' stored summaries a page at a
 * time (`blank`, `tables`, `tablesShaped`, `numberedAfter`), stored Markdown read backwards
 * a run at a time (`lineBefore`), and the closure of the edit's own elements rendered from
 * the runs that hold it (`piece`). No run is decoded but for a piece. It remembers, for its
 * stretch, its last answer of each kind (a scan's text and place, the tables' totals, a
 * shape's tables, the last piece by its own range), so that a check that asks again reads
 * nothing again. NOTHING IT REMEMBERS GROWS WITH THE TAB'S RUNS: no list of tables,
 * of places or of summaries.
 *
 * WHAT A MEMBER HOLDS while it reads: a pass, one page of the version's list and its answer
 * (two numbers, a boolean, at most two table numbers); `find`, the text, the run in hand
 * and at most the run before it, and for a text that overlaps itself past
 * `MAX_SCAN_FOLLOWED` or crowds the scan, the text, its table of prefixes and the run
 * (`prefixScan`); `lineBefore`, one run's
 * Markdown at a time, a statement a run back to the line it answers (behind hundreds of
 * tables, hundreds of statements of two rows).
 * @throws From every member: `DocReadingFault` around what the store throws, but a
 * `DocRunRenderError` and a `DocPieceError`, which pass.
 */
export function storedTabReading(store: DocStore, version: DocVersion): StoredTabReading {
  // What a scan answers of the runs' stored Markdown; a walk that hands its runs again
  // from the first starts a scan afresh.
  let scanned = <Found>(scan: () => { take(run: string): boolean; done(): Found }): Found => {
    let taking = scan();
    store.walk(version, run => {
      if (run.place === 0) taking = scan();
      return taking.take(run.markdown());
    });
    return taking.done();
  };
  // Where the run that holds the first of `own` stands, by `PieceAt`'s rule: one pass of
  // the summaries, the Markdown and the tables of the runs passed summed.
  let placed = (own: OwnRange): PieceAt => {
    // The run named so far, with what the runs before it write; then what the runs passed do.
    let place = -1, mdStart = 0, tablesBefore = 0;
    let markdown = 0, tables = 0;
    store.walk(version, run => {
      if (run.place === 0) {
        place = -1;
        markdown = tables = 0;
      }
      let { markdownLength } = run.summary;
      let held = run.summary.tables.length;
      let byTable = own !== "end" && "table" in own;
      // No run that starts past a Markdown offset holds it, and none after such a run.
      if (own !== "end" && "markdown" in own && markdown > own.markdown.mdStart) return false;
      let named = own === "end" ||
        ("table" in own
          ? own.table >= tables && own.table < tables + held
          // The last run that writes a character; while none has, the last run passed, which
          // is the version's last where the tab writes nothing.
          : markdownLength > 0 || markdown === 0);
      if (named) {
        place = run.place;
        mdStart = markdown;
        tablesBefore = tables;
      }
      markdown += markdownLength;
      tables += held;
      return !(named && byTable);
    });
    if (place < 0) throw new DocPieceError(PIECE_NAMES_NOTHING);
    return { place, mdStart, tablesBefore, own };
  };
  // The nearest line of the run at `place` that ends at or before offset `end` of the run's
  // Markdown, or at its end (`lineAbove`): that run's Markdown read, and no other.
  let lineIn = (place: number, end: number): string | undefined => {
    let line: string | undefined;
    store.walk(version, run => {
      let { markdownLength, tables } = run.summary;
      line = lineAbove(run.markdown(), tables, Math.min(end, markdownLength));
      return false;
    }, place, place + 1);
    return line;
  };
  let blank: boolean | undefined;
  let totals: { count: number; cells: number } | undefined;
  let shaped: { shape: string; tables: readonly number[] } | undefined;
  let numbered: { table: number; after: boolean } | undefined;
  let found: { text: string; before: boolean; at: number | "none" | "many" } | undefined;
  let last: { own: OwnRange; rendering: DocTabSnapshot; decoded: DocPiece["decoded"] } | undefined;
  let reading: StoredTabReading = {
    version,
    tabId: version.tabId,
    blank: () => blank ??= stored(() => {
      // `summaryJoiner`'s rule: Markdown of one character at most, and every run blank.
      let chars = 0, every = true;
      store.walk(version, run => {
        if (run.place === 0) {
          chars = 0;
          every = true;
        }
        chars += run.summary.markdownLength;
        every &&= run.summary.blank;
        return every && chars <= 1;
      });
      return every && chars <= 1;
    }),
    find(text, lineBreakBefore = false) {
      if (found?.text !== text || found.before !== lineBreakBefore) {
        let at = stored(() => {
          let followed = scanned(() => markdownScan(text, lineBreakBefore));
          return followed === "crowded"
            ? scanned(() => prefixScan(text, lineBreakBefore)) : followed;
        });
        found = { text, before: lineBreakBefore, at };
      }
      return found.at;
    },
    tables: () => totals ??= stored(() => {
      let count = 0, cells = 0;
      store.walk(version, run => {
        if (run.place === 0) count = cells = 0;
        count += run.summary.tables.length;
        for (let table of run.summary.tables) cells += table.cells;
        return true;
      });
      return { count, cells };
    }),
    tablesShaped(shape) {
      if (shaped?.shape !== shape) {
        let id = runId(shape);
        let tables = stored(() => {
          let numbers: number[] = [];
          let passed = 0;
          store.walk(version, run => {
            if (run.place === 0) {
              numbers = [];
              passed = 0;
            }
            for (let table of run.summary.tables) {
              if (table.shape === id && numbers.length < 2) numbers.push(passed);
              passed++;
            }
            return numbers.length < 2;
          });
          return numbers;
        });
        shaped = { shape, tables };
      }
      return shaped.tables;
    },
    numberedAfter(table) {
      if (numbered?.table !== table) {
        let after = stored(() => {
          // A table is a run of its own: what stands after it stands in the runs after its.
          let passed = 0, behind = false, answer = false;
          store.walk(version, run => {
            if (run.place === 0) {
              passed = 0;
              behind = answer = false;
            }
            let { tables, numberedItems } = run.summary;
            if (behind) answer = numberedItems || tables.some(later => later.numbered);
            else behind = table >= passed && table < passed + tables.length;
            passed += tables.length;
            return !answer;
          });
          return answer;
        });
        numbered = { table, after };
      }
      return numbered.after;
    },
    lineBefore: mdStart => stored(() => {
      // The run that holds the character before `mdStart`, and where its Markdown starts.
      let place = -1, start = 0;
      if (mdStart > 0) {
        let passed = 0;
        store.walk(version, run => {
          if (run.place === 0) passed = 0;
          let end = passed + run.summary.markdownLength;
          if (mdStart <= end && mdStart > passed) {
            place = run.place;
            start = passed;
            return false;
          }
          passed = end;
          return true;
        });
      }
      // From there backwards, one run's Markdown in hand at a time: from `mdStart` in the
      // first, and from the run's end, a line start, in each before it.
      for (let end = mdStart - start; place >= 0; place--, end = Infinity) {
        let line = lineIn(place, end);
        if (line !== undefined) return line;
      }
      return undefined;
    }),
    piece(own) {
      if (last && sameOwn(last.own, own)) return last.rendering;
      let piece = stored(() => store.piece(version, placed(own)));
      last = {
        own, decoded: piece.decoded,
        rendering: { ...piece.rendering, part: { ...piece.at, tab: reading } },
      };
      return last.rendering;
    },
    takeDecoded() {
      let decoded = last?.decoded;
      last = undefined;
      return decoded;
    },
  };
  return reading;
}
