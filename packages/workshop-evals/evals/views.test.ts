import { describe, expect, it } from "vitest";
import type { SeriesMark } from "../src/view-host.js";
import { countAmount, plotsValues, showsAmount } from "./views.js";

describe("showsAmount", () => {
  it("reads an amount however it is written", () => {
    for (const text of ["420", "Food 420.00", "$420", "($420)", "Jan-420 kWh"]) {
      expect(showsAmount(text, 420), text).toBe(true);
    }
    expect(showsAmount("$1,420.50", 1420.5)).toBe(true);
  });

  it("does not read an amount inside a longer number", () => {
    for (const text of ["4200", "0.420", "1420", "420.5"]) expect(showsAmount(text, 420), text).toBe(false);
  });

  it("keeps the sign of an amount below zero", () => {
    for (const text of ["$-54.46", "-$54.46", "−54.46", "Each: -54.46"]) {
      expect(showsAmount(text, 54.46), text).toBe(false);
      expect(showsAmount(text, -54.46), text).toBe(true);
    }
    expect(showsAmount("- $54.46", 54.46)).toBe(true);
    expect(showsAmount("5-10 people", 10)).toBe(true);
  });

  it("reads an amount run into the percentage after it", () => {
    expect(showsAmount("Food $420.0060%", 420)).toBe(true);
    expect(showsAmount("Food $420.0060.5%", 420)).toBe(true);
    expect(showsAmount("Food 420.0060", 420)).toBe(false);
  });
});

describe("countAmount", () => {
  it("counts each time an amount is shown", () => {
    expect(countAmount("Four: $54.46. Five: $43.57. Each $43.57", 43.57)).toBe(2);
    expect(countAmount("Each $-43.57", 43.57)).toBe(0);
  });
});

const VALUES = [410, 380, 610, 290];
// A mark in each label's column, with its top at `at`.
const column = (at: readonly number[], key = "rect 0"): SeriesMark[] =>
  at.map((top, label) => ({ label, key, axis: "y", at: top }));

describe("plotsValues", () => {
  it("passes marks drawn to a straight scale, whatever the scale's origin", () => {
    expect(plotsValues(column(VALUES.map(value => 200 - value / 4)), VALUES)).toBe(true);
    expect(plotsValues(column(VALUES.map(value => 200 - (value - 250) / 2)), VALUES)).toBe(true);
    const rows = VALUES.map((value, label): SeriesMark => ({ label, key: "div 0", axis: "x", at: 40 + value / 3 }));
    expect(plotsValues(rows, VALUES)).toBe(true);
  });

  it("finds the series among other marks", () => {
    const grid = column([20, 20, 20, 20], "line 0");
    expect(plotsValues([...grid, ...column(VALUES.map(value => 200 - value / 4), "rect 1")], VALUES)).toBe(true);
  });

  it("fails marks out of order, upside down, flat or missing a label", () => {
    expect(plotsValues(column([410, 610, 380, 290].map(value => 200 - value / 4)), VALUES)).toBe(false);
    expect(plotsValues(column(VALUES.map(value => value / 4)), VALUES)).toBe(false);
    expect(plotsValues(column(VALUES.map(value => 200 - value / 100)), VALUES)).toBe(false);
    expect(plotsValues(column(VALUES.map(value => 200 - value / 4)).slice(1), VALUES)).toBe(false);
  });
});
