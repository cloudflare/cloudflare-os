import { describe, expect, it } from "vitest";
import {
  IDENTITY, inverse, matrixFor, multiply, placementOf, roundedPlacement, type Box, type Placement,
} from "../src/slides-geometry";

function placed(m: Parameters<typeof placementOf>[0], box: Box): Placement | undefined {
  let exact = placementOf(m, box);
  return exact && roundedPlacement(exact);
}

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
        expect(placed(matrixFor(box, placement, IDENTITY), box)).toEqual(placement);
      }
    }
  });

  it("keeps a line's scale along the axis it has no length on", () => {
    let line: Box = { x: 0, y: 0, width: 2_540_000, height: 0 };
    let current = { ...IDENTITY, d: 3 };
    let placement = { bounds: { x: 0, y: 0, width: 100, height: 0 }, rotation: 0, flipped: false };
    let m = matrixFor(line, placement, current);
    expect(m).toMatchObject({ a: 0.5, d: 3 });
    expect(placed(m, line)).toEqual(placement);
  });

  it("measures shear, which no rotation and scale can express", () => {
    let box: Box = { x: 0, y: 0, width: 100, height: 100 };
    expect(placementOf({ ...IDENTITY, a: 2, d: 0.5 }, box)?.shear).toBe(0);
    expect(placementOf({ ...IDENTITY, c: 0.5 }, box)?.shear).toBeCloseTo(0.5);
  });

  it("inverts a matrix", () => {
    let m = { a: 0.8, b: 0.6, c: -1.2, d: 1.6, tx: 1000, ty: -500 };
    let near = (value: number) => expect.closeTo(value, 9);
    expect(multiply(m, inverse(m))).toEqual(
      { a: near(1), b: near(0), c: near(0), d: near(1), tx: near(0), ty: near(0) });
  });
});
