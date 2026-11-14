// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LineOrder, SheetOrder, cellKey, newLineIds, parseCellKey, type LineOp } from "../files/lib/lines.ts";

const insert = (ids: number[], before: number | null): LineOp => ({ kind: "insert", sheetId: "s", axis: "rows", ids, before });
const del = (ids: number[]): LineOp => ({ kind: "delete", sheetId: "s", axis: "rows", ids });
const move = (ids: number[], before: number | null): LineOp => ({ kind: "move", sheetId: "s", axis: "rows", ids, before });

describe("LineOrder", () => {
  it("starts in identity order and round-trips through runs", () => {
    const order = LineOrder.identity(5);
    expect(order.live()).toEqual([0, 1, 2, 3, 4]);
    expect(order.toRuns()).toEqual([[0, 5]]);
    order.apply(insert([100, 101], 2));
    order.apply(del([3]));
    expect(order.live()).toEqual([0, 1, 100, 101, 2, 4]);
    expect(order.toRuns()).toEqual([[0, 2], [100, 2], [2, 1], [3, 1, 1], [4, 1]]);
    const back = LineOrder.fromRuns(order.toRuns());
    expect(back.live()).toEqual(order.live());
    expect(back.has(3)).toBe(true);
    expect(back.isLive(3)).toBe(false);
  });

  it("skips malformed runs", () => {
    expect(LineOrder.fromRuns([[0, 2], "x", [5, -1], [1.5, 2], [7, 1, 1]]).toRuns()).toEqual([[0, 2], [7, 1, 1]]);
    expect(LineOrder.fromRuns(null).size).toBe(0);
  });

  it("inserts before a deleted line where that line was", () => {
    const order = LineOrder.identity(4);
    order.apply(del([2]));
    order.apply(insert([50], 2));
    expect(order.live()).toEqual([0, 1, 50, 3]);
  });

  it("moves lines in their current order and ignores a repeat", () => {
    const order = LineOrder.identity(6);
    expect(order.apply(move([4, 1], 0))).toBe(true);
    expect(order.live()).toEqual([1, 4, 0, 2, 3, 5]);
    expect(order.apply(move([4, 1], 0))).toBe(false);
    expect(order.apply(move([1], null))).toBe(true);
    expect(order.live()).toEqual([4, 0, 2, 3, 5, 1]);
  });

  it("is idempotent for inserts and deletes", () => {
    const order = LineOrder.identity(3);
    expect(order.apply(insert([9], 1))).toBe(true);
    expect(order.apply(insert([9], 0))).toBe(false);
    expect(order.apply(del([9]))).toBe(true);
    expect(order.apply(del([9]))).toBe(false);
    expect(order.live()).toEqual([0, 1, 2]);
  });

  it("spans walk inward past deleted ends", () => {
    const order = LineOrder.identity(6);
    order.apply(del([0, 5]));
    expect(order.span(0, 5)).toEqual([0, 3]);
    expect(order.span(5, 0)).toEqual([0, 3]);
    order.apply(del([1, 2, 3, 4]));
    expect(order.span(1, 3)).toBeNull();
    expect(order.span(1, 99)).toBeNull();
  });

  it("says why an op can't apply", () => {
    const order = LineOrder.identity(3);
    expect(order.refusal(insert([1], null), 100)).toBe("line id taken");
    expect(order.refusal(insert([7, 7], null), 100)).toBe("bad line ids");
    expect(order.refusal(insert([7], null), 3)).toBe("too many lines");
    expect(order.refusal(insert([7], 99), 100)).toBe("bad position");
    expect(order.refusal(del([0, 1, 2]), 100)).toBe("last line");
    expect(order.refusal(move([0], 0), 100)).toBe("bad position");
    order.apply(del([2]));
    expect(order.refusal(del([2]), 100)).toBe("line gone");
    expect(order.refusal(insert([7], 2), 100)).toBeNull();
  });
});

describe("SheetOrder", () => {
  it("names cells by id and finds them after lines move", () => {
    const order = SheetOrder.from(null, 3, 3);
    expect(order.keyAt(1, 2)).toBe("1:2");
    order.rows.apply(insert([40], 0));
    expect(order.positionOf("1:2")).toEqual({ r: 2, c: 2 });
    order.cols.apply({ kind: "delete", sheetId: "s", axis: "cols", ids: [2] });
    expect(order.positionOf("1:2")).toBeNull();
    expect(order.liveKey("1:1")).toBe(true);
    const copy = SheetOrder.from(order.toStored(), 0, 0);
    expect(copy.rows.live()).toEqual(order.rows.live());
  });

  it("parses cell keys strictly", () => {
    expect(parseCellKey(cellKey(4294967296, 3))).toEqual({ row: 4294967296, col: 3 });
    expect(parseCellKey("A1")).toBeNull();
    expect(parseCellKey("1:2:3")).toBeNull();
  });
});

describe("newLineIds", () => {
  it("gives consecutive ids above every starting line, aligned to a storage block", () => {
    const ids = newLineIds(40);
    expect(ids[0]).toBeGreaterThanOrEqual(2 ** 32);
    expect(ids[0] % 32).toBe(0);
    expect(ids[39] - ids[0]).toBe(39);
    expect(Number.isSafeInteger(ids[39])).toBe(true);
    expect(newLineIds(1)[0]).not.toBe(ids[0]);
  });
});
