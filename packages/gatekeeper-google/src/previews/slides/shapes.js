// The outlines of Google Slides' shapes, as SVG paths in a box `w` by `h`. Slides' shapes are the
// preset shapes of office documents. Each is drawn as it is before anyone drags its handles, and
// the ones whose handles change them most (corners, arcs, arrows, callouts, stars and the like)
// follow `adjust`, the shape's handles as an office document holds them, where the session gives
// it. A freeform shape is not drawn from here.

// A handle, which office documents count in 100,000ths, of the box's shorter side mostly, or in
// 60,000ths of a degree when it is an angle.
const handle = (adjust, at, fallback, unit = 100000) => Number.isFinite(adjust?.[at]) ? adjust[at] / unit : fallback;
// A handle held between nothing and `most`, as Slides holds it.
const part = (adjust, at, fallback, most = 1) => Math.min(Math.max(most, 0), Math.max(0, handle(adjust, at, fallback)));

const n = value => Math.round(value * 100) / 100;
// A path written out, with its numbers rounded.
const d = (strings, ...values) => String.raw({ raw: strings }, ...values.map(value => typeof value === 'number' ? n(value) : value));
const polygon = points => `M${points.map(([x, y]) => `${n(x)},${n(y)}`).join(' L')} Z`;
const box = (w, h) => polygon([[0, 0], [w, 0], [w, h], [0, h]]);
// Points given as fractions of the box.
const within = (w, h, points) => polygon(points.map(([x, y]) => [x * w, y * h]));
// A shape that is the same points in any box.
const fixed = points => (w, h) => within(w, h, points);
// Points on Slides' own grid for a shape, 21600 units each way.
const plotted = points => fixed(points.map(([x, y]) => [x / 21600, y / 21600]));

// Drawn clockwise, or with `turn` 0 the other way round, which cuts a hole in what is drawn around it.
const oval = (cx, cy, rx, ry, turn = 1) =>
  d`M${cx - rx},${cy} A${rx},${ry} 0 1 ${turn} ${cx + rx},${cy} A${rx},${ry} 0 1 ${turn} ${cx - rx},${cy} Z`;
const ellipse = (w, h) => oval(w / 2, h / 2, w / 2, h / 2);
// Where an ellipse filling the box is, `degrees` clockwise from its rightmost point.
const around = (w, h, degrees, reach = 1) => {
  const angle = degrees * Math.PI / 180;
  return [w / 2 * (1 + reach * Math.cos(angle)), h / 2 * (1 + reach * Math.sin(angle))];
};

// A corner rounded clockwise to a point, if it is rounded at all.
const turned = (r, x, y) => r > 0 ? d` A${r},${r} 0 0 1 ${x},${y}` : '';
// A rectangle whose corners, clockwise from the top left, are rounded by the radii given.
const rounded = (w, h, [tl, tr, br, bl]) =>
  d`M${tl},0 H${w - tr}${turned(tr, w, tr)} V${h - br}${turned(br, w - br, h)} H${bl}${turned(bl, 0, h - bl)} V${tl}${turned(tl, tl, 0)} Z`;
// The same with its corners cut.
const snipped = (w, h, [tl, tr, br, bl]) =>
  polygon([[tl, 0], [w - tr, 0], [w, tr], [w, h - br], [w - br, h], [bl, h], [0, h - bl], [0, tl]]);

// Points around a circle from the top, clockwise, stretched to fill the box.
function fitted(w, h, count, radius) {
  const points = Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / count;
    return [Math.cos(angle) * radius(i), Math.sin(angle) * radius(i)];
  });
  const [xs, ys] = [points.map(([x]) => x), points.map(([, y]) => y)];
  const [left, top] = [Math.min(...xs), Math.min(...ys)];
  return polygon(points.map(([x, y]) =>
    [(x - left) / (Math.max(...xs) - left) * w, (y - top) / (Math.max(...ys) - top) * h]));
}
// A star's handle is how far in its inner points are: half of it is the whole of the way out.
const star = (count, inner) => (w, h, s, a) => fitted(w, h, count * 2, i => i % 2 ? 2 * part(a, 0, inner / 2, .5) : 1);
const regular = count => (w, h) => fitted(w, h, count, () => 1);

// A shape drawn pointing right serves for the other three ways it can point: each way says the box
// to draw it in, and where a point of that drawing goes.
const FACING = {
  RIGHT: { size: (w, h) => [w, h], at: () => point => point },
  LEFT: { size: (w, h) => [w, h], at: w => ([x, y]) => [w - x, y] },
  DOWN: { size: (w, h) => [h, w], at: () => ([x, y]) => [y, x] },
  UP: { size: (w, h) => [h, w], at: (w, h) => ([x, y]) => [y, h - x] },
};
// `draw` returns steps, each a letter of an SVG path and the points it takes.
const facing = (side, draw) => (w, h, s, a) => {
  const at = FACING[side].at(w, h);
  return draw(...FACING[side].size(w, h), a)
    .map(([letter, ...points]) => letter + points.map(point => at(point).map(n).join(',')).join(' ')).join(' ');
};
const closed = points => [['M', points[0]], ...points.slice(1).map(point => ['L', point]), ['Z']];

// An arrow pointing right: its shaft half the box's height and its head half the shorter side
// long, until its handles say otherwise.
function rightArrow(w, h, a) {
  const s = Math.min(w, h) || 1;
  const [head, half] = [s * part(a, 1, .5, w / s), h * part(a, 0, .5) / 2];
  return [[0, h / 2 - half], [w - head, h / 2 - half], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h / 2 + half], [0, h / 2 + half]];
}
const arrow = side => facing(side, (w, h, a) => closed(rightArrow(w, h, a)));

// A band that swings out to the left and comes back as an arrow pointing right.
const curvedArrow = side => facing(side, (w, h) => {
  const head = w - Math.min(w, h) / 4;
  return [
    ['M', [w, 0]], ['C', [-w / 3, 0], [-w / 3, .89 * h], [head, .89 * h]], ['L', [head, h]], ['L', [w, .78 * h]],
    ['L', [head, .56 * h]], ['L', [head, .67 * h]], ['C', [.2 * w, .67 * h], [.2 * w, .22 * h], [w, .22 * h]], ['Z'],
  ];
});

// A box with an arrow out of its right side.
const arrowCallout = side => facing(side, (w, h) => {
  const s = Math.min(w, h);
  const [body, head, half, shaft, cy] = [.65 * w, w - s / 4, s / 4, s / 8, h / 2];
  return closed([[0, 0], [body, 0], [body, cy - shaft], [head, cy - shaft], [head, cy - half], [w, cy],
    [head, cy + half], [head, cy + shaft], [body, cy + shaft], [body, h], [0, h]]);
});

// A sheet rolled up at two of its corners, lying sideways.
const scroll = side => facing(side, (w, h) => {
  const r = Math.min(w, h) / 8;
  return [
    ['M', [0, 1.5 * r]], ['Q', [0, r], [r / 2, r]], ['L', [w - r, r]], ['L', [w - r, r / 2]], ['Q', [w - r, 0], [w - r / 2, 0]],
    ['Q', [w, 0], [w, r / 2]], ['L', [w, h - 1.5 * r]], ['Q', [w, h - r], [w - r / 2, h - r]], ['L', [r, h - r]],
    ['L', [r, h - r / 2]], ['Q', [r, h], [r / 2, h]], ['Q', [0, h], [0, h - r / 2]], ['Z'],
    ['M', [w - r, r]], ['L', [w - r / 2, r]], ['Q', [w, r], [w, r / 2]], ['M', [r, h - r]], ['L', [r, 1.5 * r]],
  ];
});

// Where a speech bubble's tail points, from the middle of its box: below it and left of centre
// until someone drags it.
const tailOf = (w, h, a) => [w * handle(a, 0, -.20833), h * handle(a, 1, .625)];

// A box with a tail, which leaves the side its tip is nearest, from the half of that side it is on.
function callout(w, h, r, a) {
  const [dx, dy] = tailOf(w, h, a);
  const side = Math.abs(dy) * w > Math.abs(dx) * h ? (dy < 0 ? 'top' : 'bottom') : (dx < 0 ? 'left' : 'right');
  const base = (toward, length) => (toward > 0 ? [7, 10] : [2, 5]).map(twelfth => n(length * twelfth / 12));
  const [[x1, x2], [y1, y2]] = [base(dx, w), base(dy, h)];
  const tip = `L${n(w / 2 + dx)},${n(h / 2 + dy)}`;
  const tail = { top: ` H${x1} ${tip} L${x2},0`, right: ` V${y1} ${tip} L${n(w)},${y2}`,
    bottom: ` H${x2} ${tip} L${x1},${n(h)}`, left: ` V${y2} ${tip} L0,${y1}` };
  const on = at => at === side ? tail[at] : '';
  return d`M${r},0${on('top')} H${w - r}${turned(r, w, r)}${on('right')} V${h - r}${turned(r, w - r, h)}${on('bottom')}` +
    d` H${r}${turned(r, 0, h - r)}${on('left')} V${r}${turned(r, r, 0)} Z`;
}

// Where the ellipse `rx` by `ry` about the box's middle is, `degrees` clockwise from its rightmost
// point as the angle looks, which is how Slides counts an arc's angles.
function seen(w, h, degrees, rx = w / 2, ry = h / 2) {
  const turn = degrees * Math.PI / 180;
  const along = Math.atan2(rx * Math.sin(turn), ry * Math.cos(turn));
  return [w / 2 + rx * Math.cos(along), h / 2 + ry * Math.sin(along)];
}
// The arc of that ellipse from the angle `from` round by `sweep` degrees, anticlockwise if negative:
// in pieces short enough that each is the lesser way round between its ends.
function arcOf(w, h, from, sweep, rx = w / 2, ry = h / 2) {
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / 120));
  return Array.from({ length: pieces }, (_, i) => {
    const [x, y] = seen(w, h, from + sweep * (i + 1) / pieces, rx, ry);
    return `A${n(rx)},${n(ry)} 0 0 ${sweep > 0 ? 1 : 0} ${n(x)},${n(y)}`;
  }).join(' ');
}
// The arc an arc's two handles make, from the first clockwise to the second, and all the way round
// when they are one: its path, where it starts and how far round it goes.
function sweptArc(w, h, a, first, last) {
  const from = handle(a, 0, first, 60000);
  const sweep = ((handle(a, 1, last, 60000) - from) % 360 + 360) % 360 || 360;
  return { arc: `M${seen(w, h, from).map(n).join(',')} ${arcOf(w, h, from, sweep)}`, from, sweep };
}
// An arc closed through the middle of its box.
const slice = (w, h, arc) => d`${arc} L${w / 2},${h / 2} Z`;
// A path that is only ever outlined, closed to be filled.
const unclosed = lines => ({ d: `${lines} Z`, open: true, lines });

const CLOUD = [[.09, .6], [-.03, .55, -.02, .33, .1, .32], [.08, .14, .27, .07, .36, .16], [.42, .02, .6, .02, .65, .13],
  [.74, .03, .91, .1, .88, .27], [1.02, .32, 1.02, .56, .9, .62], [.95, .8, .78, .9, .68, .82],
  [.62, .98, .42, .98, .37, .86], [.25, .95, .08, .85, .12, .72], [.05, .71, .04, .63, .09, .6]];
const cloud = (w, h) => `${CLOUD.map((step, i) => (i ? 'C' : 'M') + step.map((value, at) => n(value * (at % 2 ? h : w))).join(',')).join(' ')} Z`;

const diamond = fixed([[.5, 0], [1, .5], [.5, 1], [0, .5]]);
const merge = fixed([[0, 0], [1, 0], [.5, 1]]);
// How far a corner is cut or rounded: a sixth of the shorter side, or as far as handle `at` says.
const corner = (s, a, at = 0, fallback = 1 / 6) => s * part(a, at, fallback, .5);
// A rectangle whose corners, clockwise from the top left, each follow the handle `order` names
// for it, which is at `fallbacks` until it is dragged.
const cornered = (shape, order, fallbacks = []) => (w, h, s, a) =>
  shape(w, h, order.map(at => corner(s, a, at, fallbacks[at])));
const roundRectangle = cornered(rounded, [0, 0, 0, 0]);
const roundCallout = (w, h, s, a) => callout(w, h, corner(s, a, 2), a);
// A bar across the middle, as the signs of arithmetic have: its ends and its edges.
const bar = (w, h) => [.1325 * w, .8675 * w, h / 2 - .1176 * h, h / 2 + .1176 * h];
// A banner with a notch cut from each end, its middle panel standing forward.
const ribbon = (w, h, flip) => within(w, h, [[0, 0], [.3, 0], [.3, 1 / 6], [.7, 1 / 6], [.7, 0], [1, 0], [.875, 5 / 12],
  [1, 5 / 6], [.75, 5 / 6], [.75, 1], [.25, 1], [.25, 5 / 6], [0, 5 / 6], [.125, 5 / 12]].map(([x, y]) => [x, flip ? 1 - y : y]));
const curvedRibbon = (w, h, flip) => {
  const y = value => flip ? h - value : value;
  return d`M0,${y(0)} Q${w / 2},${y(h / 2)} ${w},${y(0)} L${.875 * w},${y(3 * h / 8)} L${w},${y(3 * h / 4)}` +
    d` Q${w / 2},${y(1.25 * h)} 0,${y(3 * h / 4)} L${w / 8},${y(3 * h / 8)} Z`;
};
// A right bracket and a right brace, or with `left` their mirror images, whose arcs turn the other way.
const bracket = left => (w, h, s) => {
  const [near, far, turn] = left ? [w, 0, 0] : [0, w, 1];
  return unclosed(d`M${near},0 A${w},${s / 12} 0 0 ${turn} ${far},${s / 12} V${h - s / 12} A${w},${s / 12} 0 0 ${turn} ${near},${h}`);
};
const brace = left => (w, h, s) => {
  const [r, cx, cy] = [s / 12, w / 2, h / 2];
  const [near, far, turn] = left ? [w, 0, 0] : [0, w, 1];
  return unclosed(d`M${near},0 A${cx},${r} 0 0 ${turn} ${cx},${r} V${cy - r} A${cx},${r} 0 0 ${1 - turn} ${far},${cy}` +
    d` A${cx},${r} 0 0 ${1 - turn} ${cx},${cy + r} V${h - r} A${cx},${r} 0 0 ${turn} ${near},${h}`);
};
// A drum standing up: its top is an ellipse `ry` deep, whose near edge shows.
const can = (w, h, ry) => ({
  d: d`M0,${ry} A${w / 2},${ry} 0 0 1 ${w},${ry} V${h - ry} A${w / 2},${ry} 0 0 1 0,${h - ry} Z`,
  lines: d`M0,${ry} A${w / 2},${ry} 0 0 0 ${w},${ry}`,
});

// Each takes the box's width and height, and its shorter side, and returns the path that is filled
// and outlined. One that returns an object adds `lines`, which are only ever outlined, and says
// with `open` that its `d` is only ever filled.
const PATHS = {
  TEXT_BOX: box,
  RECTANGLE: box,
  FLOW_CHART_PROCESS: box,
  ELLIPSE: ellipse,
  FLOW_CHART_CONNECTOR: ellipse,
  ROUND_RECTANGLE: roundRectangle,
  FLOW_CHART_ALTERNATE_PROCESS: roundRectangle,
  FLOW_CHART_TERMINATOR: (w, h, s) => rounded(w, h, Array(4).fill(s / 2)),
  ROUND_1_RECTANGLE: (w, h, s, a) => rounded(w, h, [0, corner(s, a), 0, 0]),
  // The first handle is the top two corners, or the top left and bottom right; the second the others.
  ROUND_2_SAME_RECTANGLE: cornered(rounded, [0, 0, 1, 1], [1 / 6, 0]),
  ROUND_2_DIAGONAL_RECTANGLE: cornered(rounded, [0, 1, 0, 1], [1 / 6, 0]),
  SNIP_1_RECTANGLE: (w, h, s, a) => polygon([[0, 0], [w - corner(s, a), 0], [w, corner(s, a)], [w, h], [0, h]]),
  SNIP_2_SAME_RECTANGLE: cornered(snipped, [0, 0, 1, 1], [1 / 6, 0]),
  SNIP_2_DIAGONAL_RECTANGLE: cornered(snipped, [0, 1, 0, 1], [0, 1 / 6]),
  SNIP_ROUND_RECTANGLE: (w, h, s, a) => {
    const [r, c] = [corner(s, a), corner(s, a, 1)];
    return d`M${r},0 H${w - c} L${w},${c} V${h} H0 V${r}${turned(r, r, 0)} Z`;
  },
  PLAQUE: (w, h, s, a) => {
    const r = corner(s, a);
    return d`M${r},0 H${w - r} A${r},${r} 0 0 0 ${w},${r} V${h - r} A${r},${r} 0 0 0 ${w - r},${h}` +
      d` H${r} A${r},${r} 0 0 0 0,${h - r} V${r} A${r},${r} 0 0 0 ${r},0 Z`;
  },
  TRIANGLE: (w, h, s, a) => polygon([[w * part(a, 0, .5), 0], [w, h], [0, h]]),
  FLOW_CHART_EXTRACT: fixed([[.5, 0], [1, 1], [0, 1]]),
  FLOW_CHART_MERGE: merge,
  FLOW_CHART_OFFLINE_STORAGE: (w, h) => ({ d: merge(w, h), lines: d`M${.4 * w},${.8 * h} H${.6 * w}` }),
  RIGHT_TRIANGLE: fixed([[0, 0], [1, 1], [0, 1]]),
  DIAMOND: diamond,
  FLOW_CHART_DECISION: diamond,
  FLOW_CHART_SORT: (w, h) => ({ d: diamond(w, h), lines: d`M0,${h / 2} H${w}` }),
  FLOW_CHART_COLLATE: fixed([[0, 0], [1, 0], [0, 1], [1, 1]]),
  PARALLELOGRAM: (w, h, s, a) => {
    const lean = s * part(a, 0, .25, w / s);
    return polygon([[lean, 0], [w, 0], [w - lean, h], [0, h]]);
  },
  FLOW_CHART_INPUT_OUTPUT: fixed([[.2, 0], [1, 0], [.8, 1], [0, 1]]),
  FLOW_CHART_MANUAL_INPUT: fixed([[0, .2], [1, 0], [1, 1], [0, 1]]),
  FLOW_CHART_MANUAL_OPERATION: fixed([[0, 0], [1, 0], [.8, 1], [.2, 1]]),
  FLOW_CHART_OFFPAGE_CONNECTOR: fixed([[0, 0], [1, 0], [1, .8], [.5, 1], [0, .8]]),
  FLOW_CHART_PUNCHED_CARD: fixed([[.2, 0], [1, 0], [1, 1], [0, 1], [0, .2]]),
  FLOW_CHART_PREPARATION: fixed([[0, .5], [.2, 0], [.8, 0], [1, .5], [.8, 1], [.2, 1]]),
  FLOW_CHART_PREDEFINED_PROCESS: (w, h) => ({ d: box(w, h), lines: d`M${w / 8},0 V${h} M${7 * w / 8},0 V${h}` }),
  FLOW_CHART_INTERNAL_STORAGE: (w, h) => ({ d: box(w, h), lines: d`M${w / 8},0 V${h} M0,${h / 8} H${w}` }),
  FLOW_CHART_DOCUMENT: (w, h) =>
    d`M0,0 H${w} V${h * .8} C${w * .6},${h * .6} ${w * .4},${h * 1.12} 0,${h * .92} Z`,
  FLOW_CHART_MULTIDOCUMENT: (w, h) => ({
    d: d`M0,${.17 * h} H${.86 * w} V${.83 * h} C${.52 * w},${.66 * h} ${.34 * w},${1.1 * h} 0,${.93 * h} Z`,
    lines: d`M${.07 * w},${.17 * h} V${.085 * h} H${.93 * w} V${.74 * h} M${.14 * w},${.085 * h} V0 H${w} V${.66 * h}`,
  }),
  FLOW_CHART_PUNCHED_TAPE: (w, h) =>
    d`M0,${h / 10} Q${w / 4},${3 * h / 10} ${w / 2},${h / 10} T${w},${h / 10} V${.9 * h}` +
    d` Q${.75 * w},${.7 * h} ${w / 2},${.9 * h} T0,${.9 * h} Z`,
  FLOW_CHART_SUMMING_JUNCTION: (w, h) => ({
    d: ellipse(w, h),
    lines: [[225, 45], [315, 135]].map(ends => `M${ends.map(angle => around(w, h, angle).map(n).join(',')).join(' L')}`).join(' '),
  }),
  FLOW_CHART_OR: (w, h) => ({ d: ellipse(w, h), lines: d`M${w / 2},0 V${h} M0,${h / 2} H${w}` }),
  FLOW_CHART_ONLINE_STORAGE: (w, h) =>
    d`M${w / 6},0 H${w} A${w / 6},${h / 2} 0 0 0 ${w},${h} H${w / 6} A${w / 6},${h / 2} 0 0 1 ${w / 6},0 Z`,
  FLOW_CHART_DELAY: (w, h) => d`M0,0 H${w / 2} A${w / 2},${h / 2} 0 0 1 ${w / 2},${h} H0 Z`,
  FLOW_CHART_DISPLAY: (w, h) =>
    d`M0,${h / 2} L${w / 6},0 H${5 * w / 6} A${w / 6},${h / 2} 0 0 1 ${5 * w / 6},${h} H${w / 6} Z`,
  FLOW_CHART_MAGNETIC_TAPE: (w, h) => {
    const [x, y] = around(w, h, 45);
    return d`M${w / 2},${h} A${w / 2},${h / 2} 0 1 1 ${x},${y} H${w} V${h} Z`;
  },
  FLOW_CHART_MAGNETIC_DISK: (w, h) => can(w, h, h / 6),
  FLOW_CHART_MAGNETIC_DRUM: (w, h) => ({
    d: d`M${w / 6},0 H${5 * w / 6} A${w / 6},${h / 2} 0 0 1 ${5 * w / 6},${h} H${w / 6} A${w / 6},${h / 2} 0 0 1 ${w / 6},0 Z`,
    lines: d`M${5 * w / 6},0 A${w / 6},${h / 2} 0 0 0 ${5 * w / 6},${h}`,
  }),
  CAN: (w, h, s, a) => can(w, h, s * part(a, 0, .25, h / s / 2) / 2),
  TRAPEZOID: (w, h, s, a) => {
    const lean = s * part(a, 0, .25, w / s / 2);
    return polygon([[lean, 0], [w - lean, 0], [w, h], [0, h]]);
  },
  PENTAGON: fixed([[.5, 0], [1, .382], [.809, 1], [.191, 1], [0, .382]]),
  HEXAGON: (w, h, s, a) => {
    const x = s * part(a, 0, .25, w / s / 2);
    return polygon([[x, 0], [w - x, 0], [w, h / 2], [w - x, h], [x, h], [0, h / 2]]);
  },
  HEPTAGON: regular(7),
  OCTAGON: (w, h, s, a) => {
    const x = s * part(a, 0, .2929, .5);
    return polygon([[x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x], [0, x]]);
  },
  DECAGON: regular(10),
  DODECAGON: regular(12),
  HOME_PLATE: (w, h, s, a) => {
    const point = s * part(a, 0, .5, w / s);
    return polygon([[0, 0], [w - point, 0], [w, h / 2], [w - point, h], [0, h]]);
  },
  CHEVRON: (w, h, s, a) => {
    const point = s * part(a, 0, .5, w / s);
    return polygon([[0, 0], [w - point, 0], [w, h / 2], [w - point, h], [0, h], [point, h / 2]]);
  },
  PLUS: (w, h, s, a) => {
    const x = s * part(a, 0, .25, .5);
    return polygon([[x, 0], [w - x, 0], [w - x, x], [w, x], [w, h - x], [w - x, h - x], [w - x, h],
      [x, h], [x, h - x], [0, h - x], [0, x], [x, x]]);
  },
  CORNER: (w, h, s) => polygon([[0, 0], [s / 2, 0], [s / 2, h - s / 2], [w, h - s / 2], [w, h], [0, h]]),
  DIAGONAL_STRIPE: fixed([[0, .5], [.5, 0], [1, 0], [0, 1]]),
  FRAME: (w, h, s, a) => {
    const t = s * part(a, 0, .125, .5);
    return `${box(w, h)} ${polygon([[t, t], [t, h - t], [w - t, h - t], [w - t, t]])}`;
  },
  HALF_FRAME: (w, h, s) => {
    const t = s / 3;
    return polygon([[0, 0], [w, 0], [w - t * w / h, t], [t, t], [t, h - t * h / w], [0, h]]);
  },
  BEVEL: (w, h, s, a) => {
    const t = s * part(a, 0, .125, .5);
    return {
      d: box(w, h),
      lines: `${polygon([[t, t], [w - t, t], [w - t, h - t], [t, h - t]])}` +
        d` M0,0 L${t},${t} M${w},0 L${w - t},${t} M${w},${h} L${w - t},${h - t} M0,${h} L${t},${h - t}`,
    };
  },
  CUBE: (w, h, s, a) => {
    const depth = s * part(a, 0, .25);
    return {
      d: polygon([[0, depth], [depth, 0], [w, 0], [w, h - depth], [w - depth, h], [0, h]]),
      lines: d`M0,${depth} H${w - depth} V${h} M${w - depth},${depth} L${w},0`,
    };
  },
  FOLDED_CORNER: (w, h, s, a) => {
    const fold = corner(s, a);
    return {
      d: polygon([[0, 0], [w, 0], [w, h - fold], [w - fold, h], [0, h]]),
      lines: d`M${w - fold},${h} L${w - .8 * fold},${h - .8 * fold} L${w},${h - fold}`,
    };
  },
  STAR_4: star(4, .25), STAR_5: star(5, .382), STAR_6: star(6, .577), STAR_7: star(7, .692),
  STAR_8: star(8, .75), STAR_10: star(10, .851), STAR_12: star(12, .75), STAR_16: star(16, .75),
  STAR_24: star(24, .75), STAR_32: star(32, .75),
  IRREGULAR_SEAL_1: plotted([[10800, 5800], [14522, 0], [14155, 5325], [18380, 4457], [16702, 7315],
    [21097, 8137], [17607, 10475], [21600, 13290], [16837, 12942], [18145, 18095], [14020, 14457], [13247, 19737],
    [10532, 14935], [8485, 21600], [7715, 15627], [4762, 17617], [5667, 13937], [135, 14587], [3722, 11775],
    [0, 8615], [4627, 7617], [370, 2295], [7312, 6320], [8352, 2295]]),
  IRREGULAR_SEAL_2: plotted([[11462, 4342], [14790, 0], [14525, 5777], [18007, 3172], [16380, 6532],
    [21600, 6645], [16985, 9402], [18270, 11290], [16380, 12310], [18877, 15632], [14640, 14350], [14942, 17370],
    [12180, 15935], [11612, 18842], [9872, 17370], [8700, 19712], [7527, 18125], [4917, 21600], [4805, 18240],
    [1285, 17825], [3330, 15370], [0, 12877], [3935, 11592], [1172, 8270], [5372, 7817], [4502, 3625], [8550, 6382],
    [9722, 1887]]),
  LIGHTNING_BOLT: plotted([[8472, 0], [12860, 6080], [11050, 6797], [16577, 12007], [14767, 12877],
    [21600, 21600], [10012, 14915], [12222, 13987], [5022, 9705], [7602, 8382], [0, 3890]]),
  RIGHT_ARROW: arrow('RIGHT'), LEFT_ARROW: arrow('LEFT'), DOWN_ARROW: arrow('DOWN'), UP_ARROW: arrow('UP'),
  ARROW_EAST: arrow('RIGHT'), ARROW_NORTH: arrow('UP'),
  ARROW_NORTH_EAST: fixed([[.45, 0], [1, 0], [1, .55], [.8, .35], [.15, 1], [0, .85], [.65, .2]]),
  LEFT_RIGHT_ARROW: (w, h, s, a) => {
    const [head, half, cy] = [s * part(a, 1, .5, w / s / 2), h * part(a, 0, .5) / 2, h / 2];
    return polygon([[0, cy], [head, 0], [head, cy - half], [w - head, cy - half], [w - head, 0], [w, cy],
      [w - head, h], [w - head, cy + half], [head, cy + half], [head, h]]);
  },
  UP_DOWN_ARROW: (w, h, s, a) => {
    const [head, half, cx] = [s * part(a, 1, .5, h / s / 2), w * part(a, 0, .5) / 2, w / 2];
    return polygon([[cx, 0], [w, head], [cx + half, head], [cx + half, h - head], [w, h - head], [cx, h],
      [0, h - head], [cx - half, h - head], [cx - half, head], [0, head]]);
  },
  // The notch is as deep as the head's slope makes it at the shaft's edge.
  NOTCHED_RIGHT_ARROW: (w, h, s, a) => {
    const points = rightArrow(w, h, a);
    const [head, half] = [w - points[1][0], h / 2 - points[0][1]];
    return polygon([...points, [half * head / (h / 2), h / 2]]);
  },
  STRIPED_RIGHT_ARROW: (w, h, s) => {
    const stripe = (from, to) => polygon([[from, h / 4], [to, h / 4], [to, 3 * h / 4], [from, 3 * h / 4]]);
    const points = rightArrow(w - 5 * s / 32, h).map(([x, y]) => [x + 5 * s / 32, y]);
    return `${stripe(0, s / 32)} ${stripe(s / 16, s / 8)} ${polygon(points)}`;
  },
  BENT_ARROW: (w, h, s) => {
    const [outer, inner, shaft] = [.4375 * s, .1875 * s, s / 4];
    return d`M0,${h} V${s / 8 + outer} A${outer},${outer} 0 0 1 ${outer},${s / 8} H${w - s / 4} V0 L${w},${s / 4}` +
      d` L${w - s / 4},${s / 2} V${s / 8 + shaft} H${shaft + inner} A${inner},${inner} 0 0 0 ${shaft},${s / 8 + shaft + inner} V${h} Z`;
  },
  BENT_UP_ARROW: (w, h, s) => polygon([[0, h - s / 4], [w - 3 * s / 8, h - s / 4], [w - 3 * s / 8, s / 4], [w - s / 2, s / 4],
    [w - s / 4, 0], [w, s / 4], [w - s / 8, s / 4], [w - s / 8, h], [0, h]]),
  LEFT_UP_ARROW: (w, h, s) => polygon([[0, h - s / 4], [s / 4, h - s / 2], [s / 4, h - 3 * s / 8], [w - 3 * s / 8, h - 3 * s / 8],
    [w - 3 * s / 8, s / 4], [w - s / 2, s / 4], [w - s / 4, 0], [w, s / 4], [w - s / 8, s / 4], [w - s / 8, h - s / 8],
    [s / 4, h - s / 8], [s / 4, h]]),
  LEFT_RIGHT_UP_ARROW: (w, h, s) => {
    const [a, c, cx] = [.225 * s, .1125 * s, w / 2];
    return polygon([[0, h - a], [a, h - 2 * a], [a, h - a - c], [cx - c, h - a - c], [cx - c, a], [cx - a, a], [cx, 0],
      [cx + a, a], [cx + c, a], [cx + c, h - a - c], [w - a, h - a - c], [w - a, h - 2 * a], [w, h - a], [w - a, h],
      [w - a, h - a + c], [a, h - a + c], [a, h]]);
  },
  QUAD_ARROW: (w, h, s) => {
    const [a, c, cx, cy] = [.225 * s, .1125 * s, w / 2, h / 2];
    return polygon([[0, cy], [a, cy - a], [a, cy - c], [cx - c, cy - c], [cx - c, a], [cx - a, a], [cx, 0], [cx + a, a],
      [cx + c, a], [cx + c, cy - c], [w - a, cy - c], [w - a, cy - a], [w, cy], [w - a, cy + a], [w - a, cy + c],
      [cx + c, cy + c], [cx + c, h - a], [cx + a, h - a], [cx, h], [cx - a, h - a], [cx - c, h - a], [cx - c, cy + c],
      [a, cy + c], [a, cy + a]]);
  },
  UTURN_ARROW: (w, h, s) => {
    const [outer, inner, shaft, tip] = [.4375 * s, .1875 * s, s / 4, .75 * h];
    return d`M0,${h} V${outer} A${outer},${outer} 0 0 1 ${outer},0 H${w - s / 8 - outer}` +
      d` A${outer},${outer} 0 0 1 ${w - s / 8},${outer} V${tip - s / 4} H${w} L${w - s / 4},${tip} L${w - s / 2},${tip - s / 4}` +
      d` H${w - 3 * s / 8} V${shaft + inner} A${inner},${inner} 0 0 0 ${w - 3 * s / 8 - inner},${shaft} H${shaft + inner}` +
      d` A${inner},${inner} 0 0 0 ${shaft},${shaft + inner} V${h} Z`;
  },
  CURVED_RIGHT_ARROW: curvedArrow('RIGHT'), CURVED_LEFT_ARROW: curvedArrow('LEFT'),
  CURVED_DOWN_ARROW: curvedArrow('DOWN'), CURVED_UP_ARROW: curvedArrow('UP'),
  RIGHT_ARROW_CALLOUT: arrowCallout('RIGHT'), LEFT_ARROW_CALLOUT: arrowCallout('LEFT'),
  DOWN_ARROW_CALLOUT: arrowCallout('DOWN'), UP_ARROW_CALLOUT: arrowCallout('UP'),
  LEFT_RIGHT_ARROW_CALLOUT: (w, h, s) => {
    const [a, c, cy, left, right] = [s / 4, s / 8, h / 2, .26 * w, .74 * w];
    return polygon([[0, cy], [a, cy - a], [a, cy - c], [left, cy - c], [left, 0], [right, 0], [right, cy - c],
      [w - a, cy - c], [w - a, cy - a], [w, cy], [w - a, cy + a], [w - a, cy + c], [right, cy + c], [right, h],
      [left, h], [left, cy + c], [a, cy + c], [a, cy + a]]);
  },
  QUAD_ARROW_CALLOUT: (w, h, s) => {
    const [a, c, cx, cy] = [.185 * s, .0926 * s, w / 2, h / 2];
    const [left, right, top, bottom] = [.26 * w, .74 * w, .26 * h, .74 * h];
    return polygon([[0, cy], [a, cy - a], [a, cy - c], [left, cy - c], [left, top], [cx - c, top], [cx - c, a], [cx - a, a],
      [cx, 0], [cx + a, a], [cx + c, a], [cx + c, top], [right, top], [right, cy - c], [w - a, cy - c], [w - a, cy - a],
      [w, cy], [w - a, cy + a], [w - a, cy + c], [right, cy + c], [right, bottom], [cx + c, bottom], [cx + c, h - a],
      [cx + a, h - a], [cx, h], [cx - a, h - a], [cx - c, h - a], [cx - c, bottom], [left, bottom], [left, cy + c],
      [a, cy + c], [a, cy + a]]);
  },
  // Part of an ellipse, a quarter from its top round to its right until its handles are dragged:
  // filled to the centre, outlined along the arc.
  ARC: (w, h, s, a) => {
    const { arc } = sweptArc(w, h, a, 270, 0);
    return { d: slice(w, h, arc), open: true, lines: arc };
  },
  // An ellipse less a slice, its top right quarter at first.
  PIE: (w, h, s, a) => slice(w, h, sweptArc(w, h, a, 0, 270).arc),
  CHORD: (w, h, s, a) => `${sweptArc(w, h, a, 45, 270).arc} Z`,
  // Part of a ring, half of it arched over the top at first: out along one arc and back along the
  // other, its ends cut along the angles they are at.
  BLOCK_ARC: (w, h, s, a) => {
    const { arc, from, sweep } = sweptArc(w, h, a, 180, 0);
    const t = s * part(a, 2, .25, .5);
    const [rx, ry] = [Math.max(w / 2 - t, 0), Math.max(h / 2 - t, 0)];
    const inner = seen(w, h, from + sweep, rx, ry).map(n).join(',');
    return `${arc} L${inner} ${arcOf(w, h, from + sweep, -sweep, rx, ry)} Z`;
  },
  DONUT: (w, h, s, a) => {
    const t = s * part(a, 0, .25, .5);
    return `${ellipse(w, h)} ${oval(w / 2, h / 2, w / 2 - t, h / 2 - t, 0)}`;
  },
  NO_SMOKING: (w, h, s) => {
    const t = .1875 * s;
    const [rx, ry] = [w / 2 - t, h / 2 - t];
    const [ax, ay, off] = [rx * Math.SQRT1_2, ry * Math.SQRT1_2, t / 2 * Math.SQRT1_2];
    const band = polygon([[w / 2 - ax + off, h / 2 - ay - off], [w / 2 + ax + off, h / 2 + ay - off],
      [w / 2 + ax - off, h / 2 + ay + off], [w / 2 - ax - off, h / 2 - ay + off]]);
    return `${ellipse(w, h)} ${oval(w / 2, h / 2, rx, ry, 0)} ${band}`;
  },
  MOON: (w, h) => d`M${w},0 A${w},${h / 2} 0 0 0 ${w},${h} A${w / 2},${h / 2} 0 0 1 ${w},0 Z`,
  HEART: (w, h) => d`M${w / 2},${h * .3} C${w / 2},0 0,0 0,${h * .3} C0,${h * .6} ${w / 2},${h * .8}` +
    d` ${w / 2},${h} C${w / 2},${h * .8} ${w},${h * .6} ${w},${h * .3} C${w},0 ${w / 2},0 ${w / 2},${h * .3} Z`,
  TEARDROP: (w, h) => d`M${w / 2},0 H${w} V${h / 2} A${w / 2},${h / 2} 0 1 1 ${w / 2},0 Z`,
  SMILEY_FACE: (w, h, s, a) => {
    // The handle bends the mouth: up at its ends as far as it goes one way, down the other.
    const bend = Math.max(-.04653, Math.min(.04653, handle(a, 0, .04653)));
    return {
      d: ellipse(w, h),
      lines: `${oval(.35 * w, .37 * h, s / 20, s / 20)} ${oval(.65 * w, .37 * h, s / 20, s / 20)}` +
        d` M${.23 * w},${(.7646 - bend) * h} Q${w / 2},${(.7646 + 3 * bend) * h} ${.77 * w},${(.7646 - bend) * h}`,
    };
  },
  SUN: (w, h) => {
    const rays = Array.from({ length: 8 }, (_, i) =>
      polygon([around(w, h, i * 45), around(w, h, i * 45 + 11, .76), around(w, h, i * 45 - 11, .76)]));
    return `${oval(w / 2, h / 2, w / 4, h / 4)} ${rays.join(' ')}`;
  },
  CLOUD: cloud,
  CLOUD_CALLOUT: (w, h, s, a) => {
    // The handle is where the thought comes from, from the shape's middle: the bubbles lead there.
    const [dx, dy] = tailOf(w, h, a);
    const [x, y] = [w / 2 + dx, h / 2 + dy];
    return `${cloud(w, h)} ${oval(x + (w / 2 - x) / 5, y + (h / 2 - y) / 5, s / 20, s / 20)} ${oval(x, y, s / 32, s / 32)}`;
  },
  WAVE: (w, h) => d`M0,${h / 8} C${w / 3},${-h / 8} ${2 * w / 3},${3 * h / 8} ${w},${h / 8} V${7 * h / 8}` +
    d` C${2 * w / 3},${9 * h / 8} ${w / 3},${5 * h / 8} 0,${7 * h / 8} Z`,
  DOUBLE_WAVE: (w, h) => {
    const dy = h / 16;
    return d`M0,${dy} C${w / 6},${-dy} ${w / 3},${3 * dy} ${w / 2},${dy} C${2 * w / 3},${-dy} ${5 * w / 6},${3 * dy} ${w},${dy}` +
      d` V${h - dy} C${5 * w / 6},${h + dy} ${2 * w / 3},${h - 3 * dy} ${w / 2},${h - dy}` +
      d` C${w / 3},${h + dy} ${w / 6},${h - 3 * dy} 0,${h - dy} Z`;
  },
  RIBBON: (w, h) => ribbon(w, h, false),
  RIBBON_2: (w, h) => ribbon(w, h, true),
  ELLIPSE_RIBBON: (w, h) => curvedRibbon(w, h, false),
  ELLIPSE_RIBBON_2: (w, h) => curvedRibbon(w, h, true),
  HORIZONTAL_SCROLL: scroll('RIGHT'),
  VERTICAL_SCROLL: scroll('DOWN'),
  MATH_PLUS: (w, h, s) => {
    const [t, cx, cy] = [.1176 * s, w / 2, h / 2];
    const [x0, x1, y0, y1] = [.1325 * w, .8675 * w, .1325 * h, .8675 * h];
    return polygon([[x0, cy - t], [cx - t, cy - t], [cx - t, y0], [cx + t, y0], [cx + t, cy - t], [x1, cy - t],
      [x1, cy + t], [cx + t, cy + t], [cx + t, y1], [cx - t, y1], [cx - t, cy + t], [x0, cy + t]]);
  },
  MATH_MINUS: (w, h) => {
    const [x0, x1, y0, y1] = bar(w, h);
    return polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  },
  MATH_EQUAL: (w, h) => {
    const [x0, x1] = bar(w, h);
    return [.2059, .5588].map(y => polygon([[x0, y * h], [x1, y * h], [x1, (y + .2353) * h], [x0, (y + .2353) * h]])).join(' ');
  },
  MATH_NOT_EQUAL: (w, h) => `${PATHS.MATH_EQUAL(w, h)} ${within(w, h, [[.56, .06], [.7, .06], [.44, .94], [.3, .94]])}`,
  MATH_MULTIPLY: fixed([[.22, .3], [.3, .22], [.5, .42], [.7, .22], [.78, .3], [.58, .5], [.78, .7],
    [.7, .78], [.5, .58], [.3, .78], [.22, .7], [.42, .5]]),
  MATH_DIVIDE: (w, h) => {
    const [r, reach] = [.1176 * h, .2941 * h];
    return `${PATHS.MATH_MINUS(w, h)} ${oval(w / 2, h / 2 - reach, r, r)} ${oval(w / 2, h / 2 + reach, r, r)}`;
  },
  // Brackets and braces are lines; what they hold between them is filled.
  BRACKET_PAIR: (w, h, s) => {
    const r = corner(s);
    return {
      d: roundRectangle(w, h, s), open: true,
      lines: d`M${r},0 A${r},${r} 0 0 0 0,${r} V${h - r} A${r},${r} 0 0 0 ${r},${h}` +
        d` M${w - r},${h} A${r},${r} 0 0 0 ${w},${h - r} V${r} A${r},${r} 0 0 0 ${w - r},0`,
    };
  },
  BRACE_PAIR: (w, h, s) => {
    const [r, cy] = [s / 12, h / 2];
    return {
      d: polygon([[r, 0], [w - r, 0], [w - r, h], [r, h]]), open: true,
      lines: d`M${2 * r},0 A${r},${r} 0 0 0 ${r},${r} V${cy - r} A${r},${r} 0 0 1 0,${cy} A${r},${r} 0 0 1 ${r},${cy + r}` +
        d` V${h - r} A${r},${r} 0 0 0 ${2 * r},${h} M${w - 2 * r},${h} A${r},${r} 0 0 0 ${w - r},${h - r} V${cy + r}` +
        d` A${r},${r} 0 0 1 ${w},${cy} A${r},${r} 0 0 1 ${w - r},${cy - r} V${r} A${r},${r} 0 0 0 ${w - 2 * r},0`,
    };
  },
  LEFT_BRACKET: bracket(true), RIGHT_BRACKET: bracket(false),
  LEFT_BRACE: brace(true), RIGHT_BRACE: brace(false),
  WEDGE_RECTANGLE_CALLOUT: (w, h, s, a) => callout(w, h, 0, a),
  WEDGE_ROUND_RECTANGLE_CALLOUT: roundCallout,
  SPEECH: roundCallout,
  // The tail leaves the ellipse 11 degrees either side of the way to its tip.
  WEDGE_ELLIPSE_CALLOUT: (w, h, s, a) => {
    const [dx, dy] = tailOf(w, h, a);
    const toward = Math.atan2(dy * w, dx * h) * 180 / Math.PI;
    const [from, to] = [around(w, h, toward + 11), around(w, h, toward - 11)];
    return d`M${from[0]},${from[1]} A${w / 2},${h / 2} 0 1 1 ${to[0]},${to[1]} L${w / 2 + dx},${h / 2 + dy} Z`;
  },
};
PATHS.STARBURST = PATHS.IRREGULAR_SEAL_1;

/**
 * The outline of a shape of `type` in a box `w` by `h`: `d`, the path that is filled and, unless
 * `open` is set, outlined, and `lines`, a path that is only outlined. `adjust` is how far its
 * handles were dragged, where that is known. A type not known is its box.
 */
export function shapeOutline(type, w, h, adjust) {
  const handles = Array.isArray(adjust) ? adjust : undefined;
  const drawn = Object.hasOwn(PATHS, type) ? PATHS[type](w, h, Math.min(w, h) || 1, handles) : box(w, h);
  return typeof drawn === 'string' ? { d: drawn } : drawn;
}

/**
 * An arrowhead of `kind` at the origin, pointing along +x, `size` long, for a line `width` thick:
 * the path that draws it, whether it is filled, and how far back the line stops short of it.
 */
export function arrowHead(kind, size, width) {
  const half = size / 2;
  const filled = kind.startsWith('FILL') || kind === 'STEALTH_ARROW';
  const shape = kind.replace(/^(FILL|OPEN)_/, '');
  if (kind === 'STEALTH_ARROW') {
    return { filled, inset: size * .6, d: `M0,0 L${-size},${-half} L${-size * .6},0 L${-size},${half} Z` };
  }
  if (shape === 'ARROW') {
    return filled ? { filled, inset: size * .9, d: `M0,0 L${-size},${-half} L${-size},${half} Z` }
      : { filled, inset: width / 2, d: `M${-size},${-half} L0,0 L${-size},${half}` };
  }
  const r = half * .7;
  const path = shape === 'CIRCLE' ? `M${-r},0 A${r},${r} 0 1 1 ${r},0 A${r},${r} 0 1 1 ${-r},0 Z`
    : shape === 'SQUARE' ? `M${-r},${-r} H${r} V${r} H${-r} Z`
    : `M${-r},0 L0,${-r} L${r},0 L0,${r} Z`;
  return { filled, inset: filled ? 0 : r, d: path };
}
