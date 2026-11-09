// The outlines of Google Slides' shapes, as SVG paths in a box `w` by `h` pixels. Slides' shapes
// are PowerPoint's preset geometries, so each follows its preset's formula at the default
// proportions (the provider does not report a shape's adjustment handles). A shape not here is
// drawn as its box.

type Point = readonly [number, number]

const polygon = (points: readonly Point[]) =>
  `M${points.map(([x, y]) => `${round(x)},${round(y)}`).join(' L')} Z`

const round = (value: number) => Math.round(value * 100) / 100

const ellipse = (w: number, h: number) =>
  `M0,${round(h / 2)} A${round(w / 2)},${round(h / 2)} 0 1 1 ${round(w)},${round(h / 2)} A${round(w / 2)},${round(h / 2)} 0 1 1 0,${round(h / 2)} Z`

/** A rectangle whose corners, clockwise from the top left, are rounded by the given radii. */
function roundedRect(w: number, h: number, [tl, tr, br, bl]: readonly [number, number, number, number]) {
  const arc = (r: number, x: number, y: number) => (r > 0 ? ` A${round(r)},${round(r)} 0 0 1 ${round(x)},${round(y)}` : '')
  return `M${round(tl)},0 H${round(w - tr)}${arc(tr, w, tr)} V${round(h - br)}${arc(br, w - br, h)} H${round(bl)}${arc(bl, 0, h - bl)} V${round(tl)}${arc(tl, tl, 0)} Z`
}

/** Points around the unit circle from the top, clockwise, stretched to fill the box. */
function fitted(w: number, h: number, points: Point[]) {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  return polygon(points.map(([x, y]) => [((x - minX) / (maxX - minX)) * w, ((y - minY) / (maxY - minY)) * h]))
}

const around = (count: number, radius: (i: number) => number): Point[] =>
  Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count
    return [Math.cos(angle) * radius(i), Math.sin(angle) * radius(i)]
  })

/** A star of `count` points fitted to the box, its inner points `inner` of the way out. */
const star = (w: number, h: number, count: number, inner: number) =>
  fitted(w, h, around(count * 2, i => (i % 2 === 0 ? 1 : inner)))

/** A regular polygon of `count` sides, a vertex at the top, fitted to the box. */
const regular = (w: number, h: number, count: number) => fitted(w, h, around(count, () => 1))

// A callout's tail, as PowerPoint draws it by default: its tip below the box, left of centre.
const TAIL_TIP = (w: number, h: number): Point => [w * 0.2917, h * 1.125]

/** The callout tail cut into the bottom edge of a box with corners rounded by `r`. */
function calloutRect(w: number, h: number, r: number) {
  const [tx, ty] = TAIL_TIP(w, h)
  const arc = (x: number, y: number) => (r > 0 ? ` A${round(r)},${round(r)} 0 0 1 ${round(x)},${round(y)}` : '')
  return `M${round(r)},0 H${round(w - r)}${arc(w, r)} V${round(h - r)}${arc(w - r, h)} H${round(w * 0.4167)} L${round(tx)},${round(ty)} L${round(w * 0.1667)},${round(h)} H${round(r)}${arc(0, h - r)} V${round(r)}${arc(r, 0)} Z`
}

function calloutEllipse(w: number, h: number) {
  const [rx, ry] = [w / 2, h / 2]
  const at = (degrees: number): Point => [rx + rx * Math.cos((degrees * Math.PI) / 180), ry + ry * Math.sin((degrees * Math.PI) / 180)]
  const [from, to] = [at(125), at(100)]
  const [tx, ty] = TAIL_TIP(w, h)
  return `M${round(from[0])},${round(from[1])} A${round(rx)},${round(ry)} 0 1 1 ${round(to[0])},${round(to[1])} L${round(tx)},${round(ty)} Z`
}

/** An arrow pointing right, its shaft half the box's height and its head as long as half the shorter side. */
function rightArrow(w: number, h: number): Point[] {
  const head = Math.min(w, Math.min(w, h) / 2)
  return [[0, h / 4], [w - head, h / 4], [w - head, 0], [w, h / 2], [w - head, h], [w - head, (3 * h) / 4], [0, (3 * h) / 4]]
}

const mirrorX = (points: Point[], w: number): Point[] => points.map(([x, y]) => [w - x, y])
const transpose = (points: Point[]): Point[] => points.map(([x, y]) => [y, x])

const PATHS: Record<string, (w: number, h: number, ss: number) => string> = {
  ROUND_RECTANGLE: (w, h, ss) => roundedRect(w, h, [ss / 6, ss / 6, ss / 6, ss / 6]),
  FLOWCHART_ALTERNATE_PROCESS: (w, h, ss) => roundedRect(w, h, [ss / 6, ss / 6, ss / 6, ss / 6]),
  ROUND_1_RECTANGLE: (w, h, ss) => roundedRect(w, h, [0, ss / 6, 0, 0]),
  ROUND_2_SAME_RECTANGLE: (w, h, ss) => roundedRect(w, h, [ss / 6, ss / 6, 0, 0]),
  ROUND_2_DIAGONAL_RECTANGLE: (w, h, ss) => roundedRect(w, h, [ss / 6, 0, ss / 6, 0]),
  FLOWCHART_TERMINATOR: (w, h) => roundedRect(w, h, Array(4).fill(Math.min(w, h) / 2) as [number, number, number, number]),
  SNIP_1_RECTANGLE: (w, h, ss) => polygon([[0, 0], [w - ss / 6, 0], [w, ss / 6], [w, h], [0, h]]),
  SNIP_2_SAME_RECTANGLE: (w, h, ss) => polygon([[ss / 6, 0], [w - ss / 6, 0], [w, ss / 6], [w, h], [0, h], [0, ss / 6]]),
  SNIP_2_DIAGONAL_RECTANGLE: (w, h, ss) => polygon([[0, 0], [w - ss / 6, 0], [w, ss / 6], [w, h], [ss / 6, h], [0, h - ss / 6]]),
  ELLIPSE: ellipse,
  FLOWCHART_CONNECTOR: ellipse,
  // Drawn as their outer ellipse: the face, cloud and moon details are not.
  SMILEY_FACE: ellipse,
  CLOUD: ellipse,
  TRIANGLE: (w, h) => polygon([[w / 2, 0], [w, h], [0, h]]),
  FLOWCHART_EXTRACT: (w, h) => polygon([[w / 2, 0], [w, h], [0, h]]),
  FLOWCHART_MERGE: (w, h) => polygon([[0, 0], [w, 0], [w / 2, h]]),
  RIGHT_TRIANGLE: (w, h) => polygon([[0, 0], [w, h], [0, h]]),
  DIAMOND: (w, h) => polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]),
  FLOWCHART_DECISION: (w, h) => polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]),
  PARALLELOGRAM: (w, h, ss) => polygon([[ss / 4, 0], [w, 0], [w - ss / 4, h], [0, h]]),
  FLOWCHART_INPUT_OUTPUT: (w, h) => polygon([[w / 5, 0], [w, 0], [(4 * w) / 5, h], [0, h]]),
  TRAPEZOID: (w, h, ss) => polygon([[ss / 4, 0], [w - ss / 4, 0], [w, h], [0, h]]),
  PENTAGON: (w, h) => polygon([[w / 2, 0], [w, 0.382 * h], [0.809 * w, h], [0.191 * w, h], [0, 0.382 * h]]),
  HEXAGON: (w, h, ss) => polygon([[ss / 4, 0], [w - ss / 4, 0], [w, h / 2], [w - ss / 4, h], [ss / 4, h], [0, h / 2]]),
  OCTAGON: (w, h, ss) => {
    const x = ss * 0.29289
    return polygon([[x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x], [0, x]])
  },
  HEPTAGON: (w, h) => regular(w, h, 7),
  DECAGON: (w, h) => regular(w, h, 10),
  DODECAGON: (w, h) => regular(w, h, 12),
  HOME_PLATE: (w, h, ss) => polygon([[0, 0], [w - ss / 2, 0], [w, h / 2], [w - ss / 2, h], [0, h]]),
  CHEVRON: (w, h, ss) => polygon([[0, 0], [w - ss / 2, 0], [w, h / 2], [w - ss / 2, h], [0, h], [ss / 2, h / 2]]),
  PLUS: (w, h, ss) => {
    const x = ss / 4
    return polygon([[x, 0], [w - x, 0], [w - x, x], [w, x], [w, h - x], [w - x, h - x], [w - x, h], [x, h], [x, h - x], [0, h - x], [0, x], [x, x]])
  },
  STAR_4: (w, h) => star(w, h, 4, 0.25),
  STAR_5: (w, h) => star(w, h, 5, 0.382),
  STAR_6: (w, h) => star(w, h, 6, 0.577),
  STAR_7: (w, h) => star(w, h, 7, 0.6),
  STAR_8: (w, h) => star(w, h, 8, 0.75),
  STAR_10: (w, h) => star(w, h, 10, 0.8),
  STAR_12: (w, h) => star(w, h, 12, 0.8),
  STAR_16: (w, h) => star(w, h, 16, 0.85),
  STAR_24: (w, h) => star(w, h, 24, 0.85),
  STAR_32: (w, h) => star(w, h, 32, 0.85),
  RIGHT_ARROW: (w, h) => polygon(rightArrow(w, h)),
  LEFT_ARROW: (w, h) => polygon(mirrorX(rightArrow(w, h), w)),
  DOWN_ARROW: (w, h) => polygon(transpose(rightArrow(h, w))),
  UP_ARROW: (w, h) => polygon(transpose(rightArrow(h, w)).map(([x, y]) => [x, h - y])),
  LEFT_RIGHT_ARROW: (w, h) => {
    const head = Math.min(w / 2, Math.min(w, h) / 2)
    return polygon([[0, h / 2], [head, 0], [head, h / 4], [w - head, h / 4], [w - head, 0], [w, h / 2], [w - head, h], [w - head, (3 * h) / 4], [head, (3 * h) / 4], [head, h]])
  },
  UP_DOWN_ARROW: (w, h) => {
    const head = Math.min(h / 2, Math.min(w, h) / 2)
    return polygon([[w / 2, 0], [w, head], [(3 * w) / 4, head], [(3 * w) / 4, h - head], [w, h - head], [w / 2, h], [0, h - head], [w / 4, h - head], [w / 4, head], [0, head]])
  },
  NOTCHED_RIGHT_ARROW: (w, h, ss) => {
    const points = rightArrow(w, h)
    return polygon([...points, [ss / 4, h / 2]])
  },
  DONUT: (w, h, ss) => {
    const t = ss / 4
    const inner = `M${round(t)},${round(h / 2)} A${round(w / 2 - t)},${round(h / 2 - t)} 0 1 0 ${round(w - t)},${round(h / 2)} A${round(w / 2 - t)},${round(h / 2 - t)} 0 1 0 ${round(t)},${round(h / 2)} Z`
    return `${ellipse(w, h)} ${inner}`
  },
  HEART: (w, h) =>
    `M${round(w / 2)},${round(h * 0.3)} C${round(w / 2)},0 0,0 0,${round(h * 0.3)} C0,${round(h * 0.6)} ${round(w / 2)},${round(h * 0.8)} ${round(w / 2)},${round(h)} C${round(w / 2)},${round(h * 0.8)} ${round(w)},${round(h * 0.6)} ${round(w)},${round(h * 0.3)} C${round(w)},0 ${round(w / 2)},0 ${round(w / 2)},${round(h * 0.3)} Z`,
  TEARDROP: (w, h) =>
    `M${round(w / 2)},0 H${round(w)} V${round(h / 2)} A${round(w / 2)},${round(h / 2)} 0 1 1 ${round(w / 2)},0 Z`,
  CAN: (w, h, ss) => {
    const ry = ss / 8
    return `M0,${round(ry)} A${round(w / 2)},${round(ry)} 0 0 1 ${round(w)},${round(ry)} V${round(h - ry)} A${round(w / 2)},${round(ry)} 0 0 1 0,${round(h - ry)} Z M0,${round(ry)} A${round(w / 2)},${round(ry)} 0 0 0 ${round(w)},${round(ry)}`
  },
  FLOWCHART_DOCUMENT: (w, h) =>
    `M0,0 H${round(w)} V${round(h * 0.8)} C${round(w * 0.6)},${round(h * 0.6)} ${round(w * 0.4)},${round(h * 1.12)} 0,${round(h * 0.92)} Z`,
  FLOWCHART_PREDEFINED_PROCESS: (w, h) =>
    `M0,0 H${round(w)} V${round(h)} H0 Z M${round(w / 8)},0 V${round(h)} M${round((7 * w) / 8)},0 V${round(h)}`,
  WEDGE_RECTANGLE_CALLOUT: (w, h) => calloutRect(w, h, 0),
  WEDGE_ROUND_RECTANGLE_CALLOUT: (w, h, ss) => calloutRect(w, h, ss / 6),
  WEDGE_ELLIPSE_CALLOUT: calloutEllipse,
  CLOUD_CALLOUT: calloutEllipse,
}

/** Whether `geometry` is drawn as an outline of its own, rather than as its box. */
export const knowsGeometry = (geometry: string | undefined) => geometry !== undefined && Object.hasOwn(PATHS, geometry)

/** The outline of a shape of `geometry` in a box `w` by `h` pixels; its box for one not known. */
export function geometryPath(geometry: string | undefined, w: number, h: number): string {
  const path = geometry !== undefined && Object.hasOwn(PATHS, geometry) ? PATHS[geometry] : undefined
  return path ? path(w, h, Math.min(w, h)) : polygon([[0, 0], [w, 0], [w, h], [0, h]])
}
