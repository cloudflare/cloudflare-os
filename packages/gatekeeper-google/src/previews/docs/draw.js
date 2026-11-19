// The boxes a Google Doc tab is drawn from: each paragraph, list item, object and table of its
// drawing (GoogleDocRenderingReads.readDrawing()) as an element, sized in points as the drawing
// is. pages.js sets them on sheets. A paragraph is described here by what it is set in rather
// than by places in the drawing's lists, so one a pending change wrote is drawn the same way.

import { make } from './ui/chrome.js';

const styleSheet = document.createElement('style');
styleSheet.textContent = `
  /* A line is as tall as what is on it: every run carries the height its own font gives it. */
  .para { position: relative; margin: 0; font-size: 0; line-height: 0; white-space: pre-wrap;
    overflow-wrap: break-word; tab-size: 36pt; scroll-margin-top: 44px; }
  .para.justify { text-align: justify; }
  /* The two halves of a paragraph that a page ends in. */
  .para.cut { padding-bottom: 0 !important; border-bottom: 0 !important; }
  .para.cut.justify { text-align-last: justify; }
  .para.rest { padding-top: 0 !important; border-top: 0 !important; text-indent: 0 !important; }
  .marker { display: inline-block; text-indent: 0; white-space: nowrap; }
  .marker > span { display: inline-block; }
  .obj { position: relative; display: inline-block; overflow: hidden; text-indent: 0;
    vertical-align: baseline; }
  /* One set in a line as a letter is: what line spacing adds goes under it, as under text. */
  .obj.inline { margin-top: calc((var(--ls, 1) - 1) * var(--h, 0pt) / 2); }
  .obj img { position: absolute; display: block; max-width: none; animation: arrive .25s ease-out; }
  /* A drawing, which has a size and nothing to show in it. */
  .obj.none { border-radius: 2pt; background: repeating-linear-gradient(135deg, #f1f3f4 0 6pt, #e8eaed 6pt 12pt); }
  .lift { width: 0; }
  .rule { display: inline-block; width: 100%; height: 0; border-top: 1pt solid #888; vertical-align: .3em; }
  .chip { display: inline-block; padding: 0 5pt; border-radius: 999px; background: #f1f3f4;
    text-indent: 0; white-space: nowrap; }
  .link { color: inherit; text-decoration-line: none; cursor: text; }
  .link.go { cursor: pointer; }
  .grid { border-collapse: collapse; table-layout: fixed; margin: 0; }
  .grid td { box-sizing: border-box; vertical-align: top; }
`;
document.head.append(styleSheet);

const pt = length => `${Math.round(length * 1000) / 1000}pt`;

const SERIF = /times|georgia|garamond|merriweather|playfair|lora|cambria|baskerville|slab|serif(?! ?pro)/i;
const MONO = /mono|courier|consolas|source code|menlo/i;
const fontStack = name => {
  const family = name.replace(/["\\]/g, '');
  return `"${family}", ${MONO.test(family) ? 'monospace' : SERIF.test(family) ? 'serif' : 'Arial, sans-serif'}`;
};

// ---------------------------------------------------------------------------------------------
// Text looks, each a class. Google Docs sets a line at its font's own height times the
// paragraph's line spacing, so each class carries that height and the paragraph the spacing.
// Google Docs lays its pages out in pixels, so a font's height is the font's own at that size,
// rounded up to a whole pixel.

// A family Google Docs sets by other measures than its font file holds, as a fraction of the
// font's size above the baseline and below it: Docs keeps the measures a family had when it
// first served it, so that no document is laid out again when the font is redrawn.
const DOCS_MEASURES = { 'Roboto Slab': [1900 / 2048, 500 / 2048] };

const lookSheet = document.head.appendChild(document.createElement('style'));
const ruler = document.createElement('canvas').getContext('2d');
// Each font's line height against its size, as the browser has the font now. It is measured
// large: at the size of text a browser rounds what it reports.
const heights = new Map();
// Each look drawn so far, by what it holds.
const classes = new Map();

function lineHeight({ fontFamily, fontSize, weight, italic }) {
  const font = `${italic ? 'italic ' : ''}${weight} 1000px ${fontStack(fontFamily)}`;
  const [ascent, descent] = DOCS_MEASURES[fontFamily] ?? [];
  if (ascent) heights.set(font, ascent + descent);
  if (!heights.has(font)) {
    ruler.font = font;
    const { fontBoundingBoxAscent, fontBoundingBoxDescent } = ruler.measureText('x');
    heights.set(font, (fontBoundingBoxAscent + fontBoundingBoxDescent) / 1000);
  }
  return Math.ceil(heights.get(font) * fontSize * 4 / 3 - .01) * .75;
}

function lookCss(look) {
  const lines = [look.underline && 'underline', look.strikethrough && 'line-through'].filter(Boolean);
  return [
    `font-family: ${fontStack(look.fontFamily)}`,
    `font-weight: ${look.weight}`,
    look.italic && 'font-style: italic',
    look.smallCaps && 'font-variant-caps: small-caps',
    lines.length && `text-decoration-line: ${lines.join(' ')}`,
    look.color && `color: ${look.color}`,
    look.highlight && `background-color: ${look.highlight}`,
    // Raised or lowered text is drawn smaller, and leaves its line the height it had.
    ...look.baseline
      ? [`font-size: ${pt(look.fontSize * .6)}`, `vertical-align: ${look.baseline}`, 'line-height: 0']
      : [
        `font-size: ${pt(look.fontSize)}`,
        `--h: ${pt(lineHeight(look))}`,
        'line-height: calc(var(--ls, 1) * var(--h))',
        // What line spacing adds to a line, Google Docs puts under its text: a browser puts half above.
        'position: relative',
        'top: calc((1 - var(--ls, 1)) * var(--h) / 2)',
      ],
  ].filter(Boolean).join('; ');
}

/** The class that sets text in `look`, a GoogleDocTextLook. */
function lookClass(look) {
  const key = JSON.stringify(look);
  let found = classes.get(key);
  if (!found) {
    classes.set(key, found = { name: `t${classes.size}`, look });
    lookSheet.sheet.insertRule(`.${found.name} { ${lookCss(look)} }`, lookSheet.sheet.cssRules.length);
  }
  return found.name;
}

// ---------------------------------------------------------------------------------------------
// Lists

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'],
  [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

function roman(number) {
  let text = '';
  for (const [value, digits] of ROMAN) for (; number >= value; number -= value) text += digits;
  return text;
}

function alpha(number) {
  let text = '';
  for (; number > 0; number = Math.floor((number - 1) / 26)) text = String.fromCharCode(97 + (number - 1) % 26) + text;
  return text;
}

const NUMBERS = {
  decimal: String,
  zeroDecimal: number => String(number).padStart(2, '0'),
  alpha,
  upperAlpha: number => alpha(number).toUpperCase(),
  roman,
  upperRoman: number => roman(number).toUpperCase(),
};

/** The levels of a list a pending change starts, which Google Docs would make this way. */
export const newList = numbered => Array.from({ length: 9 }, (_, level) => ({
  format: numbered ? `%${level}.` : `%${level}`,
  ...numbered ? { numbering: ['decimal', 'alpha', 'roman'][level % 3] } : { symbol: '●○■'[level % 3] },
  start: 1,
  indentFirstLine: 18 + 36 * level,
  indentStart: 36 + 36 * level,
}));

// ---------------------------------------------------------------------------------------------

const EDGES = ['top', 'right', 'bottom', 'left'];
const DASH = { dot: 'dotted', dash: 'dashed' };
const line = ({ width, color, dash }) => `${pt(width)} ${DASH[dash] ?? 'solid'} ${color}`;
const HEADING = /^(?:TITLE|HEADING_([1-6]))$/;
/** The level a paragraph of the named style `style` is a heading of, if it is one. */
export const headingLevel = style => {
  const found = HEADING.exec(style ?? '');
  return found ? Number(found[1] ?? 1) : undefined;
};

/**
 * Draws what `drawing` holds, in a column `width` wide. `lists` adds to the drawing's lists
 * those the pending changes start.
 */
export function drawer(drawing, width, lists) {
  const { textLooks, paragraphLooks, objects } = drawing;
  const levelsOf = id => drawing.lists[id] ?? lists[id] ?? [];
  // Each list's count at each of its levels, as far as has been drawn.
  let counts = new Map();

  function marker({ id, level }) {
    const levels = levelsOf(id);
    const counted = counts.get(id) ?? counts.set(id, []).get(id);
    counted.length = Math.min(counted.length, level + 1);
    for (let above = 0; above < level; above++) counted[above] ??= levels[above]?.start ?? 1;
    counted[level] = (counted[level] ?? (levels[level]?.start ?? 1) - 1) + 1;
    const glyph = at => levels[at]?.numbering ? NUMBERS[levels[at].numbering](counted[at] ?? 1) : levels[at]?.symbol ?? '●';
    return (levels[level]?.format ?? `%${level}`).replace(/%(\d)/g, (_, at) => glyph(Number(at)));
  }

  function objectBox(id) {
    const object = objects[id] ?? { width: 0, height: 0 };
    const box = make('span', object.readable ? 'obj' : 'obj none');
    box.dataset.object = id;
    box.style.width = pt(object.width);
    box.style.height = pt(object.height);
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', object.description ?? 'Image');
    if (object.description) box.title = object.description;
    if (object.angle) box.style.transform = `rotate(${object.angle}rad)`;
    if (object.border) box.style.outline = line(object.border);
    return box;
  }

  // An object tethered to a paragraph is set against the paragraph's start, by the text's edge.
  // `end` is the look the paragraph's lines are taken to be set in.
  function tether(id, look, end, into) {
    const object = objects[id];
    if (!object?.placed) return;
    const { left, top, layout } = object.placed;
    const [above, after, below, before] = object.margins ?? [0, 0, 0, 0];
    const box = objectBox(id);
    const set = box.style;
    // From the edge of the paragraph's text, which its indent moves, to the object itself.
    const across = left - (look.indentStart ?? 0) + before;
    if (layout === 'front' || layout === 'behind') {
      Object.assign(set, { position: 'absolute', left: pt(across), top: pt(top + above), zIndex: layout === 'front' ? 1 : -1 });
      return void into.append(box);
    }
    // Text passes a wrapped object on both sides; here it keeps to the wider one.
    const side = layout === 'breakLeft' || layout !== 'breakRight' && left + before + object.width / 2 <= width / 2
      ? 'left' : 'right';
    // The lines above it run their full width: only what is level with the object gives way, and
    // a line is level with it by its text, not by the spacing under that. So what keeps the text
    // off starts that much lower than the object's own margin does.
    const lift = top - (look.spaceAbove ?? 0);
    const spacing = (look.lineSpacing - 1) * lineHeight(end);
    const clear = Math.max(0, lift + spacing);
    const drop = lift + above - clear;
    // What holds text off the object: itself, or for one with no text beside it the whole line.
    let float = box;
    if (layout === 'breakBoth') {
      float = make('span', 'row');
      Object.assign(float.style, { width: '100%', height: pt(Math.max(0, drop + object.height + below)) });
      Object.assign(set, { marginLeft: pt(across), marginTop: pt(drop) });
      float.append(box);
    } else {
      Object.assign(set, { marginTop: pt(drop), marginBottom: pt(below) }, side === 'left'
        ? { marginLeft: pt(across), marginRight: pt(after) }
        : { marginLeft: pt(before), marginRight: `calc(100% - ${pt(across + object.width)})` });
    }
    Object.assign(float.style, { float: side, clear: layout === 'breakBoth' ? 'both' : side });
    if (clear) {
      const spacer = into.appendChild(make('span', 'lift'));
      Object.assign(spacer.style, { float: side, height: pt(clear) });
    }
    into.append(float);
  }

  /**
   * One paragraph. `look` is a GoogleDocParagraphLook and `end` the GoogleDocTextLook it ends in.
   * A run is a GoogleDocRun with its look in place of the look's index, and may say what a
   * pending change did with it as `change`, or be `{ tick, note }`: the place of something the
   * view leaves out.
   */
  function paragraph({ look, end, runs, list, objects: tethered, headingId, level, mark }) {
    const element = make('div', look.alignment === 'justify' ? 'para justify' : 'para');
    const set = element.style;
    const start = look.indentStart ?? 0;
    const first = look.indentFirstLine ?? 0;
    const { borders = {} } = look;
    const edge = side => (borders[side]?.width ?? 0) + (borders[side]?.padding ?? 0);
    set.setProperty('--ls', look.lineSpacing);
    // The start of the text, for what is drawn in the margin beside it.
    set.setProperty('--in', pt(start));
    if (look.spaceAbove) set.paddingTop = pt(look.spaceAbove);
    if (look.spaceBelow) set.paddingBottom = pt(look.spaceBelow);
    set.setProperty('--above', pt(look.spaceAbove ?? 0));
    set.setProperty('--below', pt(look.spaceBelow ?? 0));
    // A border stands outside the text, which stays where its indent puts it.
    if (start - edge('left')) set.marginLeft = pt(start - edge('left'));
    if ((look.indentEnd ?? 0) - edge('right')) set.marginRight = pt((look.indentEnd ?? 0) - edge('right'));
    if (first !== start) set.textIndent = pt(first - start);
    if (look.alignment && look.alignment !== 'justify') set.textAlign = look.alignment;
    if (look.rightToLeft) element.dir = 'rtl';
    if (look.shading) set.background = look.shading;
    for (const side of EDGES) {
      if (!borders[side]) continue;
      set.setProperty(`border-${side}`, line(borders[side]));
      const padding = (borders[side].padding ?? 0) + (side === 'top' ? look.spaceAbove ?? 0 : side === 'bottom' ? look.spaceBelow ?? 0 : 0);
      set.setProperty(`padding-${side}`, pt(padding));
    }
    if (level) {
      element.setAttribute('role', 'heading');
      element.setAttribute('aria-level', level);
    }
    if (headingId) element.dataset.heading = headingId;
    if (mark) element.classList.add(mark);
    // What pages.js keeps to when a page ends at this paragraph.
    if (look.keepWithNext) element.dataset.next = '';
    if (look.keepLinesTogether) element.dataset.whole = '';
    if (look.avoidWidowAndOrphan) element.dataset.pairs = '';
    if (look.pageBreakBefore) element.dataset.before = 'page';
    for (const id of tethered ?? []) tether(id, look, end, element);

    if (list) {
      const levels = levelsOf(list.id);
      const box = element.appendChild(make('span', `marker ${lookClass(list.look)}`));
      box.style.minWidth = pt(Math.max(0, start - first));
      const text = box.appendChild(make('span', '', marker(list)));
      const { alignment } = levels[list.level] ?? {};
      if (alignment) text.style.transform = `translateX(${alignment === 'end' ? -100 : -50}%)`;
    }

    // Runs set alike and side by side are one element.
    let last;
    let lastKey;
    for (const run of runs) {
      if (run.text !== undefined) {
        const key = `${lookClass(run.look)}\u0000${run.link ?? ''}\u0000${run.change ?? ''}`;
        if (key !== lastKey) {
          const tag = run.change === 'added' ? 'ins' : run.change === 'removed' ? 'del' : run.link ? 'a' : 'span';
          last = element.appendChild(make(tag, lookClass(run.look)));
          if (run.link) {
            last.classList.add('link');
            last.dataset.href = run.link;
          }
          lastKey = key;
        }
        for (const [n, text] of run.text.split('\u000b').entries()) {
          if (n) last.append(make('br'));
          if (text) last.append(text);
        }
        continue;
      }
      lastKey = undefined;
      const set = lookClass(run.look ?? end);
      if (run.tick) {
        const tick = element.appendChild(make('span', `tick ${run.tick}`));
        tick.title = run.note;
        tick.setAttribute('aria-label', run.note);
      } else if (run.object) {
        element.appendChild(objectBox(run.object)).classList.add('inline', set);
      } else if (run.break) {
        // Set as text is, so the line the break ends is one even with nothing else on it.
        element.appendChild(make('span', `brk ${set}`, '\u2060')).dataset.break = run.break;
      } else if (run.rule) {
        element.append(make('span', `rule ${set}`));
      } else if (run.field) {
        element.appendChild(make('span', set, '1')).dataset.field = run.field;
      } else if (run.footnote) {
        element.appendChild(make('span', lookClass({ ...run.look, baseline: 'super' }), run.mark)).dataset.footnote = run.footnote;
      } else {
        const chip = element.appendChild(make(run.link && !run.change ? 'a' : 'span', `chip ${set}`, run.chip ?? 'Equation'));
        if (run.change) chip.classList.add(run.change);
        if (run.link) {
          chip.classList.add('link');
          chip.dataset.href = run.link;
        }
      }
    }
    // The paragraph's end is set in a look of its own, which an empty line is the height of.
    element.append(make('span', lookClass(end), '\u2060'));
    return element;
  }

  /** A paragraph of the drawing as paragraph() takes one. */
  const saved = (block, mark) => ({
    look: paragraphLooks[block.look],
    end: textLooks[block.end],
    runs: block.runs.map(run => ({ ...run, look: textLooks[run.look] })),
    list: block.list && { ...block.list, look: textLooks[block.list.look] },
    objects: block.objects,
    headingId: block.headingId,
    level: headingLevel(block.style),
    mark,
  });

  function table({ columns, rows }, mark, room) {
    const element = make('table', mark ? `grid ${mark}` : 'grid');
    // A column the document leaves unsized shares what the others leave.
    const fixed = columns.reduce((sum, column) => sum + column, 0);
    const share = Math.max(0, room - fixed) / Math.max(1, columns.filter(column => !column).length);
    const widths = columns.map(column => column || share);
    element.style.width = pt(widths.reduce((sum, column) => sum + column, 0));
    const group = element.appendChild(make('colgroup'));
    for (const column of widths) group.appendChild(make('col')).style.width = pt(column);
    const body = element.appendChild(make('tbody'));
    for (const row of rows) {
      const cells = body.appendChild(make('tr'));
      if (row.minHeight) cells.style.height = pt(row.minHeight);
      if (row.header) cells.dataset.header = '';
      if (row.unbroken) cells.dataset.unbroken = '';
      for (const cell of row.cells) {
        const box = cells.appendChild(make('td'));
        const span = cell.columnSpan ?? 1;
        box.dataset.column = cell.column;
        if (cell.rowSpan) box.rowSpan = cell.rowSpan;
        if (span > 1) box.colSpan = span;
        box.style.padding = cell.padding.map(pt).join(' ');
        for (const side of EDGES) box.style.setProperty(`border-${side}`, cell.borders[side] ? line(cell.borders[side]) : 'none');
        if (cell.background) box.style.background = cell.background;
        if (cell.verticalAlign) box.style.verticalAlign = cell.verticalAlign;
        const inside = widths.slice(cell.column, cell.column + span).reduce((sum, column) => sum + column, 0) - cell.padding[1] - cell.padding[3];
        box.append(...cell.blocks.flatMap(block => blocks(block, undefined, inside)));
      }
    }
    return element;
  }

  /** The elements of one block of the drawing, in a column `room` wide. */
  function blocks(block, mark, room = width) {
    if (block.type === 'paragraph') return [paragraph(saved(block, mark))];
    if (block.type === 'table') return [table(block, mark, room)];
    if (block.type === 'contents') return block.blocks.flatMap(inner => blocks(inner, mark, room));
    return [];
  }

  return {
    paragraph,
    blocks,
    /**
     * Draws with `draw` what stands apart from the body, a header or a footnote, whose lists
     * count on their own.
     */
    apart(draw) {
      const body = counts;
      counts = new Map();
      try {
        return draw();
      } finally {
        counts = body;
      }
    },
  };
}

/** Shows the image at `url` in `box`, the box drawn for `object`: the part of it the document keeps. */
export function showPicture(box, object, url) {
  const picture = make('img');
  picture.src = url;
  picture.alt = '';
  const { top = 0, right = 0, bottom = 0, left = 0 } = object.crop ?? {};
  const wide = 1 / Math.max(.01, 1 - left - right);
  const tall = 1 / Math.max(.01, 1 - top - bottom);
  Object.assign(picture.style, { width: `${wide * 100}%`, height: `${tall * 100}%`,
    left: `${-left * wide * 100}%`, top: `${-top * tall * 100}%` });
  if (object.transparency) picture.style.opacity = 1 - object.transparency;
  box.classList.remove('wait');
  box.replaceChildren(picture);
}
