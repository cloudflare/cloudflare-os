/**
 * Where page elements sit on a slide, between Google's affine transforms and the boxes agents read.
 *
 * Google places an element by its `size` (its box before transforming) and a `transform` matrix
 * `[scaleX shearX translateX; shearY scaleY translateY]`, a grouped element's relative to its
 * group. Agents read the box it occupies on the slide, unrotated, and its rotation about the box's
 * centre: what the Slides editor shows. A sheared element is read as the nearest rotated box.
 */

import type { RestDimension, RestPageElement, RestTransform } from "./slides-api";
import type { SlideBounds } from "./slides-read-types";

/** EMU, Slides' unit of length, per point. */
export const EMU_PER_POINT = 12_700;

/** An affine transform `[a c tx; b d ty]`, translating in EMU. */
export type Matrix = { a: number; b: number; c: number; d: number; tx: number; ty: number };

/** A rectangle in EMU, in some element's own frame. */
export type Box = { x: number; y: number; width: number; height: number };

/** Where an element is on its slide: its unrotated box in points, and its clockwise rotation. */
export type Placement = { bounds: SlideBounds; rotation: number; flipped: boolean };

/** The transform that leaves an element where it is: a slide's frame. */
export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/** A length in EMU, whichever unit Google reported it in. */
export function emu(dimension: RestDimension | undefined): number {
  let magnitude = dimension?.magnitude ?? 0;
  return dimension?.unit === "PT" ? magnitude * EMU_PER_POINT : magnitude;
}

/** A length in points, to two decimal places. */
export function points(emuLength: number): number {
  return round(emuLength / EMU_PER_POINT);
}

function round(value: number): number {
  // `+ 0` turns -0 into 0, so a rounded-away negative reads as zero.
  return Math.round(value * 100) / 100 + 0;
}

/** The matrix of a transform. Google omits zero-valued fields, so an absent one is 0. */
export function matrixOf(transform: RestTransform): Matrix {
  let scale = transform.unit === "PT" ? EMU_PER_POINT : 1;
  return {
    a: transform.scaleX ?? 0, b: transform.shearY ?? 0,
    c: transform.shearX ?? 0, d: transform.scaleY ?? 0,
    tx: (transform.translateX ?? 0) * scale, ty: (transform.translateY ?? 0) * scale,
  };
}

/** The transform Google takes for a matrix, in EMU. */
export function transformOf(m: Matrix): Required<RestTransform> {
  return {
    scaleX: m.a, shearY: m.b, shearX: m.c, scaleY: m.d, translateX: m.tx, translateY: m.ty,
    unit: "EMU",
  };
}

/** `m · n`: the transform applying `n`, then `m`. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
    tx: m.a * n.tx + m.c * n.ty + m.tx, ty: m.b * n.tx + m.d * n.ty + m.ty,
  };
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty];
}

/**
 * An element's box in its own frame: its size, or for a group, which Google gives no size, the box
 * around its children. Undefined when Google gave too little to place it.
 */
export function localBox(element: RestPageElement): Box | undefined {
  if (element.size) {
    return { x: 0, y: 0, width: emu(element.size.width), height: emu(element.size.height) };
  }
  let children = element.elementGroup?.children;
  if (!children?.length) return undefined;
  let xs: number[] = [];
  let ys: number[] = [];
  for (let child of children) {
    let box = localBox(child);
    if (!box || !child.transform) return undefined;
    let m = matrixOf(child.transform);
    for (let [x, y] of [[box.x, box.y], [box.x + box.width, box.y],
      [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]] as const) {
      let [px, py] = apply(m, x, y);
      xs.push(px);
      ys.push(py);
    }
  }
  let x = Math.min(...xs);
  let y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Where `box`, transformed by `m`, sits on the slide, unrounded; undefined if `m` collapses it.
 * `shear` is how far `m` is from a rotated, scaled box: 0 for any element the editor makes.
 */
export function placementOf(m: Matrix, box: Box): (Placement & { shear: number }) | undefined {
  let sx = Math.hypot(m.a, m.b);
  if (sx === 0) return undefined;
  let sy = (m.a * m.d - m.b * m.c) / sx;
  let [cx, cy] = apply(m, box.x + box.width / 2, box.y + box.height / 2);
  let width = Math.abs(box.width * sx) / EMU_PER_POINT;
  let height = Math.abs(box.height * sy) / EMU_PER_POINT;
  return {
    bounds: { x: cx / EMU_PER_POINT - width / 2, y: cy / EMU_PER_POINT - height / 2, width, height },
    // Slides' y axis points down, so a positive angle turns clockwise.
    rotation: (Math.atan2(m.b, m.a) * 180 / Math.PI + 360) % 360,
    flipped: sy < 0,
    shear: sy === 0 ? 0 : Math.abs((m.a * m.c + m.b * m.d) / (sx * sy)),
  };
}

/** A placement as agents read it, to two decimal places. */
export function roundedPlacement({ bounds, rotation, flipped }: Placement): Placement {
  return {
    bounds: {
      x: round(bounds.x), y: round(bounds.y), width: round(bounds.width), height: round(bounds.height),
    },
    rotation: round(rotation) % 360,
    flipped,
  };
}

/** The matrix undoing `m`, which must not collapse. */
export function inverse(m: Matrix): Matrix {
  let det = m.a * m.d - m.b * m.c;
  let a = m.d / det;
  let b = -m.b / det;
  let c = -m.c / det;
  let d = m.a / det;
  return { a, b, c, d, tx: -(a * m.tx + c * m.ty), ty: -(b * m.tx + d * m.ty) };
}

/**
 * The matrix that puts `box` at `placement`, as `placementOf` reads it. A zero-width or zero-height
 * box (a line) keeps `current`'s scale along that axis, since no scale gives it another length.
 */
export function matrixFor(box: Box, placement: Placement, current: Matrix): Matrix {
  let { bounds, rotation, flipped } = placement;
  let currentSx = Math.hypot(current.a, current.b);
  let sx = box.width === 0 ? currentSx : bounds.width * EMU_PER_POINT / box.width;
  let sy = box.height === 0
    ? Math.abs((current.a * current.d - current.b * current.c) / (currentSx || 1))
    : bounds.height * EMU_PER_POINT / box.height;
  if (flipped) sy = -sy;
  let angle = rotation * Math.PI / 180;
  let cos = Math.cos(angle);
  let sin = Math.sin(angle);
  let m = { a: sx * cos, b: sx * sin, c: -sy * sin, d: sy * cos, tx: 0, ty: 0 };
  let centreX = (bounds.x + bounds.width / 2) * EMU_PER_POINT;
  let centreY = (bounds.y + bounds.height / 2) * EMU_PER_POINT;
  let [lx, ly] = apply(m, box.x + box.width / 2, box.y + box.height / 2);
  return { ...m, tx: centreX - lx, ty: centreY - ly };
}
