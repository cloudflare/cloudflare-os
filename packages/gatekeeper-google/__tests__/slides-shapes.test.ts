// The preview draws each of Google Slides' shapes from an outline of its own. Google names well
// over a hundred, so this holds the preview to having one for every type a slide can report.

import { describe, expect, it } from "vitest";
import { arrowHead, shapeOutline } from "../src/previews/slides/shapes.js";
import { SHAPE_TYPES } from "../src/slides-design-input";
import { ADJUSTED_PRESETS } from "../src/slides-export";

// The types that are their box.
const BOXES = new Set(["TEXT_BOX", "RECTANGLE", "FLOW_CHART_PROCESS"]);
const SIZES = [[200, 100], [100, 200], [300, 8], [8, 300], [1, 1]];
const paths = (type: string, w: number, h: number, adjust?: unknown): string[] => {
  let { d, lines } = shapeOutline(type, w, h, adjust) as { d: string; lines?: string };
  return lines === undefined ? [d] : [d, lines];
};
/** Whether any of `drawn` is something other than a path of real numbers. */
const broken = (drawn: string[]) =>
  drawn.some(path => !/^M[\d\s.,\-MLHVCSQTAZmlhvcsqtaze]+$/.test(path) || /NaN|Infinity|undefined/.test(path));

describe("the outlines the Slides preview draws shapes from", () => {
  let box = shapeOutline("NO_SUCH_SHAPE", 200, 100).d;

  it("draws every shape type but a box's as something other than its box", () => {
    // A box with lines drawn in it, as a bevel is, is not counted.
    let boxes = [...SHAPE_TYPES].filter(type => paths(type, 200, 100).join() === box);

    expect(boxes.toSorted()).toEqual([...BOXES].toSorted());
  });

  it.each(SIZES)("draws every shape type as a path of real numbers in a box %i by %i", (w, h) => {
    expect([...SHAPE_TYPES].filter(type => broken(paths(type, w, h)))).toEqual([]);
  });

  // A freeform has no outline Google reports, and whoever draws it says so rather than guess.
  it("gives a freeform shape, and a type it has not heard of, their box", () => {
    expect(shapeOutline("CUSTOM", 200, 100)).toEqual({ d: box });
    expect(shapeOutline("constructor", 200, 100)).toEqual({ d: box });
  });

  // A preset's handles, as PowerPoint's file format numbers them: lengths in 100000ths of the
  // shape's shorter side or of a side, angles in 60000ths of a degree.
  it.each([
    ["a rounded rectangle's corners as far as its shorter side's half", "ROUND_RECTANGLE", 200, [50_000],
      "M50,0 H150 A50,50 0 0 1 200,50 V50 A50,50 0 0 1 150,100 H50 A50,50 0 0 1 0,50 V50 A50,50 0 0 1 50,0 Z"],
    ["a rounded rectangle with no rounding as its box", "ROUND_RECTANGLE", 200, [0], "M0,0 H200 V100 H0 V0 Z"],
    ["an arrow's shaft a fifth of its height and its head as long as it is tall", "RIGHT_ARROW", 200, [20_000, 100_000],
      "M0,40 L100,40 L100,0 L200,50 L100,100 L100,60 L0,60 Z"],
    ["a callout's tail out of its left side, to where the handle is", "WEDGE_RECTANGLE_CALLOUT", 200, [-70_000, 20_000],
      "M0,0 H200 V100 H0 V83.33 L-40,70 L0,58.33 V0 Z"],
    ["a callout's tail out of its top", "WEDGE_RECTANGLE_CALLOUT", 200, [20_000, -90_000],
      "M0,0 H116.67 L140,-40 L166.67,0 H200 V100 H0 V0 Z"],
    ["a quarter of a ring, a tenth of the shape thick", "BLOCK_ARC", 100, [10_800_000, 16_200_000, 10_000],
      "M0,50 A50,50 0 0 1 50,0 L50,10 A40,40 0 0 0 10,50 Z"],
    ["a quarter of a pie", "PIE", 100, [0, 5_400_000], "M100,50 A50,50 0 0 1 50,100 L50,50 Z"],
    ["a chevron's point a quarter of its height deep", "CHEVRON", 200, [25_000], "M0,0 L175,0 L200,50 L175,100 L0,100 L25,50 Z"],
  ] as const)("draws %s", (_, type, width, adjust, d) => {
    expect(shapeOutline(type, width, 100, [...adjust])).toEqual({ d });
  });

  it("draws a smiley's mouth as its handle bends it, a frown at the far end", () => {
    let mouth = (adjust?: number[]) => (shapeOutline("SMILEY_FACE", 200, 100, adjust) as { lines: string }).lines.split(" Z ").at(-1);

    expect(mouth()).toBe("M46,71.81 Q100,90.42 154,71.81");
    expect(mouth([-4653])).toBe("M46,81.11 Q100,62.5 154,81.11");
    expect(mouth([-90_000])).toBe(mouth([-4653]));
  });

  it("leads a cloud callout's bubbles to where its handle is, from the shape's middle", () => {
    let { d } = shapeOutline("CLOUD_CALLOUT", 200, 100, [50_000, 100_000]);

    // The small one is on the handle, at (200, 150); the larger a fifth of the way back.
    expect(d).toContain("M175,130 A5,5 0 1 1 185,130");
    expect(d).toContain("M196.88,150 A3.13,3.13 0 1 1 203.13,150");
  });

  it("holds a can's rim to half its height at most, as its shorter side counts it", () => {
    expect(shapeOutline("CAN", 100, 200, [100_000]).d).toBe("M0,50 A50,50 0 0 1 100,50 V150 A50,50 0 0 1 0,150 Z");
    expect(shapeOutline("CAN", 200, 100, [100_000]).d).toBe(shapeOutline("CAN", 200, 100, [50_000]).d);
  });

  it("draws each preset whose handles are read differently once a handle is moved", () => {
    let moved = [[1000, 5000, 5000, 5000], [40_000, 40_000, 40_000, 40_000], [2_000_000, 9_000_000, 40_000]];
    let unmoved = [...ADJUSTED_PRESETS.keys()].filter(type =>
      moved.every(adjust => paths(type, 200, 100, adjust).join() === paths(type, 200, 100).join()));

    expect(unmoved).toEqual([]);
  });

  // The handles are numbers out of a file: whatever they are, the outline is one that can be drawn.
  it.each([
    [[0, 0, 0, 0]], [[100_000, 100_000, 100_000, 100_000]], [[-9e9, 9e9, -9e9, 9e9]], [[21_600_000, 21_600_000, 50_000]],
    [[Number.NaN, "x", null, {}]], [[7]], ["blockArc"],
  ])("draws every preset as a path of real numbers whatever handles %j it is given", adjust => {
    expect([...ADJUSTED_PRESETS.keys()].filter(type => SIZES.some(([w, h]) => broken(paths(type, w, h, adjust))))).toEqual([]);
  });

  it.each(["FILL_ARROW", "OPEN_ARROW", "STEALTH_ARROW", "FILL_CIRCLE", "OPEN_SQUARE", "FILL_DIAMOND"])(
    "draws a %s at the end of a line as a path of real numbers", kind => {
      let head = arrowHead(kind, 9, 3);

      expect(head.d).toMatch(/^M[\d\s.,\-MLHVAZ]+$/);
      expect(head.filled).toBe(!kind.startsWith("OPEN"));
      expect(head.inset).toBeGreaterThanOrEqual(0);
    },
  );
});
