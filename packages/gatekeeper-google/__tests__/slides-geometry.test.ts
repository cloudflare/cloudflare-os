import { describe, expect, it } from "vitest";
import { matrixFor, placementOf, type Box, type Matrix } from "../src/slides-geometry";

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

describe("Slides geometry", () => {
  it("builds the matrix that reads back as the placement asked for", () => {
    let boxes: Box[] = [
      { x: 0, y: 0, width: 3_000_000, height: 1_000_000 },
      // A group's box need not start at its origin.
      { x: 500_000, y: -200_000, width: 1_270_000, height: 2_540_000 },
    ];
    let placements = [
      { bounds: { x: 72, y: 36, width: 200, height: 100 }, rotation: 0, flipped: false },
      { bounds: { x: 10.5, y: 300, width: 50, height: 400 }, rotation: 30, flipped: false },
      { bounds: { x: 0, y: 0, width: 720, height: 405 }, rotation: 270, flipped: true },
    ];
    for (let box of boxes) {
      for (let placement of placements) {
        expect(placementOf(matrixFor(box, placement, IDENTITY), box)).toEqual(placement);
      }
    }
  });

  it("keeps a line's scale along the axis it has no length on", () => {
    let line: Box = { x: 0, y: 0, width: 2_540_000, height: 0 };
    let current = { ...IDENTITY, d: 3 };
    let placement = { bounds: { x: 0, y: 0, width: 100, height: 0 }, rotation: 0, flipped: false };
    let m = matrixFor(line, placement, current);
    expect(m).toMatchObject({ a: 0.5, d: 3 });
    expect(placementOf(m, line)).toEqual(placement);
  });
});
