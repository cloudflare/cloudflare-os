// The boxes a Google Doc tab is drawn from: each paragraph, list item, object and table of its
// drawing (GoogleDocRenderingReads.readDrawing()) as an element, sized in points as the drawing
// is. pages.js sets them on sheets. A paragraph is described here by what it is set in rather
// than by places in the drawing's lists, so one a pending change wrote is drawn the same way.

import { make } from './ui/chrome.js';

const styleSheet = document.createElement('style');
styleSheet.textContent = `
  /* A line is as tall as what is on it: every run carries the height its size gives it. */
  /* Google Docs sets each letter as wide as its font draws it, where a browser may round that. */
  .para { position: relative; margin: 0; font-size: 0; line-height: 0; white-space: pre-wrap;
    overflow-wrap: break-word; tab-size: 36pt; scroll-margin-top: 44px;
    text-rendering: geometricPrecision; }
  .para.justify { text-align: justify; }
  /* The two halves of a paragraph that a page ends in. */
  .para.cut { padding-bottom: 0 !important; border-bottom: 0 !important; }
  .para.cut.justify { text-align-last: justify; }
  .para.rest { padding-top: 0 !important; border-top: 0 !important; text-indent: 0 !important; }
  .marker { display: inline-block; text-indent: 0; white-space: nowrap; }
  .marker > span { display: inline-block; }
  .obj { position: relative; display: inline-block; overflow: hidden; text-indent: 0;
    vertical-align: baseline; }
  /* One as wide as its line, which whole pixels may make a little wider, leaves room for what follows it. */
  .obj.inline { max-width: 100%; }
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
// Lines, as Google Docs sets them, measured on the pages it draws. Every font is set alike: a
// line of text is LINE of its size tall times the paragraph's line spacing, with the baseline
// ASCENT of the size under its top and the rest of the line under the text. A paragraph's space
// is added to its first line and its last, and each line is then rounded up to a whole pixel.

const LINE = 1.18;
const ASCENT = .96;
/** CSS pixels to a point, which the drawing is measured in. */
const PX = 4 / 3;
const whole = pixels => Math.ceil(pixels - .01);
/** How tall a line of text of `size` points is before it is rounded, in pixels. */
const lineOf = (size, spacing) => spacing * LINE * size * PX;

// A fixed-width family that only its owner hands out, by how wide each of its letters is
// against its size: whatever fixed-width font stands in for it is spaced to that.
const FIXED_WIDTHS = { Consolas: 1126 / 2048 };

const lookSheet = document.head.appendChild(document.createElement('style'));
// Each look drawn so far, by what it holds.
const classes = new Map();

function lookCss(look) {
  const lines = [look.underline && 'underline', look.strikethrough && 'line-through'].filter(Boolean);
  return [
    `font-family: ${fontStack(look.fontFamily)}`,
    `font-weight: ${look.weight}`,
    look.italic && 'font-style: italic',
    look.smallCaps && 'font-variant-caps: small-caps',
    FIXED_WIDTHS[look.fontFamily] && `letter-spacing: calc(${FIXED_WIDTHS[look.fontFamily]}em - 1ch)`,
    lines.length && `text-decoration-line: ${lines.join(' ')}`,
    look.color && `color: ${look.color}`,
    look.highlight && `background-color: ${look.highlight}`,
    // Raised or lowered text is drawn smaller, and leaves its line the height it had.
    ...look.baseline
      ? [`font-size: ${pt(look.fontSize * .6)}`, `vertical-align: ${look.baseline}`, 'line-height: 0']
      : [
        `font-size: ${pt(look.fontSize)}`,
        `--l: round(up, calc(var(--ls, 1) * ${LINE}em - .01px), 1px)`,
        'line-height: var(--l)',
        // What line spacing adds to a line, Google Docs puts under its text: a browser puts half above.
        'position: relative',
        `top: calc((${LINE}em - var(--l)) / 2)`,
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
// The space above and below a paragraph. Between two paragraphs Google Docs keeps the larger of
// what the upper asks for below it and the lower above it.

// Each paragraph drawn: the space it asks for and how tall its first and last lines are before
// they are rounded, in pixels, and what its border adds over and under it.
const spaces = new WeakMap();

function setSpace(element) {
  const kept = spaces.get(element);
  const above = kept.over ? 0 : kept.above;
  const below = kept.under ? 0 : kept.below;
  const top = whole(above + kept.first) - whole(kept.first);
  const bottom = whole(kept.last + below) - whole(kept.last);
  // A paragraph of one line has both on that line, which may round another way.
  const alone = whole(above + kept.first + below) - whole(above + kept.first);
  const set = element.style;
  set.paddingTop = `${kept.top + top}px`;
  set.paddingBottom = `${kept.bottom + bottom}px`;
  set.setProperty('--above', `${top}px`);
  set.setProperty('--below', `${bottom}px`);
  if (alone === bottom) delete element.dataset.one;
  else element.dataset.one = kept.bottom + alone;
  if (element.isConnected) settle(element);
}

/** Sets the space between `upper` and `lower`, one drawn under the other; either may be no paragraph. */
export function join(upper, lower) {
  const [over, under] = [spaces.get(upper), spaces.get(lower)];
  if (over) over.under = !!under && under.above >= over.below;
  if (under) under.over = !!over && over.below > under.above;
  if (over) setSpace(upper);
  if (under) setSpace(lower);
}

/** `elements` with the space between each and the next set. */
export function joined(elements) {
  for (const [n, element] of elements.entries()) join(elements[n - 1], element);
  return elements;
}

/** Gives `rest`, which carries the paragraph `element` on, the space under it. */
export function carry(element, rest) {
  const kept = spaces.get(element);
  spaces.set(rest, { ...kept, above: 0, top: 0, first: kept.last, over: false });
}

/**
 * Gives each paragraph of one line in `root`, once it is laid out, the space under it that one
 * line has, and then each table's rows their height.
 */
export function settle(root) {
  for (const element of [root, ...root.querySelectorAll('[data-one]')]) {
    const kept = spaces.get(element);
    if (!kept || !('one' in element.dataset)) continue;
    const set = element.style;
    const lines = element.getBoundingClientRect().height - parseFloat(set.paddingTop) - parseFloat(set.paddingBottom) - kept.edges;
    if (lines <= whole(kept.first) + .5) set.paddingBottom = `${element.dataset.one}px`;
  }
  const tables = [...root.matches('.grid') ? [root] : [], ...root.querySelectorAll('.grid')];
  // A table inside a cell first: the row it is in is as tall as it makes it.
  for (const table of tables.toReversed()) fitRows([...table.rows]);
}

/**
 * Makes each of `rows`, laid out, a whole number of pixels tall: Google Docs draws the line
 * between two rows on a pixel, with the upper row's text and padding all above it.
 */
export function fitRows(rows) {
  for (const row of rows) row.style.height = row.dataset.least ?? '';
  const tall = rows.map(row => row.getBoundingClientRect().height);
  for (const [n, row] of rows.entries()) if (tall[n] % 1 > .01) row.style.height = `${Math.ceil(tall[n])}px`;
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
    // Google Docs draws an object a whole number of pixels wide and tall.
    box.style.width = `${Math.round(object.width * PX)}px`;
    box.style.height = `${Math.round(object.height * PX)}px`;
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
    const spacing = (whole(lineOf(end.fontSize, look.lineSpacing)) - lineOf(end.fontSize, 1)) / PX;
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
      if (side === 'left' || side === 'right') set.setProperty(`padding-${side}`, pt(borders[side].padding ?? 0));
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

    // The spaces a paragraph ends in take no room: they neither move its text nor start a line.
    const final = runs.at(-1)?.text === undefined ? undefined : runs.at(-1);
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
        for (const [n, text] of (run === final ? run.text.replace(/ +$/, '') : run.text).split('\u000b').entries()) {
          if (n) last.append(make('br'));
          // Google Docs ends no line at a hyphen inside a word, as a browser would.
          if (text) last.append(text.replace(/-(?=\S)/g, '-\u2060'));
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
        const box = element.appendChild(objectBox(run.object));
        box.classList.add('inline', set);
        // It stands on the baseline, in a line as tall as imageLine() makes it, and is drawn as
        // far under the top of that line as Google Docs draws it.
        const size = (run.look ?? end).fontSize;
        const tall = parseFloat(box.style.height);
        const over = whole(imageLine(run.object, size, look.lineSpacing)) - tall - under(set, look.lineSpacing);
        box.style.marginTop = `${over}px`;
        box.style.top = `${Math.max(2, ASCENT * size * PX - tall) - over}px`;
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
    // The paragraph's end has a look of its own, which only an empty paragraph is the height of:
    // after anything else it is set as that is, on the line: raised or lowered text holds none.
    const looked = runs.filter(run => run.look);
    element.append(make('span', lookClass({ ...looked.at(-1)?.look ?? end, baseline: undefined }), '\u2060'));
    // Its first line and its last are taken to be as tall as its first run and its last make them.
    const height = run => {
      const size = (run?.look ?? end).fontSize;
      return run?.object ? imageLine(run.object, size, look.lineSpacing) : lineOf(size, look.lineSpacing);
    };
    spaces.set(element, {
      above: (look.spaceAbove ?? 0) * PX,
      below: (look.spaceBelow ?? 0) * PX,
      first: height(looked[0]),
      last: height(looked.at(-1)),
      top: (borders.top?.padding ?? 0) * PX,
      bottom: (borders.bottom?.padding ?? 0) * PX,
      edges: ((borders.top?.width ?? 0) + (borders.bottom?.width ?? 0)) * PX,
    });
    setSpace(element);
    return element;
  }

  // How far under the baseline a line keeps the text of a look, which a browser rounds its own way.
  const unders = new Map();
  function under(name, spacing) {
    const key = `${name} ${spacing}`;
    if (!unders.has(key)) {
      const probe = document.body.appendChild(make('div', 'para'));
      probe.style.cssText = `position: absolute; visibility: hidden; --ls: ${spacing}`;
      probe.append(make('span', name, '\u2060'));
      const foot = probe.appendChild(make('span'));
      foot.style.display = 'inline-block';
      unders.set(key, probe.getBoundingClientRect().bottom - foot.getBoundingClientRect().bottom);
      probe.remove();
    }
    return unders.get(key);
  }

  // How tall the line an object is set in is, before it is rounded, among text of `size` points:
  // the object stands on the baseline two pixels under the top of its line, which goes on under
  // it as under text.
  function imageLine(id, size, spacing) {
    const tall = Math.round((objects[id]?.height ?? 0) * PX);
    return Math.max(ASCENT * size * PX, tall + 2) + (LINE * spacing - ASCENT) * size * PX;
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
    const total = widths.reduce((sum, column) => sum + column, 0);
    element.style.width = pt(total);
    // A table wider than its column is one brought in from Word, which starts it before the
    // column, so that the text of its first cells starts where the column does.
    const first = rows[0]?.cells[0];
    if (total > room && first) element.style.marginLeft = `${-Math.round(first.padding[3] * PX + (first.borders.left ? 1 : 0))}px`;
    const group = element.appendChild(make('colgroup'));
    for (const column of widths) group.appendChild(make('col')).style.width = pt(column);
    const body = element.appendChild(make('tbody'));
    for (const row of rows) {
      const cells = body.appendChild(make('tr'));
      if (row.minHeight) cells.style.height = cells.dataset.least = pt(row.minHeight);
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
        box.append(...joined(cell.blocks.flatMap(block => blocks(block, undefined, inside))));
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
