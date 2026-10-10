import { describe, expect, it } from "vitest";
import {
  baseIndexOf, baseLines, basePieces, deleteLines, insertLines, lineAt, lineCount, linesAt,
  positionOf, type Lines,
} from "../src/sheets-structure";

/** Every line's identity, in order. */
const identities = (lines: Lines) => linesAt(lines, 0, lineCount(lines));

describe("Sheets rows and columns as runs", () => {
  let ten = baseLines(10);

  it("names the lines Google holds by their index there", () => {
    expect(identities(baseLines(3))).toEqual(["b0", "b1", "b2"]);
    expect(baseLines(0)).toEqual([]);
    expect(lineAt(ten, 10)).toBeUndefined();
    expect(lineAt(ten, -1)).toBeUndefined();
    expect(baseIndexOf("b7")).toBe(7);
    expect(baseIndexOf("n3.0")).toBeUndefined();
  });

  it("inserts at the start, in the middle and at the end", () => {
    expect(identities(insertLines(baseLines(3), 0, 2, 4))).toEqual(["n4.0", "n4.1", "b0", "b1", "b2"]);
    expect(identities(insertLines(baseLines(3), 1, 1, 4))).toEqual(["b0", "n4.0", "b1", "b2"]);
    expect(identities(insertLines(baseLines(3), 3, 2, 4))).toEqual(["b0", "b1", "b2", "n4.0", "n4.1"]);
    expect(identities(insertLines([], 0, 2, 0))).toEqual(["n0.0", "n0.1"]);
    // Past the end adds at the end.
    expect(identities(insertLines(baseLines(2), 9, 1, 4))).toEqual(["b0", "b1", "n4.0"]);
  });

  it("deletes at the start, in the middle and at the end", () => {
    expect(identities(deleteLines(baseLines(5), 0, 2))).toEqual(["b2", "b3", "b4"]);
    expect(identities(deleteLines(baseLines(5), 1, 3))).toEqual(["b0", "b4"]);
    expect(identities(deleteLines(baseLines(5), 3, 2))).toEqual(["b0", "b1", "b2"]);
    expect(lineCount(deleteLines(ten, 0, 10))).toBe(0);
  });

  it("deletes across several runs, keeping what is left of each", () => {
    let mixed = insertLines(insertLines(ten, 2, 3, 1), 8, 2, 2);
    expect(identities(mixed)).toEqual([
      "b0", "b1", "n1.0", "n1.1", "n1.2", "b2", "b3", "b4", "n2.0", "n2.1", "b5", "b6", "b7", "b8", "b9",
    ]);
    let cut = deleteLines(mixed, 3, 7);
    expect(identities(cut)).toEqual(["b0", "b1", "n1.0", "b5", "b6", "b7", "b8", "b9"]);
    // A run cut in two keeps the identities of the lines left on either side.
    expect(identities(deleteLines(insertLines(baseLines(2), 1, 4, 3), 2, 2)))
      .toEqual(["b0", "n3.0", "n3.3", "b1"]);
  });

  it("rejoins runs a deletion makes continuous again", () => {
    let split = insertLines(ten, 4, 2, 1);
    expect(split).toHaveLength(3);
    expect(deleteLines(split, 4, 2)).toEqual(ten);
    let inserted = insertLines(baseLines(1), 1, 4, 2);
    expect(deleteLines(insertLines(inserted, 3, 1, 5), 3, 1)).toEqual(inserted);
  });

  it("keeps each line's identity as lines move around it", () => {
    let lines = ten;
    let watched = ["b0", "b5", "b9"];
    let positions = () => watched.map(identity => positionOf(lines, identity));
    lines = insertLines(lines, 3, 4, 1);
    expect(positions()).toEqual([0, 9, 13]);
    let added = lineAt(lines, 4)!;
    expect(added).toBe("n1.1");
    lines = deleteLines(lines, 0, 2);
    expect(positions()).toEqual([undefined, 7, 11]);
    expect(positionOf(lines, added)).toBe(2);
    lines = insertLines(lines, 0, 1, 2);
    expect(positionOf(lines, added)).toBe(3);
    expect(positionOf(lines, "b1")).toBeUndefined();
    expect(positionOf(lines, "n9.0")).toBeUndefined();
    expect(positionOf(lines, "x1")).toBeUndefined();
    // Every identity is at the position that names it.
    for (let [position, identity] of identities(lines).entries()) {
      expect(positionOf(lines, identity!)).toBe(position);
    }
  });

  it("splits a range into the runs of lines Google holds that it covers", () => {
    let lines = deleteLines(insertLines(ten, 3, 2, 1), 7, 2);
    expect(identities(lines)).toEqual(["b0", "b1", "b2", "n1.0", "n1.1", "b3", "b4", "b7", "b8", "b9"]);
    expect(basePieces(lines, 0, 10)).toEqual([
      { start: 0, length: 3 }, { start: 3, length: 2 }, { start: 7, length: 3 },
    ]);
    expect(basePieces(lines, 1, 6)).toEqual([{ start: 1, length: 2 }, { start: 3, length: 1 }]);
    // Inserted lines are fetched from nowhere.
    expect(basePieces(lines, 3, 5)).toEqual([]);
    expect(basePieces(lines, 8, 9)).toEqual([{ start: 8, length: 1 }]);
    expect(basePieces(lines, 9, 30)).toEqual([{ start: 9, length: 1 }]);
  });
});
