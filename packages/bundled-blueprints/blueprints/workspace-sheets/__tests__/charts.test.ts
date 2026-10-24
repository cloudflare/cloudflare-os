// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chartPlacement, valueAxis } from "../files/lib/charts.ts";

describe("valueAxis", () => {
  it("steps by 1, 2, 2.5 or 5 × 10^n from zero, as Excel's automatic axis does", () => {
    expect(valueAxis(120, 2950)).toEqual({ min: 0, max: 3000, step: 500, ticks: [0, 500, 1000, 1500, 2000, 2500, 3000] });
    expect(valueAxis(0, 10).step).toBe(2);
    expect(valueAxis(0, 18).step).toBe(2.5);
    expect(valueAxis(0, 0.7).ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    expect(valueAxis(0, 1.9).ticks).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  });

  it("leaves zero out only for data clustered far from it, and spans negatives", () => {
    expect(valueAxis(1010, 1090)).toMatchObject({ min: 1010, max: 1090, step: 10 });
    expect(valueAxis(-40, 75)).toMatchObject({ min: -40, max: 80, step: 20 });
    expect(valueAxis(-300, -20)).toMatchObject({ min: -300, max: 0, step: 50 });
  });

  it("draws one value, or nothing, on an axis from zero", () => {
    expect(valueAxis(7, 7)).toMatchObject({ min: 0, max: 7, step: 1 });
    expect(valueAxis(0, 0)).toMatchObject({ min: 0, max: 1 });
    // 0.3 and 0.1 + 0.2: one value, not a range a step can't cross.
    expect(valueAxis(0.3, 0.1 + 0.2)).toMatchObject({ min: 0, max: 0.3 });
  });
});

describe("chartPlacement", () => {
  // Ten 100px columns after a 44px header; 20px rows after a 24px header.
  const sheet = { colLeft: (c: number) => 44 + c * 100, rowTop: (r: number) => 24 + r * 20, cols: 10 };

  it("puts a chart right of its data, level with the data's top row", () => {
    expect(chartPlacement({ r1: 2, c1: 0, r2: 6, c2: 2 }, sheet, 520)).toEqual({ x: 44 + 300 + 24, y: 24 + 40 });
  });

  it("puts it under the data when the columns leave no room to the right", () => {
    expect(chartPlacement({ r1: 2, c1: 4, r2: 6, c2: 7 }, sheet, 520)).toEqual({ x: 44 + 400, y: 24 + 140 + 24 });
  });

  it("steps past filled columns next to the data instead of covering them", () => {
    const filled = new Set([3]);
    expect(chartPlacement({ r1: 2, c1: 0, r2: 6, c2: 2 }, { ...sheet, occupied: (c) => filled.has(c) }, 400)).toEqual({ x: 44 + 400 + 24, y: 24 + 40 });
  });
});
