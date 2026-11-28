// What the Sheets preview reads of a sheet to draw a view of it, and which of the sheet's frozen
// lines it keeps in view: the rules of previews/sheets/window.js, which touches no page. They
// are held to what the session draws for a window (drawnCells()), over many sheets and views,
// and to the reads they have the client make of one as it learns the sizes of the sheet's lines.

import { describe, expect, it } from "vitest";
import { inView, laidOut, learnt, lines, MAX_CELLS, READS, readOn, short as shortOf, smaller, starts, unfrozen, windowOf } from "../src/previews/sheets/window.js";
import { drawnCells, MAX_DRAWN_CELLS } from "../src/sheets-drawing";
import { grid, sheet } from "./sheets-fixture";

type Axis = "rows" | "columns";
type Count = Record<Axis, number>;
type Sheet = { count: Count; frozen: Count; band: Count; pane: Count };
type View = { r0: number; r1: number; c0: number; c1: number; ends?: Axis[] };
type Window = View & { cut: Axis[]; without: Axis[] };
const cut = unfrozen as (sheet: Sheet, room?: number) => Axis[];
const read = windowOf as (sheet: Sheet, view: View, room?: number, short?: Axis[]) => Window;
const lacks = shortOf as (window: View, view: View, count: Count, frozen: Count, exact?: boolean) => Axis[];
const less = smaller as (sheet: Sheet, view: View, room: number, short: Axis[]) => number | undefined;

const PANE = { rows: 500, columns: 800 };
const NONE = { rows: 0, columns: 0 };
/** Every size a read refused as too large leaves the client asking for. */
const ROOMS = [MAX_CELLS, 5000, 2500, 1250, 625, 312];
const SHORT: Axis[][] = [[], ["rows"], ["columns"], ["rows", "columns"]];

describe("the frozen lines the Sheets preview keeps in view", () => {
  const count = { rows: 50_000, columns: 18_000 };
  const of = (frozen: Count, band: Count, pane = PANE) => ({ count, frozen, band, pane });

  it("keeps those that leave half the view to what scrolls, each way", () => {
    expect(cut(of({ rows: 2, columns: 1 }, { rows: 42, columns: 100 }))).toEqual([]);
    expect(cut(of({ rows: 12, columns: 4 }, { rows: 250, columns: 400 }))).toEqual([]);
    expect(cut(of({ rows: 12, columns: 4 }, { rows: 251, columns: 400 }))).toEqual(["rows"]);
    // Four or five columns of the usual width in a side pane.
    expect(cut(of({ rows: 1, columns: 5 }, { rows: 21, columns: 500 }, { rows: 500, columns: 450 }))).toEqual(["columns"]);
    expect(cut(of({ rows: 30, columns: 5 }, { rows: 630, columns: 500 }))).toEqual(["rows", "columns"]);
  });

  it("lets go of those too many to draw beside a window: the more numerous, and the others only if need be", () => {
    // Of no size known, so only their number tells.
    expect(cut(of({ rows: 2000, columns: 10 }, NONE))).toEqual(["rows"]);
    expect(cut(of({ rows: 10, columns: 1000 }, NONE))).toEqual(["columns"]);
    expect(cut(of({ rows: 3, columns: 5000 }, NONE))).toEqual(["columns"]);
    expect(cut(of({ rows: 300, columns: 300 }, NONE))).toEqual(["rows", "columns"]);
    expect(cut(of({ rows: 150, columns: 10 }, NONE))).toEqual([]);
    // A sheet of few columns has room for more frozen rows beside all of them.
    expect(cut({ count: { rows: 5000, columns: 4 }, frozen: { rows: 2000, columns: 0 }, band: NONE, pane: PANE })).toEqual([]);
  });

  it("lets go of more where a read made smaller holds less", () => {
    expect(ROOMS.map(room => cut(of({ rows: 50, columns: 20 }, NONE), room))).toEqual(
      [[], [], ["rows"], ["rows"], ["rows", "columns"], ["rows", "columns"]]);
    // One row and two columns are kept however small the read.
    expect(ROOMS.map(room => cut(of({ rows: 1, columns: 2 }, NONE), room).length)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("goes by their number alone in a view with no size yet", () => {
    expect(cut(of({ rows: 30, columns: 5 }, { rows: 630, columns: 500 }, { rows: 0, columns: -46 }))).toEqual([]);
    expect(cut(of({ rows: 2000, columns: 5 }, { rows: 42_000, columns: 500 }, NONE))).toEqual(["rows"]);
  });
});

/** What the session draws for a window: its own lines, after the frozen ones before it that it is not asked to leave out. */
function drawn(frozen: Count, at: Window): Count {
  const lead = (axis: Axis, start: number) => at.without.includes(axis) ? 0 : Math.min(frozen[axis], start);
  return { rows: lead("rows", at.r0) + at.r1 - at.r0, columns: lead("columns", at.c0) + at.c1 - at.c0 };
}
const holds = (at: View, view: View) => at.r0 <= view.r0 && at.r1 >= view.r1 && at.c0 <= view.c0 && at.c1 >= view.c1;

const large = (frozen: Count, pane = PANE) => ({ count: { rows: 5000, columns: 60 }, frozen, band: NONE, pane });
const frozens = (all: number) => [...new Set([0, 1, 3, 48, 2000, all - 1])].filter(n => n >= 0 && n < all);
const lineOf = (size: number, all: number, offset: number) => Math.min(all - 1, Math.floor(offset / size));
/** A deterministic walk of the places and sizes of views a sheet can be read at. */
function* cases() {
  for (const rows of [1, 27, 201, 1000, 50_000]) for (const columns of [1, 27, 60, 2000, 18_278]) {
    for (const fr of frozens(rows)) for (const fc of frozens(columns)) {
      for (const pane of [{ rows: 126, columns: 154 }, { rows: 476, columns: 404 }, { rows: 1376, columns: 1954 }]) {
        for (const [high, across] of [[21, 100], [3, 500], [40, 20]]) {
          for (const place of [0, 0.3, 1]) {
            const from = { rows: Math.max(0, rows * high - pane.rows) * place, columns: Math.max(0, columns * across - pane.columns) * place };
            const view = {
              r0: lineOf(high, rows, from.rows), r1: lineOf(high, rows, from.rows + pane.rows) + 1,
              c0: lineOf(across, columns, from.columns), c1: lineOf(across, columns, from.columns + pane.columns) + 1,
            };
            const of = { count: { rows, columns }, frozen: { rows: fr, columns: fc }, pane };
            // With the sizes of the frozen lines read, and with none read yet.
            yield { ...of, band: { rows: fr * high, columns: fc * across }, view };
            yield { ...of, band: NONE, view };
          }
        }
      }
    }
  }
}
/** Whether a window with all the room one way lies where it is to: `start` to `end`, of a view `first` to `last`, with `kept` frozen lines in view. */
const placed = (start: number, end: number, first: number, last: number, all: number, kept: number) =>
  last === all && first >= kept ? end === all : start === first || (start < first && end === all);
/** `view` as it grows once `more` of the lines after it turn out hidden, each way named. */
const grown = ({ r0, r1, c0, c1 }: View, count: Count, more: number, axes: Axis[]): View => ({
  r0, c0, r1: axes.includes("rows") ? Math.min(count.rows, r1 + more) : r1, c1: axes.includes("columns") ? Math.min(count.columns, c1 + more) : c1,
});

describe("the window the Sheets preview reads", () => {
  it("is the whole of a small sheet, and of a large one what a read holds around the view", () => {
    expect(read({ count: { rows: 200, columns: 26 }, frozen: { rows: 1, columns: 0 }, band: NONE, pane: PANE }, { r0: 50, r1: 80, c0: 0, c1: 9 }))
      .toMatchObject({ r0: 0, r1: 200, c0: 0, c1: 26 });
    expect(read(large({ rows: 1, columns: 0 }), { r0: 2995, r1: 3029, c0: 0, c1: 13 }))
      .toEqual({ r0: 2927, r1: 3097, c0: 0, c1: 39, cut: [], without: [] });
  });

  it("is asked for without the frozen lines let go of, once it starts past the sheet's first", () => {
    const narrow = { ...large({ rows: 2000, columns: 3 }), band: { rows: 0, columns: 450 }, pane: { rows: 500, columns: 400 } };
    expect(read(narrow, { r0: 0, r1: 24, c0: 0, c1: 4 })).toMatchObject({ r0: 0, c0: 0, cut: ["rows", "columns"], without: [] });
    expect(read(narrow, { r0: 3000, r1: 3024, c0: 0, c1: 4 })).toMatchObject({ cut: ["rows", "columns"], without: ["rows"] });
    expect(read(narrow, { r0: 3000, r1: 3024, c0: 40, c1: 44 })).toMatchObject({ cut: ["rows", "columns"], without: ["rows", "columns"] });
  });

  it("counts the frozen lines that come with it, which are none for one that starts among them", () => {
    // 48 frozen columns and a view of all 60, from the first: no column comes twice.
    const wide = { count: { rows: 150, columns: 60 }, frozen: { rows: 1, columns: 48 }, band: NONE, pane: { rows: 1376, columns: 1954 } };
    expect(read(wide, { r0: 0, r1: 92, c0: 0, c1: 60 })).toMatchObject({ r0: 0, r1: 150, c0: 0, c1: 60 });
  });

  it("gives the rows their room where columns are many, as where rows are", () => {
    // Ten frozen rows, the thousand frozen columns let go of.
    let at = read({ count: { rows: 1000, columns: 2000 }, frozen: { rows: 10, columns: 1000 }, band: NONE, pane: PANE }, { r0: 100, r1: 130, c0: 1200, c1: 1209 });
    expect([at.cut, holds(at, { r0: 100, r1: 130, c0: 1200, c1: 1209 })]).toEqual([["columns"], true]);
    // And two hundred frozen rows that stay leave the view its rows, not one of them.
    at = read(large({ rows: 199, columns: 0 }), { r0: 3000, r1: 3040, c0: 0, c1: 15 });
    expect(at.r1 - at.r0).toBeGreaterThanOrEqual(40);
  });

  it("is the view's lines the shorter way and what there is room for the longer way, where no read holds the view", () => {
    // A read made small: 34 rows of 13 columns are more than its 312 cells.
    expect(read(large({ rows: 1, columns: 0 }), { r0: 100, r1: 134, c0: 5, c1: 18 }, 312)).toMatchObject({ r0: 100, r1: 123, c0: 5, c1: 18 });
    // A filter leaves 28 rows of 3,028 showing, and 9 columns are in view: all 9, not one of them.
    expect(read(large({ rows: 1, columns: 2 }), { r0: 0, r1: 3028, c0: 0, c1: 9 })).toMatchObject({ r0: 0, r1: 1111, c0: 0, c1: 9 });
    // And 28 rows of 3,000 columns, 9 of them showing: all 28 rows.
    expect(read({ count: { rows: 5000, columns: 6000 }, frozen: NONE, band: NONE, pane: PANE }, { r0: 40, r1: 68, c0: 3, c1: 3003 }))
      .toMatchObject({ r0: 40, r1: 68, c0: 3, c1: 360 });
  });

  it("spends its room the way the read before left the view short, from where the view starts", () => {
    const view = { r0: 3000, r1: 3028, c0: 20, c1: 29 };
    // One frozen row comes with each, and counts.
    expect(read(large({ rows: 1, columns: 0 }), view, MAX_CELLS, ["rows"])).toMatchObject({ r0: 3000, r1: 4110, c0: 20, c1: 29 });
    expect(read({ ...large({ rows: 1, columns: 0 }), count: { rows: 5000, columns: 6000 } }, view, MAX_CELLS, ["columns"]))
      .toMatchObject({ r0: 3000, r1: 3028, c0: 20, c1: 364 });
    // Short both ways, across: of a sheet of 60 columns that is all of them to its end, and the rows take the rest.
    expect(read(large({ rows: 1, columns: 0 }), view, MAX_CELLS, ["rows", "columns"])).toMatchObject({ r0: 3000, r1: 3165, c0: 0, c1: 60 });
  });

  it("holds the view wherever a read has room for it, starts where it starts where not, and never asks for more than a read holds", () => {
    let checked = 0;
    for (const { view: plain, ...of } of cases()) {
      const { count, frozen } = of;
      // As it grows where lines turn out hidden, each way it has further to grow.
      const views = new Map(SHORT.map(hidden => grown(plain, count, 700, hidden)).map(view => [`${view.r1} ${view.c1}`, view]));
      for (const view of views.values()) {
        const [tall, wide] = [view.r1 - view.r0, view.c1 - view.c0];
        // Asked for past the sheet's end, as around a change at its edge, where it reaches it.
        const past = view.r1 === count.rows || view.c1 === count.columns
          ? { ...view, r1: view.r1 === count.rows ? view.r1 + 30 : view.r1, c1: view.c1 === count.columns ? view.c1 + 12 : view.c1 } : undefined;
        for (const room of ROOMS) {
          const gone = cut(of, room);
          // The frozen lines the session draws before the view, were the view the window.
          const lead = { rows: gone.includes("rows") ? 0 : Math.min(frozen.rows, view.r0), columns: gone.includes("columns") ? 0 : Math.min(frozen.columns, view.c0) };
          const fits = (lead.rows + tall) * (lead.columns + wide) <= room;
          for (const lacking of SHORT) {
            const at = read(of, view, room, lacking);
            const told = () => JSON.stringify({ ...of, view, room, lacking, at });
            const [down, across] = [at.r1 - at.r0, at.c1 - at.c0];
            checked++;
            // Within the sheet, and of a cell at least.
            if (!(at.r0 >= 0 && at.c0 >= 0 && down > 0 && across > 0 && at.r1 <= count.rows && at.c1 <= count.columns)) expect.fail(told());
            // The frozen lines cut are those the rule lets go of, left out of a window they would come with.
            if (`${at.cut}` !== `${gone}` || `${at.without}` !== `${gone.filter(axis => (axis === "rows" ? at.r0 : at.c0) > 0)}`) expect.fail(told());
            const cells = drawn(frozen, at);
            if (cells.rows * cells.columns > room) expect.fail(`over: ${told()}`);
            if (fits && !holds(at, view)) expect.fail(`short of the view: ${told()}`);
            // Which is read as the view to its end.
            if (past && JSON.stringify(read(of, past, room, lacking)) !== JSON.stringify(at)) expect.fail(`past the end: ${told()}`);
            if (fits && !lacking.length) continue;
            // Otherwise it is from where the view starts, as far as the sheet goes: or back from
            // where the view ends at the sheet's end, past the frozen lines that come with it.
            if (!placed(at.r0, at.r1, view.r0, view.r1, count.rows, gone.includes("rows") ? 0 : frozen.rows) ||
              !placed(at.c0, at.c1, view.c0, view.c1, count.columns, gone.includes("columns") ? 0 : frozen.columns)) expect.fail(`off the view: ${told()}`);
            // With all the room one way: the longer where the view has no room, and the way it was left short where it has.
            const long = !fits ? (tall < wide ? "columns" : "rows") : lacking.includes("columns") ? "columns" : "rows";
            const more = long === "rows" ? [at.r1 < count.rows, (lead.rows + down + 1) * (lead.columns + across)] as const
              : [at.c1 < count.columns, (lead.rows + tall) * (lead.columns + across + 1)] as const;
            if (more[0] && more[1] <= room) expect.fail(`room left: ${told()}`);
            // And the view's lines the other way, where one line of them has room.
            if (long === "rows" && (lead.rows + 1) * (lead.columns + wide) <= room && !(at.c0 <= view.c0 && at.c1 >= view.c1)) expect.fail(`short of the columns: ${told()}`);
            if (long === "columns" && (lead.rows + tall) * (lead.columns + 1) <= room && !(at.r0 <= view.r0 && at.r1 >= view.r1)) expect.fail(`short of the rows: ${told()}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(900_000);
  });

  it("is read back from where the view ends, where nothing shows after it", () => {
    const of = large({ rows: 1, columns: 0 });
    // Rows 3,000 on are hidden: the view ends at them, short of the sheet's end.
    const view = { r0: 2973, r1: 3000, c0: 20, c1: 29 };
    expect(read(of, { ...view, ends: ["rows" as const] }, MAX_CELLS, ["rows"])).toMatchObject({ r0: 1890, r1: 3000, c0: 20, c1: 29 });
    expect(read(of, view, MAX_CELLS, ["rows"])).toMatchObject({ r0: 2973, r1: 4083 });
    // A view that reaches the sheet's end has nothing after it.
    expect(read(of, { r0: 2000, r1: 5000, c0: 20, c1: 29 })).toMatchObject({ r0: 3890, r1: 5000, c0: 20, c1: 29 });
    // One among the frozen lines is read from where it starts: a window that starts later comes with more of them.
    const frozen = { count: { rows: 3000, columns: 60 }, frozen: { rows: 48, columns: 0 }, band: NONE, pane: PANE };
    expect(read(frozen, { r0: 10, r1: 3000, c0: 0, c1: 9 })).toMatchObject({ r0: 10, r1: 1111 });
  });

  it("falls short of a view it does not hold with a few lines around it, as far as the sheet and its frozen lines go", () => {
    const count = { rows: 5000, columns: 60 };
    const view = { r0: 100, r1: 130, c0: 0, c1: 10 };
    expect(lacks({ r0: 96, r1: 134, c0: 0, c1: 14 }, view, count, NONE)).toEqual([]);
    expect(lacks({ r0: 97, r1: 134, c0: 0, c1: 14 }, view, count, NONE)).toEqual(["rows"]);
    expect(lacks({ r0: 96, r1: 134, c0: 0, c1: 13 }, view, count, NONE)).toEqual(["columns"]);
    // Of the view alone, once it is read on.
    expect(lacks({ r0: 100, r1: 130, c0: 0, c1: 10 }, view, count, NONE, true)).toEqual([]);
    expect(lacks({ r0: 100, r1: 129, c0: 1, c1: 10 }, view, count, NONE, true)).toEqual(["rows", "columns"]);
    // The frozen lines before a window are drawn with it, and nothing is past the sheet's last.
    expect(lacks({ r0: 2, r1: 5000, c0: 0, c1: 60 }, { r0: 2, r1: 4999, c0: 0, c1: 58 }, count, { rows: 2, columns: 0 })).toEqual([]);
    expect(lacks({ r0: 2, r1: 5000, c0: 0, c1: 60 }, { r0: 2, r1: 4999, c0: 0, c1: 58 }, count, NONE)).toEqual(["rows"]);
  });

  it("asks again for a window refused as too large with the most room that makes it another, down to the least", () => {
    const of = large({ rows: 1, columns: 0 });
    const view = { r0: 3000, r1: 3028, c0: 10, c1: 18 };
    // Half the room asks for fewer columns, and half of that for the same window again: a quarter does not.
    expect([MAX_CELLS, 5000, 2500, 1250].map(room => Object.values(read(of, view, room)).slice(0, 4))).toEqual(
      [[2944, 3084, 2, 26], [2944, 3084, 6, 22], [2944, 3084, 6, 22], [2976, 3053, 6, 22]]);
    expect([less(of, view, MAX_CELLS, []), less(of, view, 5000, []), less(of, view, 1250, []), less(of, view, 312, [])]).toEqual([5000, 1250, 625, undefined]);
    // A sheet read whole is read in part once that is refused.
    const small = { count: { rows: 200, columns: 26 }, frozen: NONE, band: NONE, pane: PANE };
    const top = { r0: 0, r1: 24, c0: 0, c1: 8 };
    expect([read(small, top), read(small, top, less(small, top, MAX_CELLS, []))]).toMatchObject([{ r1: 200, c1: 26 }, { r1: 120, c1: 16 }]);
    let checked = 0;
    for (const { view: seen, ...laid } of cases()) {
      if (++checked % 7) continue;
      const asked = (room: number) => JSON.stringify({ ...read(laid, seen, room), cut: [] });
      for (const room of ROOMS) {
        const next = less(laid, seen, room, []);
        const told = () => JSON.stringify({ ...laid, seen, room, next });
        // Another window, of fewer cells: or none, of a window no read is too small for.
        if (next === undefined ? asked(room) !== asked(312) : !(next < room && asked(next) !== asked(room))) expect.fail(told());
        const cells = drawn(laid.frozen, read(laid, seen, next ?? room));
        if (cells.rows * cells.columns > (next ?? 312)) expect.fail(`over: ${told()}`);
      }
    }
  });

  it("asks the session for what the session draws: the same lines, and no more cells than it draws", () => {
    expect(MAX_CELLS).toBe(MAX_DRAWN_CELLS);
    const seen = new Set<string>();
    let checked = 0;
    for (const { view, ...of } of cases()) {
      // One case in many: the session lists every line it draws.
      if (++checked % 13) continue;
      const { count, frozen } = of;
      const at = read(of, view, ROOMS[checked % ROOMS.length], SHORT[checked % SHORT.length]);
      const book = grid([sheet(0, "Sheet", { rowCount: count.rows, columnCount: count.columns, frozenRowCount: frozen.rows, frozenColumnCount: frozen.columns })]);
      const area = { sheetId: 0, rect: { startRow: at.r0, endRow: at.r1, startColumn: at.c0, endColumn: at.c1 }, rows: at.r1 - at.r0, columns: at.c1 - at.c0 };
      const cells = drawnCells(book, area, [], at.without);
      expect([cells.rows.length, cells.columns.length], JSON.stringify({ ...of, view, at })).toEqual(Object.values(drawn(frozen, at)));
      expect(cells.rows.length * cells.columns.length).toBeLessThanOrEqual(MAX_DRAWN_CELLS);
      // The frozen lines of an axis cut come only as the window's own first lines.
      for (const axis of at.without) expect(cells[axis][0]).toBe(axis === "rows" ? at.r0 : at.c0);
      seen.add(`${at.without}`);
    }
    // Asked for without the frozen rows, the frozen columns, both and neither.
    expect([...seen].toSorted()).toEqual(["", "columns", "rows", "rows,columns"]);
    expect(checked).toBeGreaterThan(10_000);
  });
});

type Lines = { count: number; size: number; known: Map<number, number> };
type Laid = Sheet & { axes: Record<Axis, Lines> };
type Line = { number: number; size: number; hidden?: true };
type Drawn = Window & { chain?: number; drawing: Record<Axis, Line[]> };
type Step = { view?: View; lacks: Axis[]; room: number; chain: number; short?: boolean };
const laid = laidOut as (axes: Record<Axis, Lines>, frozen: Count, pane: Count) => Laid;
const seen = inView as (sheet: Laid, room: number, from: Count) => View;
const decide = readOn as (sheet: Laid, from: Count, shown: Window & { chain?: number }, room: number, moved: boolean) => Step;
const hold = learnt as (sheet: Laid, room: number, from: Count, drawing: Drawn["drawing"]) => Count;
const ends = starts as (axis: Lines) => Float64Array;
const AXES: Axis[] = ["rows", "columns"];

/** The lines of an axis as the spreadsheet has them: how many, and the size of each, which is none for one hidden. */
type Real = { count: number; size: (line: number) => number };
const real = (count: number, size: number | Real["size"]): Real => ({ count, size: typeof size === "number" ? () => size : size });
/** The sizes of lines of which those from `from` up to `to` are hidden. */
const hiding = (from: number, to: number, size: number) => (line: number) => line >= from && line < to ? 0 : size;

/**
 * A sheet opened as the client opens one: what is made up here is the page, and every choice is
 * window.js's. The page is where the view is scrolled to, which a browser keeps within the
 * sheet; a session that draws a window's lines at their real sizes after the frozen ones before
 * it, and refuses a drawing of more than `most` cells (of that window) as too large; and the
 * windows the client keeps, so that one is not read twice. load() has read the window in view. `follow()` reads on
 * as the client's does, for as long as readOn() names a read, while the reader scrolls `by`
 * pixels during each of the first `drag` of them; `scroll()` is the reader scrolling between.
 */
function open(rows: Real, columns: Real, frozen: Count, pane: Count, { top = 0, left = 0, most = (_window: View): number => MAX_CELLS } = {}) {
  const lined: Record<Axis, Real> = { rows, columns };
  const axes = { rows: lines(rows.count, 21) as Lines, columns: lines(columns.count, 100) as Lines };
  const lay = () => laid(axes, frozen, pane);
  const within = (at: Count) => Object.fromEntries(AXES.map(axis => [axis, Math.max(0, Math.min(at[axis], ends(axes[axis])[axes[axis].count] - pane[axis]))])) as Count;
  let [from, room, moved, reads] = [within({ rows: top, columns: left }), MAX_CELLS, false, 0];
  let shown!: Drawn;
  const asked: string[] = [];
  const kept = new Set<string>();
  const listed = (axis: Axis, at: Window): Line[] => {
    const [first, last] = axis === "rows" ? [at.r0, at.r1] : [at.c0, at.c1];
    const lead = at.without.includes(axis) ? 0 : Math.min(frozen[axis], first);
    return [...Array.from({ length: lead }, (_line, n) => n), ...Array.from({ length: last - first }, (_line, n) => first + n)]
      .map(line => lined[axis].size(line) ? { number: line + 1, size: lined[axis].size(line) } : { number: line + 1, size: 21, hidden: true });
  };
  // readWindow(): a window refused as too large is asked for again as smaller() says.
  const readWindow = (view: View, lacking: Axis[] = []): Drawn => {
    for (;;) {
      const at = read(lay(), view, room, lacking);
      const drawing = { rows: listed("rows", at), columns: listed("columns", at) };
      const range = `${[at.r0, at.r1, at.c0, at.c1]} ${at.without}`;
      if (!kept.has(range)) asked.push(range);
      if (drawing.rows.length * drawing.columns.length <= most(at)) return kept.add(range) && { ...at, drawing };
      const fewer = less(lay(), view, room, lacking);
      if (!fewer) throw new Error(`refused: ${range}`);
      room = fewer;
    }
  };
  // drawWindow(): the lines are learnt, and the view held on those it shows.
  const draw = (window: Drawn, chain?: number) => {
    from = within(hold(lay(), room, from, window.drawing));
    shown = { ...window, chain };
    reads++;
  };
  draw(readWindow(seen(lay(), room, from)));
  // The reader has moved the view once it is somewhere else, as the client sees it.
  const scroll = (by: Partial<Count>) => {
    const to = within({ rows: from.rows + (by.rows ?? 0), columns: from.columns + (by.columns ?? 0) });
    [moved, from] = [moved || to.rows !== from.rows || to.columns !== from.columns, to];
  };
  const follow = (drag = 0, by: Partial<Count> = {}) => {
    for (;;) {
      const step = decide(lay(), from, shown, room, moved);
      const view = seen(lay(), room, from);
      if (!step.view) return { reads, shown, view, room, asked, short: step.short!, gone: cut(lay(), room) };
      [moved, room] = [false, step.room];
      const window = readWindow(step.view, step.lacks);
      if (drag-- > 0) scroll(by);
      draw(window, step.chain);
      if (reads > 100) throw new Error(`read without end: ${asked.slice(-4).join(" | ")}`);
    }
  };
  return { follow, scroll };
}
const settle = (...page: Parameters<typeof open>) => open(...page).follow();

describe("the reads the Sheets preview makes of a view", () => {
  const SIDE = { rows: 576, columns: 754 };
  const WIDE = { rows: 1376, columns: 1954 };
  const HEADED = { rows: 1, columns: 2 };

  it("reads a sheet of lines of the usual sizes once, wherever it is opened", () => {
    for (const [top, left] of [[0, 0], [40_000, 0], [40_000, 3000], [104_400, 5246]]) {
      const { reads, shown, view, short } = settle(real(5000, 21), real(60, 100), HEADED, SIDE, { top, left });
      expect([reads, short, holds(shown, view)]).toEqual([1, false, true]);
    }
  });

  it("reads on before the view reaches the edge of what is drawn, and towards the first lines among frozen ones let go of", () => {
    // Rows 1 to 140 are drawn: nothing is read until fewer than four of them are left after the view.
    let page = open(real(5000, 21), real(60, 100), HEADED, SIDE);
    page.scroll({ rows: 108 * 21 });
    expect(page.follow()).toMatchObject({ reads: 1, view: { r1: 136 } });
    page.scroll({ rows: 21 });
    expect(page.follow()).toMatchObject({ reads: 2, view: { r1: 137 }, shown: { r1: 191 } });
    // 2,000 frozen rows scroll with the rest, and are not drawn before a window: one that starts after the view is short of it.
    page = open(real(5000, 21), real(60, 100), { rows: 2000, columns: 0 }, SIDE, { top: 21_000 });
    expect(page.follow()).toMatchObject({ reads: 1, gone: ["rows"], shown: { r0: 944, r1: 1084 } });
    page.scroll({ rows: -60 * 21 });
    expect(page.follow()).toMatchObject({ reads: 2, view: { r0: 940 }, shown: { r0: 884 } });
  });

  it("reads past the rows a filter hides, under a frozen first row, and ends with the view drawn", () => {
    // Rows 2 to 3,000 hidden: more than one read holds beside the 8 columns in view.
    let { reads, shown, view, short } = settle(real(5000, hiding(1, 3000, 21)), real(30, 100), HEADED, SIDE);
    expect([reads, short, holds(shown, view), view.r0]).toEqual([1 + READS, false, true, 3000]);
    // A run a read does hold, further down the view.
    ({ reads, shown, view, short } = settle(real(5000, hiding(10, 900, 21)), real(30, 100), HEADED, SIDE));
    expect([reads, short, holds(shown, view), view.r1 > 900]).toEqual([3, false, true, true]);
    // One row in ten showing: the 28 in view are 280 of the sheet's.
    ({ reads, shown, view, short } = settle(real(8000, line => line % 10 ? 0 : 21), real(30, 100), NONE, SIDE, { top: 300 }));
    expect([reads, short, holds(shown, view), view.r1 - view.r0 > 270]).toEqual([2, false, true, true]);
  });

  it("keeps every column in view where the rows a filter hides are more than a read holds", () => {
    // One row in a hundred showing: the view is 2,700 rows of 8 columns.
    const { reads, shown, view, short } = settle(real(8000, line => line % 100 ? 0 : 21), real(30, 100), NONE, SIDE, { top: 300 });
    expect([reads, short, shown.r0, shown.r1 - shown.r0, shown.c0 <= view.c0 && shown.c1 >= view.c1]).toEqual([3, true, view.r0, 1250, true]);
  });

  it("reads past hidden columns as it does past hidden rows", () => {
    let { reads, shown, view, short } = settle(real(5000, 21), real(6000, hiding(3, 200, 100)), { rows: 1, columns: 1 }, SIDE, { top: 2100 });
    expect([reads, short, holds(shown, view), view.c1 > 200]).toEqual([3, false, true, true]);
    // 3,000 of them under 28 rows: every row in view, and the columns there is room for.
    ({ reads, shown, view, short } = settle(real(5000, 21), real(6000, hiding(3, 3000, 100)), { rows: 1, columns: 1 }, SIDE, { top: 2100 }));
    expect([reads, short, shown.r0 <= view.r0 && shown.r1 >= view.r1, shown.c0 <= view.c0, shown.c1 - shown.c0 > 300]).toEqual([3, true, true, true, true]);
  });

  it("stops after a few reads on end of lines that all turn out hidden, and reads on once its reader moves the view", () => {
    // 7,000 rows hidden under the first: four reads on end of all the rows there is room for do not reach their end.
    const page = open(real(8000, hiding(1, 7000, 21)), real(30, 100), HEADED, SIDE);
    let { reads, short, shown } = page.follow();
    expect([reads, short, shown.r1 < 7000]).toEqual([1 + READS, true, true]);
    // And no more of a view that stays where it is.
    expect(page.follow().reads).toBe(1 + READS);
    page.scroll({ rows: 1 });
    let view;
    ({ reads, short, shown, view } = page.follow());
    expect([reads, short, holds(shown, view), view.r0]).toEqual([1 + 2 * READS, false, true, 7000]);
  });

  it("reads where its reader has scrolled to while a window was read, however many were read on end", () => {
    // A scrollbar dragged down a sheet of rows of the usual size, let go of during the nth read.
    for (let drag = 1; drag <= 2 * READS; drag++) {
      const page = open(real(50_000, 21), real(30, 100), HEADED, SIDE);
      page.scroll({ rows: 60_000 });
      const { reads, shown, view, short } = page.follow(drag, { rows: 60_000 });
      expect([drag, reads, short, holds(shown, view), view.r0 > 2800 * drag], `${drag}`).toEqual([drag, 2 + drag, false, true, true]);
    }
    // And through rows that are hidden: each read starts those on end over.
    const page = open(real(50_000, hiding(1, 20_000, 21)), real(30, 100), HEADED, SIDE);
    expect(page.follow(3, { rows: 40 }).reads).toBe(1 + 3 + READS);
  });

  it("reads back from the sheet's end past the rows hidden there, and stops where they are more than a few reads", () => {
    for (const [hidden, made, left] of [[600, 3, false], [3000, 1 + READS, false], [20_000, 1 + READS, true]] as const) {
      const { reads, shown, view, short } = settle(real(50_000, hiding(50_000 - hidden, 50_000, 21)), real(30, 100), HEADED, SIDE, { top: 1e9 });
      // The rows read to be hidden are not in view: those that show before them are, and are drawn.
      expect([hidden, reads, short, view.ends, !short && holds(shown, view) && view.r1 === 50_000 - hidden]).toEqual([hidden, made, left, ["rows"], !left]);
    }
  });

  it("reads the end of a sheet whose lines are smaller than it took them for once, and does not follow the view back", () => {
    // 600 columns of 10 pixels in a wide pane, scrolled to the last: 195 are in view, and a read holds 151 of 66 rows.
    const { reads, shown, view, short } = settle(real(5000, 21), real(600, 10), { rows: 1, columns: 0 }, WIDE, { left: 1e9 });
    expect([reads, short, shown.c1, shown.c1 - shown.c0, view.c1]).toEqual([2, true, 600, 151, 600]);
  });

  it("asks for no window twice on end, and for a smaller one where one is refused as too large", () => {
    // A read of more than 2,000 cells is refused: the window is asked for three times, each smaller.
    const { reads, room, asked, shown, view } = settle(real(5000, 21), real(60, 100), { rows: 1, columns: 0 }, SIDE, { top: 63_000, left: 1000, most: () => 2000 });
    expect([reads, room, asked, holds(shown, view)]).toEqual([1, 1250, ["2944,3084,2,26 ", "2944,3084,6,22 ", "2976,3053,6,22 "], true]);
  });

  it("asks for twice the room a refusal left once its reader moves the view past what is drawn", () => {
    // Rows 2 to 1,000 hold too much to read more than 2,000 cells of them at once.
    const page = open(real(5000, 21), real(60, 100), { rows: 1, columns: 0 }, SIDE, { most: ({ r0 }) => r0 < 1000 ? 2000 : MAX_CELLS });
    expect(page.follow()).toMatchObject({ reads: 1, room: 1250, asked: { length: 3 } });
    // Within what is drawn nothing is read, and the room stays.
    page.scroll({ rows: 21 });
    expect(page.follow()).toMatchObject({ reads: 1, room: 1250 });
    // Nor to keep in view 60 frozen rows let go of at the room there is, which twice the room would hold.
    const lay = laid({ rows: lines(5000, 21) as Lines, columns: lines(60, 100) as Lines }, { rows: 60, columns: 1 }, SIDE);
    const from = { rows: 21_000, columns: 0 };
    const shown = read(lay, seen(lay, 625, from), 625);
    expect([shown.cut, cut(lay, 1250), decide(lay, from, shown, 625, true)]).toEqual([["rows"], [], { short: false }]);
    // Further down those rows, a read of twice the room is refused, and one of the room is not.
    page.scroll({ rows: 8000 });
    expect(page.follow()).toMatchObject({ reads: 2, room: 1250, asked: { length: 5 } });
    // Past them it is not, and each view scrolled to is read with twice the room, up to all of it.
    for (const room of [2500, 5000, MAX_CELLS, MAX_CELLS]) {
      page.scroll({ rows: 20_000 });
      expect(page.follow().room).toBe(room);
    }
    expect(page.follow()).toMatchObject({ reads: 6, asked: { length: 9 } });
    // Reads on end of a view nobody moved keep the room they have: three refused to open, and none after.
    const { reads, room, asked } = settle(real(5000, hiding(1, 3000, 21)), real(30, 100), HEADED, SIDE, { most: () => 2000 });
    expect([reads, room, asked.length]).toEqual([1 + READS, 1250, 3 + READS]);
  });

  it("settles in a few reads whatever is hidden, frozen, refused or of another size than it was taken for", () => {
    const runs: [number, number][] = [[0, 0], [12, 40], [100, 700], [1, 3000]];
    let [settled, stopped] = [0, 0];
    for (const hiddenRows of runs) for (const hiddenColumns of runs) {
      for (const frozen of [NONE, HEADED, { rows: 30, columns: 4 }]) {
        for (const pane of [{ rows: 276, columns: 404 }, SIDE, WIDE]) {
          for (const [high, wide] of [[21, 100], [6, 30], [60, 240]]) {
            for (const [top, left] of [[0, 0], [300, 250], [50_000, 20_000], [1e9, 1e9]]) {
              for (const most of [MAX_CELLS, 1250]) {
                const page = open(real(5000, hiding(...hiddenRows, high)), real(4000, hiding(...hiddenColumns, wide)), frozen, pane, { top, left, most: () => most });
                let last = page.follow();
                const told = () => JSON.stringify({ hiddenRows, hiddenColumns, frozen, pane, high, wide, top, left, most, ...last, shown: { ...last.shown, drawing: 0 } });
                // Read where it opens, then where a reader scrolls it to while it is read, and after.
                for (const [made, move] of [[1, () => {}], [2, () => page.scroll({ rows: 900, columns: 700 })]] as const) {
                  move();
                  last = page.follow(made - 1, { rows: 5000, columns: 3000 });
                  const { reads, shown, view, room, gone, short, asked } = last;
                  settled++;
                  if (reads > made * (1 + READS) + made - 1) expect.fail(`many reads: ${told()}`);
                  if (new Set(asked).size < asked.length) expect.fail(`asked twice: ${told()}`);
                  const kept = { rows: gone.includes("rows") ? 0 : frozen.rows, columns: gone.includes("columns") ? 0 : frozen.columns };
                  if (short !== (lacks(shown, view, { rows: 5000, columns: 4000 }, kept, true).length > 0)) expect.fail(`not as said: ${told()}`);
                  if (!short) continue;
                  stopped++;
                  // A view is left short only where lines are hidden, or where it is more than a read
                  // holds once its lines are their own sizes: a few more of them show at each read.
                  const [tall, across] = [Math.floor(pane.rows / high) + 2, Math.floor(pane.columns / wide) + 2];
                  const nothing = hiddenRows[1] + hiddenColumns[1] === 0;
                  if (nothing && (frozen.rows + tall) * (frozen.columns + across) <= room) expect.fail(`left short: ${told()}`);
                }
              }
            }
          }
        }
      }
    }
    expect([settled, stopped > 0]).toEqual([6912, true]);
    // Thousands of sheets read to rest: seconds here, several times that on a busy runner.
  }, 60_000);

  it("lets go of frozen lines for their size only once it has read it", () => {
    // Three frozen columns 40 pixels wide, taken for 100 before they are read, in a narrow pane.
    const narrow = { rows: 476, columns: 404 };
    let { reads, gone } = settle(real(5000, 21), real(60, line => line < 3 ? 40 : 100), { rows: 1, columns: 3 }, narrow, { left: 4000 });
    expect([reads, gone]).toEqual([1, []]);
    // Three of the usual width leave less than half the view: read once with them, and then without.
    ({ reads, gone } = settle(real(5000, 21), real(60, 100), { rows: 1, columns: 3 }, narrow, { left: 4000 }));
    expect([reads, gone]).toEqual([2, ["columns"]]);
  });
});
