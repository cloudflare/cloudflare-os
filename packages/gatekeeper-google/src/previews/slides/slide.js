// One slide drawn from what readSlideDrawings() returns for it: a stage of the slide's own size
// in points, which whoever shows it scales to fit. Everything the slide says is set as text or
// built node by node; nothing from it is parsed as HTML.
//
// A picture is left for the client to fill: an <img> naming its picture. A freeform shape is drawn
// from the paths the session gives for it, and one it gives none for is marked as not drawn.

import { make } from './ui/chrome.js';
import { arrowHead, shapeOutline } from './shapes.js';

const SVG = 'http://www.w3.org/2000/svg';
// The gap Slides keeps between a shape's edge and its text, and a table cell's, in points.
const INSET = 7.2;
const SERIF = /times|georgia|garamond|merriweather|playfair|lora|cambria|baskerville|slab|serif(?! ?pro)/i;
const MONO = /mono|courier|consolas|source code|menlo/i;
/**
 * How far apart Slides sets lines, against their font's size, whatever the font's own measures:
 * so its own drawings of slides in fonts as unlike as Poppins and Source Sans Pro have them.
 */
export const LINE_HEIGHT = 1.2;
// Slides lays text out in pixels, 96 to the inch, and sets its lines a whole number of them apart:
// 14pt text has its lines 16.5pt apart, not 16.8pt.
const PIXEL = .75;
const lineHeight = (fontSize, spacing) => `${Math.round(fontSize * LINE_HEIGHT * spacing / PIXEL) * PIXEL}px`;
const DASHES = { DOT: [1, 3], DASH: [4, 3], DASH_DOT: [4, 3, 1, 3], LONG_DASH: [8, 3], LONG_DASH_DOT: [8, 3, 1, 3] };

const styleSheet = document.createElement('style');
styleSheet.textContent = `
  .stage { position: absolute; top: 0; left: 0; overflow: hidden; transform-origin: 0 0;
    transform: scale(var(--k, 1)); background: #fff; color: #000; text-align: left;
    font: 14px/1.2 Arial, Helvetica, sans-serif; text-rendering: geometricPrecision; }
  .stage * { box-sizing: border-box; }
  .stage img { position: absolute; display: block; max-width: none; }
  .el { position: absolute; }
  .el > svg, .stage > svg { position: absolute; top: 0; left: 0; overflow: visible; }
  .words { position: absolute; inset: 0; display: flex; flex-direction: column; padding: ${INSET}px; }
  .words.middle { justify-content: center; }
  .words.bottom { justify-content: flex-end; }
  /* Slides keeps a word whole that overruns its line by a hair, where a browser would break it. */
  .words p { margin: 0 -.5px; white-space: pre-wrap; overflow-wrap: break-word; }
  .words a { color: inherit; text-decoration: inherit; }
  .bullet { display: inline-block; text-indent: 0; }
  .pic { overflow: hidden; }
  /* A picture still to come, and one there is none of. */
  .pic.none { display: grid; place-items: center; background: #e8eaed; color: #80868b;
    border-radius: 2px; }
  .pic.none > svg { position: static; }
  .pic > img:not([src]) { visibility: hidden; }
  /* A freeform shape with no outline to draw: its box is hatched in its own color and edged with
     dashes, as the place of something not shown, and dark enough that text set on it can be read. */
  .custom { --ink: var(--fill, #80868b); border-radius: 3px; outline-offset: -1px;
    outline: 1px dashed color-mix(in srgb, var(--ink) 55%, transparent);
    background: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--ink) 40%, transparent) 0 3px,
      color-mix(in srgb, var(--ink) 28%, transparent) 3px 6px); }
  .grid { display: grid; }
  .cell { display: flex; flex-direction: column; min-width: 0; padding: ${INSET}px; }
  /* A cell's edges lie over it: Slides gives them no room of their own. */
  .edges { position: absolute; inset: 0; pointer-events: none; }
`;
document.head.append(styleSheet);

const svg = (tag, attributes = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) if (value !== undefined) node.setAttribute(name, value);
  return node;
};

// The fonts to draw `family` in: itself, then a system font of its kind.
const fontStack = family => {
  const name = family.replace(/["\\]/g, '');
  return `"${name}", ${MONO.test(name) ? 'monospace' : SERIF.test(name) ? 'serif' : 'Arial, Helvetica, sans-serif'}`;
};

const paint = ({ color, opacity = 1 }) => opacity < 1 ? `color-mix(in srgb, ${color} ${opacity * 100}%, transparent)` : color;

function stroke(node, line) {
  if (!line) return node.setAttribute('stroke', 'none');
  const dash = DASHES[line.dash];
  node.setAttribute('stroke', paint(line));
  node.setAttribute('stroke-width', line.weight);
  if (dash) node.setAttribute('stroke-dasharray', dash.map(part => part * line.weight).join(' '));
}

const shadowOf = shadow => shadow && `drop-shadow(${shadow.x}px ${shadow.y}px ${shadow.blur}px ${paint(shadow)})`;

function applyLook(node, look, spacing) {
  const set = node.style;
  set.fontFamily = fontStack(look.fontFamily);
  set.fontSize = `${look.fontSize * (look.baseline ? .65 : 1)}px`;
  set.fontWeight = look.fontWeight;
  set.lineHeight = lineHeight(look.fontSize, spacing);
  set.color = look.color;
  // Said either way: a run inside a paragraph drawn in its first run's look turns these off.
  set.fontStyle = look.italic ? 'italic' : 'normal';
  set.fontVariantCaps = look.smallCaps ? 'small-caps' : 'normal';
  if (look.highlight) set.backgroundColor = look.highlight;
  if (look.baseline) set.verticalAlign = look.baseline === 'superscript' ? 'super' : 'sub';
  const lines = [look.underline && 'underline', look.strikethrough && 'line-through'].filter(Boolean);
  if (lines.length) set.textDecorationLine = lines.join(' ');
}

// Only a link to the web is followed, in a new browser tab, and only where `follow` allows it.
function runNode({ link }, follow) {
  if (!follow || typeof link !== 'string' || !/^https?:\/\//i.test(link)) return make('span');
  const node = make('a');
  Object.assign(node, { href: link, target: '_blank', rel: 'noopener noreferrer', title: link });
  return node;
}

function drawText(paragraphs, alignment, follow) {
  const words = make('div', `words ${alignment ?? 'top'}`);
  for (const paragraph of paragraphs) {
    const spacing = (paragraph.lineSpacing ?? 100) / 100;
    const { indentStart = 0, indentFirstLine = 0, indentEnd = 0, bullet } = paragraph;
    const line = words.appendChild(make('p'));
    const set = line.style;
    // A paragraph is as tall as its first run makes its lines; what marks the run's own words is the run's.
    const { highlight: _, underline: __, strikethrough: ___, baseline: ____, ...first } = paragraph.runs[0];
    applyLook(line, first, spacing);
    if (paragraph.alignment) set.textAlign = paragraph.alignment === 'justified' ? 'justify' : paragraph.alignment;
    if (paragraph.rightToLeft) set.direction = 'rtl';
    set.paddingBlock = `${paragraph.spaceAbove ?? 0}px ${paragraph.spaceBelow ?? 0}px`;
    set.paddingInline = `${indentStart}px ${indentEnd}px`;
    set.textIndent = `${indentFirstLine - indentStart}px`;
    if (bullet) {
      const marker = line.appendChild(make('span', 'bullet', bullet.glyph));
      applyLook(marker, bullet, spacing);
      // The text starts at the paragraph's indent, or just past a marker too wide for that.
      marker.style.minWidth = `${Math.max(indentStart - indentFirstLine, 0)}px`;
      marker.style.paddingRight = '.3em';
    }
    for (const run of paragraph.runs) {
      const node = line.appendChild(runNode(run, follow));
      applyLook(node, run, spacing);
      // An empty paragraph is still a line.
      node.textContent = run.text.replaceAll('\u000b', '\n') || '\u200b';
    }
  }
  return words;
}

// How many points each step of a freeform's path takes.
const STEPS = { M: 1, L: 1, Q: 2, C: 3, Z: 0 };

// A freeform's path as an SVG path filling a box `w` by `h`, written out from its numbers: nothing
// of it is taken as text, and a path that holds anything but numbers is not drawn at all.
function freeform({ width, height, ops, points }, w, h) {
  if (!(width > 0 && height > 0) || typeof ops !== 'string' || !Array.isArray(points)) return undefined;
  const steps = [];
  let at = 0;
  for (const op of ops) {
    if (!Object.hasOwn(STEPS, op)) return undefined;
    const taken = points.slice(at, at += 2 * STEPS[op]);
    if (taken.length !== 2 * STEPS[op] || !taken.every(Number.isFinite)) return undefined;
    steps.push(op + taken.map((value, i) => Math.round(value * (i % 2 ? h / height : w / width) * 100) / 100).join(' '));
  }
  return at === points.length ? steps.join(' ') : undefined;
}

function drawShape(node, element, follow, pending) {
  const { width, height } = element.bounds;
  const custom = element.shapeType === 'CUSTOM';
  const paths = custom && Array.isArray(element.paths) ? element.paths.map(path => ({ ...path, d: freeform(path, width, height) })) : [];
  if (custom && !(paths.length && paths.every(({ d }) => d))) {
    // One with neither fill nor outline shows nothing in Google either.
    if (!element.fill && !element.outline && !element.text) return;
    // Its outline may be on its way: until it is known not to come, the shape is one still loading.
    node.classList.add(pending ? 'wait' : 'custom');
    node.title = pending ? 'Loading this shape' : 'A freeform shape, which is not drawn here';
    if (element.fill) node.style.setProperty('--fill', element.fill.color);
  } else if (element.fill || element.outline) {
    const outline = node.appendChild(svg('svg', { width, height }));
    const group = outline.appendChild(svg('g', { transform: element.flipped ? `matrix(1 0 0 -1 0 ${height})` : undefined }));
    for (const { d, filled, stroked } of paths) {
      const path = group.appendChild(svg('path', { d, fill: element.fill && filled !== false ? paint(element.fill) : 'none' }));
      stroke(path, stroked === false ? undefined : element.outline);
    }
    if (!custom) {
      const { d, lines, open } = shapeOutline(element.shapeType, width, height, element.adjust);
      const filled = group.appendChild(svg('path', { d, fill: element.fill ? paint(element.fill) : 'none' }));
      stroke(filled, open ? undefined : element.outline);
      if (lines) stroke(group.appendChild(svg('path', { d: lines, fill: 'none' })), element.outline);
    }
    if (element.shadow) outline.style.filter = shadowOf(element.shadow);
  }
  if (element.text) {
    const words = node.appendChild(drawText(element.text, element.contentAlignment, follow));
    if (element.flipped) words.style.transform = 'rotate(180deg)';
  }
}

function drawPicture(node, element) {
  node.classList.add('pic');
  if (element.shadow) node.style.filter = shadowOf(element.shadow);
  if (!element.pictureId) {
    node.classList.add('none');
    node.title = element.of === 'video' ? 'Video' : element.of === 'chart' ? 'Chart' : 'Picture';
    const size = Math.max(8, Math.min(40, .4 * Math.min(element.bounds.width, element.bounds.height)));
    const icon = node.appendChild(svg('svg', { viewBox: '0 0 20 20', width: size, height: size, fill: 'none',
      stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    icon.append(svg('path', { d: element.of === 'video' ? 'M3 4h14v12H3zM8.5 7.5v5l4-2.5z'
      : 'M3 4h14v12H3zM3 13l4-4 3 3 2.5-2.5L17 14M12.5 7.5h.01' }));
    return;
  }
  const picture = node.appendChild(make('img'));
  picture.dataset.picture = element.pictureId;
  picture.alt = '';
  const { left = 0, top = 0, right = 0, bottom = 0, angle } = element.crop ?? {};
  const [keptX, keptY] = [1 - left - right, 1 - top - bottom];
  Object.assign(picture.style, { width: `${100 / keptX}%`, height: `${100 / keptY}%`,
    left: `${-left / keptX * 100}%`, top: `${-top / keptY * 100}%` });
  if (angle) picture.style.transform = `rotate(${angle}deg)`;
  if (element.flipped) node.style.transform += ' scaleY(-1)';
  if (element.opacity !== undefined) picture.style.opacity = element.opacity;
  const filters = [element.brightness && `brightness(${1 + element.brightness})`,
    element.contrast && `contrast(${1 + element.contrast})`].filter(Boolean);
  if (filters.length) picture.style.filter = filters.join(' ');
  if (element.outline) {
    const { width, height } = element.bounds;
    const frame = node.appendChild(svg('svg', { width, height }));
    stroke(frame.appendChild(svg('rect', { width, height, fill: 'none' })), element.outline);
  }
}

const border = line => line ? `${line.weight}px ${line.dash === 'DOT' ? 'dotted' : line.dash ? 'dashed' : 'solid'} ${paint(line)}` : 'none';

function drawTable(node, table, follow) {
  const rows = table.rowHeights.length;
  const columns = table.columnWidths.length;
  node.classList.add('grid');
  node.style.gridTemplateColumns = table.columnWidths.map(width => `${width}px`).join(' ');
  // Slides grows a row to fit its text.
  node.style.gridTemplateRows = table.rowHeights.map(height => `minmax(${height}px, auto)`).join(' ');
  node.style.height = 'auto';
  table.cells.forEach((row, r) => row.forEach((cell, c) => {
    if (!cell || r >= rows || c >= columns) return;
    const { rowSpan = 1, columnSpan = 1 } = cell;
    const box = node.appendChild(make('div', `cell words ${cell.contentAlignment ?? 'top'}`));
    Object.assign(box.style, {
      position: 'relative', gridRow: `${r + 1} / span ${rowSpan}`, gridColumn: `${c + 1} / span ${columnSpan}`,
      background: cell.fill ? paint(cell.fill) : '',
    });
    if (cell.text) box.append(...drawText(cell.text, undefined, follow).children);
    Object.assign(box.appendChild(make('i', 'edges')).style, {
      borderTop: border(table.horizontalBorders[r]?.[c]), borderLeft: border(table.verticalBorders[r]?.[c]),
      borderBottom: r + rowSpan === rows ? border(table.horizontalBorders[rows]?.[c]) : '',
      borderRight: c + columnSpan === columns ? border(table.verticalBorders[r]?.[columns]) : '',
    });
  }));
}

// A line runs from its start to its end, by way of where a bent or curved one is known to turn.
function drawLine(stage, element) {
  const { start, end, via = [], stroke: line } = element;
  const points = [start, ...via, end];
  const drawing = stage.appendChild(svg('svg', { width: 1, height: 1 }));
  drawing.dataset.id = element.id;
  // A line with no stroke is a transparent one: it is there, with nothing to draw.
  if (!line) return;
  // Slides grows an arrowhead with its line, but keeps a thin line's legible.
  const size = Math.max(3 * line.weight, 5);
  const last = points.length - 1;
  for (const [kind, at, before] of [[element.startArrow, 0, 1], [element.endArrow, last, last - 1]]) {
    if (!kind) continue;
    const [tip, back] = [points[at], points[before]];
    const turn = Math.atan2(tip.y - back.y, tip.x - back.x);
    const head = arrowHead(kind, size, line.weight);
    const path = drawing.appendChild(svg('path', { d: head.d, fill: head.filled ? paint(line) : 'none',
      transform: `translate(${tip.x} ${tip.y}) rotate(${turn * 180 / Math.PI})` }));
    if (!head.filled) stroke(path, { ...line, dash: undefined });
    // The line stops short of the point of its arrowhead.
    points[at] = { x: tip.x - head.inset * Math.cos(turn), y: tip.y - head.inset * Math.sin(turn) };
  }
  const [first, ...rest] = points.map(({ x, y }) => `${x} ${y}`);
  const curve = element.category === 'curved' && { 2: 'Q', 3: 'C' }[rest.length];
  const path = svg('path', { d: `M${first}${curve || 'L'}${rest.join(' ')}`, fill: 'none' });
  stroke(drawing.insertBefore(path, drawing.firstChild), line);
}

/** The upright box an element fills on its slide, in points: a line's from its ends. */
export function boxOf(element) {
  if (element.kind === 'line') {
    const { start, end } = element;
    const pad = (element.stroke?.weight ?? 1) / 2 + 2;
    return { x: Math.min(start.x, end.x) - pad, y: Math.min(start.y, end.y) - pad,
      width: Math.abs(end.x - start.x) + 2 * pad, height: Math.abs(end.y - start.y) + 2 * pad };
  }
  const { x, y, width, height } = element.bounds;
  const turn = (element.rotation ?? 0) * Math.PI / 180;
  const [cos, sin] = [Math.abs(Math.cos(turn)), Math.abs(Math.sin(turn))];
  const [w, h] = [width * cos + height * sin, width * sin + height * cos];
  return { x: x + (width - w) / 2, y: y + (height - h) / 2, width: w, height: h };
}

/**
 * Draws `slide`, a DrawnSlide, on a stage `size.width` by `size.height` points. `follow` says
 * whether its links to the web may be followed: those of an element a pending change touched
 * never are, as that text is not yet approved.
 */
export function drawSlide(slide, size, follow = true, pending = false) {
  const stage = make('div', 'stage');
  stage.style.width = `${size.width}px`;
  stage.style.height = `${size.height}px`;
  const { background } = slide;
  if (background?.color) stage.style.background = paint(background);
  if (background?.pictureId) {
    const picture = stage.appendChild(make('img'));
    picture.dataset.picture = background.pictureId;
    picture.alt = '';
    Object.assign(picture.style, { inset: 0, width: '100%', height: '100%' });
  }
  for (const element of slide.elements) {
    if (element.kind === 'line') {
      drawLine(stage, element);
      continue;
    }
    const { x, y, width, height } = element.bounds;
    const node = stage.appendChild(make('div', 'el'));
    node.dataset.id = element.id;
    Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
    if (element.rotation) node.style.transform = `rotate(${element.rotation}deg)`;
    const followed = follow && !element.changes;
    if (element.kind === 'shape') drawShape(node, element, followed, pending);
    else if (element.kind === 'picture') drawPicture(node, element);
    else drawTable(node, element, followed);
  }
  return stage;
}
