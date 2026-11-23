// The Google Sheets preview (GoogleSheetsGatekeeperImpl.getPreviewUi()): gadget-format client code
// that runs in the gadget UI frame, whose page starts it with main(gadget), at the end of this
// file. There `gadget` is a GoogleSpreadsheetSession rather than a gadget server.
// The gatekeeper imports it as text through client.txt, a symlink to this file, and returns it
// with ui/chrome.js, which the previews of this gatekeeper share.
//
// A sheet is drawn a window at a time, as readDrawing() returns it: a small sheet whole, a large
// one around what is in view, read again as the view moves. Everything the spreadsheet says is set
// as text or built node by node. Nothing from it is parsed as HTML into this document. A link is
// followed only by a click, in a new browser tab, from a cell Google Sheets has saved.

import {
  flash, fontReader, leaveOutline, lineIcon, loadOnRefresh, make, outlineList, page, setOutline, setStops, showError,
  showLoading, showPage, showStale, status, touch, ITSELF,
} from './ui/chrome.js';

// The session main() is handed, which every read below goes through.
let gadget;

// The headers' height and width, and the most cells one window holds.
const HEAD_H = 24;
const HEAD_W = 46;
const MAX_CELLS = 10_000;
// The most fonts read for one spreadsheet.
const MAX_FONTS = 24;
// A sheet no larger than this is drawn whole.
const WHOLE = { rows: 200, columns: 26 };

const styleSheet = document.createElement('style');
styleSheet.textContent = `
  :root { --width: 100000px; --grid: #e1e3e6; --head: #f8f9fa; --head-ink: #5f6368; --freeze: #c4c7c5;
    --pick: #1a73e8; --pick-tint: #e8f0fe; --shade: rgb(60 64 67 / .16); }
  @media (prefers-color-scheme: dark) {
    :root { --grid: #34373a; --head: #28292b; --head-ink: #9aa0a6; --freeze: #5f6368;
      --pick: #8ab4f8; --pick-tint: #283142; --shade: rgb(0 0 0 / .45); }
  }
  body { display: flex; flex-direction: column; box-sizing: border-box; }
  #page { flex: 1; display: flex; flex-direction: column; min-height: 0; margin: 16px 8px; overflow: hidden;
    isolation: isolate;
    background: var(--page); border-radius: 8px; box-shadow: var(--paper); animation: arrive .25s ease-out; }
  #page[aria-busy] { padding: 40px 32px; }
  @media (max-width: 700px) { #page { margin: 0; border-radius: 0; box-shadow: none; } }

  /* The strip the floating buttons lie over: the sheet shown, and the cell picked. */
  #strip { flex: none; display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 180px 0 48px;
    border-bottom: 1px solid var(--line); font-size: 12px; color: var(--dim); white-space: nowrap;
    transition: padding-left var(--swift); }
  #strip b { color: var(--ink); font-size: 13px; overflow: hidden; text-overflow: ellipsis; }
  #strip .at { flex: none; min-width: 34px; padding: 2px 8px; border-radius: 4px; background: var(--chip);
    color: var(--ink); text-align: center; font-variant-numeric: tabular-nums; }
  #strip .fx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ink);
    font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }
  #strip .fx:empty, #strip .at:empty { display: none; }
  /* In a narrow pane the buttons leave room for the name alone, then for the cell picked. */
  @media (max-width: 560px) { #strip .size, #strip .at:not(:empty) ~ .fx { display: none; } #strip { padding-right: 150px; } }
  /* The outline's button is not over the strip when there is none, or it stands beside the page. */
  body:has(#outline-toggle[hidden]) #strip { padding-left: 16px; }
  @media (min-width: 1000px) { .outlined #strip { padding-left: 16px; } }

  #scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin;
    scrollbar-color: var(--line) transparent; }
  /* The sheet at its full size. What no window has drawn yet is left plain, since its rows and
     columns may be any size, and glimmers while it is read. */
  #sizer { position: relative; background: color-mix(in srgb, var(--head) 55%, var(--page)); }
  #sizer.reading { background: linear-gradient(90deg, transparent 20%, var(--page) 50%, transparent 80%) 0 0 / 640px 100%
    color-mix(in srgb, var(--head) 55%, var(--page)); animation: glimmer 1.6s linear infinite; }
  @keyframes glimmer { from { background-position: 0 0; } to { background-position: 640px 0; } }
  @media (prefers-reduced-motion: reduce) { #sizer.reading { animation: none; } }
  .line { display: contents; }
  /* A read that failed as the sheet was scrolled, said without taking away what is drawn. */
  #missed { position: fixed; z-index: 9; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex;
    align-items: center; gap: 10px; max-width: calc(100% - 32px); box-sizing: border-box; padding: 6px 6px 6px 14px;
    border-radius: 999px; background: var(--page); box-shadow: var(--float); color: var(--ink); font-size: 12px; }
  #missed[hidden] { display: none; }
  #missed > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #missed button { flex: none; padding: 3px 12px; border: 1px solid var(--line); border-radius: 999px;
    background: var(--page); color: var(--ink); font: inherit; }
  #missed button:hover { background: var(--chip); }
  #grid { position: absolute; display: grid; font: 10pt/1.2 Arial, Helvetica, sans-serif; color: var(--ink); }
  #grid.arriving { animation: arrive .25s ease-out; }
  /* A gridline left out has no width, so a border beside it is square at its end. */
  .bare .c { border-width: 0; }
  .c, .h { box-sizing: border-box; min-width: 0; min-height: 0; overflow: hidden;
    border-right: 1px solid var(--grid); border-bottom: 1px solid var(--grid); }
  .c { display: flex; align-items: flex-end; padding: 0 3px 1px; background: var(--page);
    white-space: pre; cursor: cell; }
  .c > span { min-width: 0; }
  .num { justify-content: flex-end; text-align: right; }
  .mid { justify-content: center; text-align: center; }
  .h { display: grid; place-items: center; position: sticky; z-index: 5; background: var(--head);
    border-color: var(--line); color: var(--head-ink); font-size: 11px; user-select: none;
    transition: background .12s, color .12s; }
  .h.col { top: 0; z-index: 6; } .h.row { left: 0; } .h.row.fr { z-index: 6; } .h.col.fc { z-index: 7; }
  .h.corner { top: 0; left: 0; z-index: 8; border-right: 3px solid var(--freeze); border-bottom: 3px solid var(--freeze); }
  /* The rows and columns a pending change touches, lit as those of a selection are. */
  .h.hit { background: var(--mark); color: var(--mark-ink); }
  .h.hit.col { box-shadow: inset 0 -2px 0 var(--mark-ink); }
  .h.hit.row { box-shadow: inset -2px 0 0 var(--mark-ink); }
  .h.on { background: var(--pick-tint); color: var(--pick); font-weight: 700; }
  /* Rows or columns hidden just before this one. */
  .h.col.jump { box-shadow: inset 3px 0 0 var(--freeze); }
  .h.row.jump { box-shadow: inset 0 3px 0 var(--freeze); }
  /* Frozen rows and columns stay where they are while the rest scrolls under them. */
  .fr, .fc { position: sticky; z-index: 3; } .fr.fc { z-index: 4; }
  .fr.edge { border-bottom: 3px solid var(--freeze) !important; }
  .fc.edge { border-right: 3px solid var(--freeze) !important; }
  /* The shadow the frozen lines cast on what scrolls under them. */
  .cast { position: sticky; z-index: 3; pointer-events: none; }
  .cast.fr { align-self: start; height: 6px; background: linear-gradient(var(--shade), transparent); }
  .cast.fc { justify-self: start; width: 6px; background: linear-gradient(90deg, var(--shade), transparent); }
  /* Text too long for its cell runs on over the empty ones beside it. */
  .over { position: relative; z-index: 1; overflow: visible; }
  .fr.over, .fc.over { position: sticky; z-index: 4; }
  .over > span { position: absolute; top: 0; bottom: 0; display: flex; align-items: inherit;
    justify-content: inherit; padding: inherit; overflow: hidden; pointer-events: none; }
  .link { color: inherit; }
  .box { flex: none; box-sizing: border-box; display: grid; place-items: center; width: 15px; height: 15px;
    margin: 0 auto 2px; border: 2px solid var(--dim); border-radius: 2px; color: var(--page); }
  .box.ticked { border-color: var(--pick); background: var(--pick); }
  .drop::after { content: ''; flex: none; margin: 0 0 5px auto; border: 4px solid transparent;
    border-top-color: var(--dim); border-bottom: 0; }
  .note { background-image: linear-gradient(225deg, var(--ink) 4px, transparent 4px); }
  .sift::after { content: ''; flex: none; width: 9px; height: 7px; margin: 0 0 4px auto;
    background: var(--dim); clip-path: polygon(0 0, 100% 0, 62% 55%, 62% 100%, 38% 100%, 38% 55%); }
  .picked { box-shadow: inset 0 0 0 2px var(--pick); }

  /* What a pending change did. A changed cell is tinted and keeps its change at hand. */
  .c { --corner: linear-gradient(135deg, var(--mark-ink) 5px, transparent 5px); }
  .c.new { background: var(--corner), var(--mark) !important; color: var(--mark-ink) !important; }
  .c.cut { --corner: linear-gradient(135deg, var(--gone-ink) 5px, transparent 5px);
    background: var(--corner), var(--gone) !important; color: var(--gone-ink) !important;
    text-decoration: line-through color-mix(in srgb, currentColor 55%, transparent); }
  /* Only Google Sheets can say what a formula comes to, so it shows as its text. */
  .c.new.formula { background: var(--corner), repeating-linear-gradient(135deg,
    color-mix(in srgb, var(--mark-ink) 9%, transparent) 0 4px, transparent 4px 8px), var(--mark) !important;
    font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9pt; font-style: normal; }
  /* A cell whose formatting alone a change sets keeps its own look, and the corner. */
  .styled { background-image: var(--corner) !important; }
  .c:focus-visible { outline: 2px solid var(--link); outline-offset: -2px; }
  .band { background-color: color-mix(in srgb, var(--mark) 55%, var(--page)) !important; }
  .h.band { color: var(--mark-ink); font-weight: 700; }
  /* Where each change shows, ringed as a selection is; the navigator steps through these. */
  .ring { position: absolute; z-index: 2; box-sizing: border-box; border: 2px solid var(--mark-ink);
    border-radius: 3px; pointer-events: none; scroll-margin: 60px;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--mark-ink) 16%, transparent); transition: box-shadow .2s ease-out; }
  .ring { --glow: var(--mark-ink); }
  .ring:is(.cleared, .gone) { --glow: var(--gone-ink); }
  .ring.cleared { border-color: var(--gone-ink);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--gone-ink) 16%, transparent); }
  .ring.gone { border-color: var(--gone-ink); border-width: 2px 0 0 2px; border-radius: 0;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--gone-ink) 16%, transparent); }
  /* How many went, said in the headers on the line, where it stays in view: small enough to
     stand between two rows' numbers. */
  .tag { position: absolute; pointer-events: none; }
  .tag.across { left: 0; width: 100%; height: 0; z-index: 5; }
  .tag.down { top: 0; height: 100%; width: 0; z-index: 6; }
  .tag > span { position: sticky; left: 2px; top: 4px; display: block; width: max-content; padding: 0 4px; border-radius: 999px;
    background: var(--gone-ink); color: var(--page); font-size: 8px; font-weight: 700; line-height: 11px;
    white-space: nowrap; transform: translateY(-50%); pointer-events: auto; }
  .tag.down > span { transform: translateX(-50%); }
  .ring.here { box-shadow: 0 0 0 5px color-mix(in srgb, currentColor 30%, transparent); color: var(--mark-ink); }
  .ring.gone.here, .ring.cleared.here { color: var(--gone-ink); }
  .ring.under { visibility: hidden; }
  /* What the sheet holds that is not drawn, where it is. */
  .chart { position: absolute; z-index: 2; box-sizing: border-box; display: grid; place-content: center;
    justify-items: center; gap: 6px; padding: 12px; border: 1px dashed var(--line); border-radius: 6px;
    background: color-mix(in srgb, var(--page) 88%, transparent); color: var(--dim); font-size: 12px;
    text-align: center; overflow: hidden; }

  /* The card that says what a pending change did to the cell under the pointer. */
  #peek { position: fixed; z-index: 9; max-width: 300px; padding: 10px 12px; border-radius: 10px;
    background: var(--page); box-shadow: var(--float); font-size: 12px; line-height: 1.45;
    pointer-events: none; animation: arrive .12s ease-out; }
  #peek h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 11px; font-weight: 700;
    letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  #peek h3::before { content: ''; flex: none; width: 6px; height: 6px; margin: 0 1px 0 3px; border-radius: 50%;
    background: var(--mark-ink); box-shadow: 0 0 0 3px var(--mark); }
  #peek h3 i { margin-left: auto; padding: 0 6px; border-radius: 4px; background: var(--chip); color: var(--ink);
    font-style: normal; letter-spacing: 0; }
  /* What the cell held, and what it will hold. */
  #peek .swap { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px; }
  #peek .swap > span { max-width: 100%; max-height: 5.8em; overflow: hidden; overflow-wrap: anywhere;
    white-space: pre-wrap; }
  #peek .was, #peek .now, #peek .none { box-sizing: border-box; padding: 1px 7px; border-radius: 5px; }
  #peek .was { background: var(--gone); color: var(--gone-ink);
    text-decoration: line-through color-mix(in srgb, currentColor 55%, transparent); }
  #peek .now { background: var(--mark); color: var(--mark-ink); font-weight: 700; }
  #peek .none { padding: 0 6px; border: 1px dashed var(--line); color: var(--dim); }
  #peek .to { color: var(--dim); }
  #peek p { margin: 8px 0 0; color: var(--dim); }
  #peek p b { color: var(--ink); font-weight: 400; }

  /* The sheets, as tabs in the outline. */
  #outline .tab.cut { background: none; color: var(--gone-ink); text-decoration: none; }
  #outline .tab .name[aria-disabled] { cursor: default; }
  #outline .tab.cut .name > span:first-of-type { text-decoration: line-through; }
  #outline .tab.away { opacity: .55; }
  .name > .said { flex: none; }
  .name > .dims { flex: none; color: var(--dim); font-size: 10px; font-weight: 400; font-variant-numeric: tabular-nums; }
  /* A name with two things said of it keeps the room for itself. */
  .name:has(.said)[data-touched] > .dims { display: none; }
  /* In a long list the sheets the changes touch come first, under a heading of their own. */
  #outline h3 { margin: 12px 0 4px 8px; color: var(--dim); font-size: 10px; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase; }
  #outline h3:first-child { margin-top: 2px; }
`;
document.head.append(styleSheet);
// One rule for each format of the window drawn, which its cells are classed by.
const lookSheet = document.head.appendChild(document.createElement('style'));

const strip = Object.assign(make('div'), { id: 'strip' });
const stripTitle = strip.appendChild(make('b'));
const stripSize = strip.appendChild(make('span', 'size'));
const stripAt = strip.appendChild(make('span', 'at'));
const stripText = strip.appendChild(make('span', 'fx'));
const scroller = Object.assign(make('div'), { id: 'scroll' });
const sizer = scroller.appendChild(Object.assign(make('div'), { id: 'sizer' }));
const peek = Object.assign(make('div'), { id: 'peek', hidden: true });
const missed = Object.assign(make('div'), { id: 'missed', hidden: true, role: 'status' });
const missedText = missed.appendChild(make('span'));
const missedRetry = missed.appendChild(make('button', '', 'Try again'));

// ---------------------------------------------------------------------------------------------
// Names: A1 notation, as the session writes it

const letters = column => {
  let name = '';
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
};
const cellName = (row, column) => `${letters(column)}${row + 1}`;
const quoted = title => `'${title.replaceAll("'", "''")}'`;

const columnOf = name => [...name].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);

// A range with no sheet, such as `B3:D9`, as zero-based lines, each end exclusive.
function rectOf(range) {
  const [, c0, r0, c1 = c0, r1 = r0] = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range) ?? [];
  return { r0: r0 - 1, r1: Number(r1), c0: columnOf(c0) - 1, c1: columnOf(c1) };
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------------------------
// The sheet's rows and columns: how many there are, and the size of each one a window has shown.
// One not yet seen is taken to be as Google Sheets makes it.

const lines = (count, size) => ({ count, size, known: new Map(), starts: undefined });
const axesOf = ({ rowCount, columnCount }) => ({ rows: lines(rowCount, 21), columns: lines(columnCount, 100) });

// Where each line starts, in pixels from the first, and where the last ends.
function starts(axis) {
  if (!axis.starts) {
    axis.starts = new Float64Array(axis.count + 1);
    for (let n = 0; n < axis.count; n++) axis.starts[n + 1] = axis.starts[n] + (axis.known.get(n) ?? axis.size);
  }
  return axis.starts;
}

// The line that `offset` pixels from the first falls in.
function lineAt(axis, offset) {
  const at = starts(axis);
  let low = 0;
  let high = axis.count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (at[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function learn(axis, drawn) {
  for (const { number, size, hidden } of drawn) axis.known.set(number - 1, hidden ? 0 : size);
  axis.starts = undefined;
}

// ---------------------------------------------------------------------------------------------
// Looks: the spreadsheet's own fonts, colors, alignment and borders

const COLOR = /^#[0-9a-f]{6}$/i;
// The only links followed: a cell can hold any address, a script's included.
const WEB = /^https?:\/\//i;
const SERIF = /times|georgia|garamond|merriweather|playfair|lora|cambria|baskerville|slab|serif(?! ?pro)/i;
const MONO = /mono|courier|consolas|source code|menlo/i;
const dark = matchMedia('(prefers-color-scheme: dark)');

// The spreadsheet's color as ink on this page, for a cell with no fill of its own. It was chosen
// for a white page. On a dark one it keeps its hue and trades its lightness, so that black reads
// as the page's ink does, white is the page's own, and text made faint stays faint.
function ink(color) {
  if (!COLOR.test(color ?? '')) return;
  return dark.matches ? `oklch(from ${color} calc(.92 - .7 * l) c h)` : color;
}

// The first family a font names, which is the one Google Sheets draws in.
const familyOf = name => name.split(',').map(part => part.replace(/[^\w .-]/g, '').trim()).find(Boolean);

const fontStack = name => {
  const family = familyOf(name);
  if (!family) return 'Arial, sans-serif';
  return `"${family}", ${MONO.test(family) ? 'monospace' : SERIF.test(family) ? 'serif' : 'Arial, sans-serif'}`;
};

// White is the page a spreadsheet starts as, not a fill.
const fillOf = format => COLOR.test(format?.fillColor ?? '') && format.fillColor.toLowerCase() !== '#ffffff'
  ? format.fillColor : undefined;

const ALIGN = { LEFT: ['flex-start', 'left'], CENTER: ['center', 'center'], RIGHT: ['flex-end', 'right'] };
const UPRIGHT = { TOP: 'flex-start', MIDDLE: 'center' };
const BORDERS = {
  SOLID: '1px solid', SOLID_MEDIUM: '2px solid', SOLID_THICK: '3px solid', DOTTED: '1px dotted',
  DASHED: '1px dashed', DOUBLE: '3px double',
};
const thick = border => parseInt(BORDERS[border.style] ?? BORDERS.SOLID, 10);
const shade = border => ink(border.color ?? '#000000') ?? 'var(--ink)';
const borderOf = border => `${BORDERS[border.style] ?? BORDERS.SOLID} ${shade(border)}`;

// Writes the rule cells of format `index` are drawn by. Each value is set as a property, so
// nothing the spreadsheet says is read as CSS.
function writeLook(format, index) {
  const sheet = lookSheet.sheet;
  const set = sheet.cssRules[sheet.insertRule(`.f${index} {}`, sheet.cssRules.length)].style;
  const fill = fillOf(format);
  if (format.fontFamily) set.fontFamily = fontStack(format.fontFamily);
  if (format.fontSize) set.fontSize = `${format.fontSize}pt`;
  if (format.bold) set.fontWeight = 700;
  if (format.italic) set.fontStyle = 'italic';
  const struck = [format.underline && 'underline', format.strikethrough && 'line-through'].filter(Boolean);
  if (struck.length) set.textDecoration = struck.join(' ');
  // A fill was chosen with its text's color, so both are kept as the spreadsheet has them.
  if (fill) set.background = fill;
  const color = fill ? COLOR.test(format.textColor ?? '') ? format.textColor : '#000000' : ink(format.textColor);
  if (color) set.color = color;
  // A filled cell has no gridlines of its own.
  if (fill) set.borderWidth = '0';
  const [justify, align] = ALIGN[format.horizontalAlignment] ?? [];
  if (justify) Object.assign(set, { justifyContent: justify, textAlign: align });
  if (UPRIGHT[format.verticalAlignment]) set.alignItems = UPRIGHT[format.verticalAlignment];
  if (format.wrap === 'WRAP') Object.assign(set, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
  // Text turned on its side reads up the cell or down it, so its alignments change places, over
  // those a cell takes from what it holds. Text turned less is drawn level.
  const turn = Math.abs(format.rotation ?? 0) === 90 ? Math.sign(format.rotation) : 0;
  if (!turn) return;
  const [near, far] = turn > 0 ? ['flex-start', 'flex-end'] : ['flex-end', 'flex-start'];
  set.writingMode = turn > 0 ? 'sideways-lr' : 'vertical-rl';
  set.setProperty('justify-content', { TOP: far, MIDDLE: 'center' }[format.verticalAlignment] ?? near, 'important');
  set.alignItems = { RIGHT: far, CENTER: 'center' }[format.horizontalAlignment] ?? near;
}

// ---------------------------------------------------------------------------------------------
// Fonts: the spreadsheet's own, which the session reads from Google Fonts for this frame

const fonts = fontReader((...font) => gadget.readFont(...font), MAX_FONTS);

// Reads the fonts a drawing's formats name that have not been asked for, and says whether any
// arrived, which changes how far its text runs.
const readFonts = ({ formats }) =>
  fonts.read(formats.map(({ fontFamily, bold, italic = false }) => [familyOf(fontFamily ?? ''), bold ? 700 : 400, italic]));

const canvas = document.createElement('canvas').getContext('2d');
// How wide `text` is in a cell of `format`, padding included.
function widthOf(text, format = {}) {
  canvas.font = `${format.italic ? 'italic ' : ''}${format.bold ? 700 : 400} ${format.fontSize ?? 10}pt ` +
    fontStack(format.fontFamily ?? 'Arial');
  return canvas.measureText(text).width + 7;
}

// ---------------------------------------------------------------------------------------------
// One window of the sheet, drawn as a grid: a header row and column, the frozen lines the window
// leaves out, then its own. Each cell is one element, placed by its row and column.

// What a cell shows, and the look that says how far a pending change stands behind it.
function showing(cell) {
  if (!cell) return { text: '' };
  if (cell.change !== undefined) {
    if (cell.entered === null) return { text: cell.saved ?? '', look: 'cut' };
    if (cell.text !== undefined) return { text: cell.text, look: 'new' };
    // Only Google Sheets can say what a formula comes to: it is shown as its text. A number is
    // shown as entered, which its number format may yet change.
    const text = typeof cell.entered === 'boolean' ? String(cell.entered).toUpperCase() : String(cell.entered);
    return { text, look: text.startsWith('=') ? 'new formula' : 'new' };
  }
  // A cell the changes may alter without writing it shows what is saved; its card says so.
  if (cell.pending) return { text: cell.saved ?? '' };
  return { text: cell.text ?? '' };
}

// The lines of a drawing that are not hidden, each with its place among those drawn and, for a
// frozen one, where it sticks. `jump` says lines hidden just before it were left out.
function tracks(drawn, frozen, head) {
  let stuck = head;
  return drawn.flatMap((line, n) => {
    if (line.hidden) return [];
    const track = { ...line, n, jump: drawn[n - 1]?.hidden ?? false };
    if (line.number <= frozen) {
      track.sticks = stuck;
      stuck += line.size;
      track.edge = line.number === frozen;
    }
    return [track];
  });
}

// Which of the tracks drawn is the line at zero-based `index`, or -1; the track after track `n`,
// when no hidden line lies between them; and the tracks of lines `from` to `to - 1`, each with
// its place among those drawn.
const trackOf = (list, index) => list.findIndex(line => line.number === index + 1);
const next = (list, n) => list[n + 1]?.number === list[n].number + 1 ? n + 1 : undefined;
const within = (list, from, to) => list.map((line, n) => ({ ...line, at: n })).filter(line => line.number > from && line.number <= to);

// Keeps the node of a frozen row or column where it is while the rest scrolls.
function stick(node, track, across) {
  if (track.sticks === undefined) return;
  node.classList.add(across ? 'fc' : 'fr');
  node.style[across ? 'left' : 'top'] = `${track.sticks}px`;
  if (track.edge) node.classList.add('edge');
}

const grid = sizer.appendChild(Object.assign(make('div'), { id: 'grid', role: 'grid' }));
// A window that arrives as the sheet is scrolled takes its place without moving.
grid.addEventListener('animationend', () => grid.classList.remove('arriving'));
// The rings and labels laid over the sheet. They are placed from its corner, not from this.
const marks = sizer.appendChild(make('div'));
// The window drawn: what readDrawing() returned, its visible rows and columns, and its cells'
// elements by row and column number.
let shown;
// The cell picked, by name, and the pending changes of the sheet shown.
let picked;
let info = { changes: [], areas: [], sheets: { saved: [], pending: [] } };

// The header of a column or a row, which stays in view as the sheet scrolls.
function header(kind, line, n) {
  const across = kind === 'col';
  const head = make('div', `h ${kind}`, across ? letters(line.number - 1) : String(line.number));
  head.setAttribute('role', across ? 'columnheader' : 'rowheader');
  if (across) head.ariaColIndex = line.number + 1;
  head.style.gridArea = across ? `1 / ${n + 2}` : `${n + 2} / 1`;
  if (line.jump) head.classList.add('jump');
  stick(head, line, across);
  if (line.inserted) head.classList.add('band');
  if (line.inserted) head.title = 'Inserted by a pending change';
  else if (line.jump) head.title = `${across ? 'Columns' : 'Rows'} before this one are hidden`;
  return head;
}

// The merged ranges of a drawing as its visible tracks have them: for the track a merge starts
// on, how far it reaches; and for each track it covers, the cell that holds what the merge shows
// and how it looks.
function mergesOf(drawing, rows, columns) {
  const anchors = new Map();
  const covered = new Map();
  for (const range of drawing.merges) {
    const { r0, r1, c0, c1 } = rectOf(range);
    const across = within(columns, c0, c1);
    const down = within(rows, r0, r1);
    if (!across.length || !down.length) continue;
    // What a merge shows is held by its first cell, which comes apart when the window leaves it out.
    const holder = drawing.anchors?.[cellName(r0, c0)] ?? drawing.cells[trackOf(drawing.rows, r0)]?.[trackOf(drawing.columns, c0)];
    for (const row of down) for (const column of across) covered.set(`${row.at}:${column.at}`, holder);
    anchors.set(`${down[0].at}:${across[0].at}`, {
      rows: down.length, columns: across.length, lastRow: down.at(-1).at, lastColumn: across.at(-1).at,
      row: r0, column: c0,
    });
  }
  return { anchors, covered };
}

// A row's cells are in an element that takes no part in the layout, for a reader to tell rows by.
function lineOf(index, ...cells) {
  const line = Object.assign(make('div', 'line'), { role: 'row', ariaRowIndex: index });
  line.append(...cells);
  return line;
}

// The line to the right of a cell and the one below are its own to draw: a border either cell
// beside it sets, or a gridline, which a fill on either side leaves out. `right` and `below` are
// the formats of the cells beside it.
function drawEdges(node, format, right, below) {
  const edges = [
    ['Right', format?.borders?.right ?? right?.borders?.left, right],
    ['Bottom', format?.borders?.bottom ?? below?.borders?.top, below],
  ];
  for (const [side, border, beside] of edges) {
    if (border) node.style[`border${side}`] = borderOf(border);
    else if (fillOf(beside)) node.style[`border${side}Width`] = '0';
  }
}

function draw(drawing) {
  const { frozenRowCount = 0, frozenColumnCount = 0, gridlinesHidden } = drawing.sheet;
  const rows = tracks(drawing.rows, frozenRowCount, HEAD_H);
  const columns = tracks(drawing.columns, frozenColumnCount, HEAD_W);
  // The rules were written into the sheet, not the element's text, so emptying its text would
  // leave them, to show through wherever the next window's formats set less.
  while (lookSheet.sheet.cssRules.length) lookSheet.sheet.deleteRule(0);
  drawing.formats.forEach(writeLook);
  const { anchors, covered } = mergesOf(drawing, rows, columns);
  const formatOf = cell => drawing.formats[cell?.format];
  // The cell at a visible row and column: for one a merge covers, the cell that holds the merge.
  const cellAt = (r, c) => covered.has(`${r}:${c}`) ? covered.get(`${r}:${c}`) : drawing.cells[rows[r].n][columns[c].n];
  const filter = drawing.filter && rectOf(drawing.filter);

  const corner = make('div', 'h corner');
  corner.style.gridArea = '1 / 1';
  corner.setAttribute('role', 'columnheader');
  corner.ariaLabel = 'Row';
  const head = { column: columns.map((line, n) => header('col', line, n)), row: rows.map((line, n) => header('row', line, n)) };
  const nodes = new Map();
  const parts = [lineOf(1, corner, ...head.column)];
  rows.forEach((row, r) => {
    const line = parts[parts.push(lineOf(row.number + 1, head.row[r])) - 1];
    const blank = [];
    const drawn = [];
    columns.forEach((column, c) => {
      const merge = anchors.get(`${r}:${c}`);
      if (!merge && covered.has(`${r}:${c}`)) return;
      const cell = cellAt(r, c);
      const format = formatOf(cell);
      const { text, look } = showing(cell);
      const node = make('div', `c${cell?.format === undefined ? '' : ` f${cell.format}`}${look ? ` ${look}` : ''}`);
      node.style.gridArea = merge
        ? `${r + 2} / ${c + 2} / span ${merge.rows} / span ${merge.columns}` : `${r + 2} / ${c + 2}`;
      node.setAttribute('role', 'gridcell');
      node.ariaColIndex = column.number + 1;
      if (merge) Object.assign(node, { ariaRowSpan: merge.rows, ariaColSpan: merge.columns });
      if (!format?.horizontalAlignment && cell?.kind) node.classList.add(cell.kind === 'number' ? 'num' : 'mid');
      if (cell?.holds?.includes('checkbox')) {
        const box = node.appendChild(make('span', text === 'TRUE' ? 'box ticked' : 'box'));
        if (text === 'TRUE') box.append(lineIcon('M4.5 10.5l3.5 3.5 7.5-8', 13));
      } else if (WEB.test(cell?.link ?? '') && !look) {
        const link = node.appendChild(make('a', 'link', text));
        Object.assign(link, { href: cell.link, target: '_blank', rel: 'noopener noreferrer' });
      } else if (cell?.runs && !look) {
        // One box for the cell to place, whose parts look as the cell does but where each says
        // otherwise. On a fill a part keeps its color as the spreadsheet has it, as the cell does.
        const whole = node.appendChild(make('span', 'rich', text.slice(0, cell.runs[0].start)));
        cell.runs.forEach(({ start, format: part }, n) => {
          const run = whole.appendChild(make('span', part === undefined ? '' : `f${part}`, text.slice(start, cell.runs[n + 1]?.start)));
          const color = drawing.formats[part]?.textColor;
          if (fillOf(format) && COLOR.test(color ?? '')) run.style.color = color;
        });
      } else if (text) {
        node.textContent = text;
      }
      if (cell?.holds?.includes('dropdown')) node.classList.add('drop');
      if (cell?.holds?.includes('note')) node.classList.add('note');
      if (cell?.formatted && !look) node.classList.add('styled');
      if (row.inserted || column.inserted) node.classList.add('band');
      // A cell a change touches can be reached with the keyboard, which shows its card: one of
      // them by Tab, and the others from it with the arrow keys.
      if (look || cell?.formatted) {
        node.tabIndex = -1;
        node.setAttribute('aria-describedby', 'peek');
      }
      if (filter && row.number === filter.r0 + 1 && column.number > filter.c0 && column.number <= filter.c1) node.classList.add('sift');
      stick(node, row, false);
      stick(node, column, true);

      const [after, under] = [next(columns, merge?.lastColumn ?? c), next(rows, merge?.lastRow ?? r)];
      drawEdges(node, format, after === undefined ? undefined : formatOf(cellAt(r, after)),
        under === undefined ? undefined : formatOf(cellAt(under, c)));
      // The sheet's first row and column have no cell before them to draw their other edge.
      const { top, left } = format?.borders ?? {};
      const inset = [
        row.number === 1 && top && `inset 0 ${thick(top)}px 0 ${shade(top)}`,
        column.number === 1 && left && `inset ${thick(left)}px 0 0 ${shade(left)}`,
      ].filter(Boolean);
      if (inset.length) node.style.boxShadow = inset.join(', ');

      // A merged cell is named by the cell it starts on, wherever that is.
      node.at = { row: merge?.row ?? row.number - 1, column: merge?.column ?? column.number - 1, cell };
      nodes.set(cellName(node.at.row, node.at.column), node);
      blank[c] = !merge && !text && !cell?.holds?.includes('checkbox');
      drawn[c] = { node, text, format, cell, merge, width: column.size };
      line.append(node);
    });
    overflow(drawn, blank, columns);
  });

  // Under the last frozen row, and beside the last frozen column, lies their shadow.
  for (const [list, across] of [[rows, false], [columns, true]]) {
    const edge = list.findIndex(line => line.edge);
    if (edge < 0 || edge === list.length - 1) continue;
    const cast = Object.assign(make('div', across ? 'cast fc' : 'cast fr'), { role: 'presentation' });
    cast.style.gridArea = across ? `2 / ${edge + 3} / -1 / -1` : `${edge + 3} / 2 / -1 / -1`;
    cast.style[across ? 'left' : 'top'] = `${list[edge].sticks + list[edge].size}px`;
    parts.push(cast);
  }
  sizer.classList.toggle('bare', !!gridlinesHidden);
  Object.assign(grid, { ariaRowCount: drawing.sheet.rowCount + 1, ariaColCount: drawing.sheet.columnCount + 1 });
  grid.style.gridTemplateColumns = `${HEAD_W}px ${columns.map(line => `${line.size}px`).join(' ')}`;
  grid.style.gridTemplateRows = `${HEAD_H}px ${rows.map(line => `${line.size}px`).join(' ')}`;
  // The cell the keyboard was on is the same cell in the next window.
  const focused = grid.contains(document.activeElement) && document.activeElement.at;
  grid.replaceChildren(...parts);
  // Where the window lies is show()'s to say, and stays as it was when the same one is drawn again.
  shown = { ...shown, drawing, rows, columns, nodes, head };
  stopOn(nodes.get(reached) ?? grid.querySelector('.c[tabindex]'));
  if (focused) nodes.get(cellName(focused.row, focused.column))?.focus({ preventScroll: true });
}

// The changed cell that Tab stops on, by name: the last one the keyboard or the pointer was on.
let reached;

function stopOn(node) {
  if (node?.getAttribute('tabindex') !== '-1') return;
  grid.querySelector('.c[tabindex="0"]')?.setAttribute('tabindex', '-1');
  node.tabIndex = 0;
  reached = cellName(node.at.row, node.at.column);
}

// The arrow keys move among the changed cells: along their order, or to the nearest one in
// another row.
grid.addEventListener('keydown', event => {
  const cells = [...grid.querySelectorAll('.c[tabindex]')];
  const n = cells.indexOf(event.target);
  if (n < 0) return;
  const { row, column } = event.target.at;
  const far = ({ at }) => Math.abs(at.row - row) * 1e6 + Math.abs(at.column - column);
  const nearest = list => list.toSorted((a, b) => far(a) - far(b))[0];
  const to = {
    ArrowRight: cells[n + 1], ArrowLeft: cells[n - 1], Home: cells[0], End: cells.at(-1),
    ArrowDown: nearest(cells.filter(cell => cell.at.row > row)), ArrowUp: nearest(cells.filter(cell => cell.at.row < row)),
  }[event.key];
  if (!to) return;
  event.preventDefault();
  to.focus();
});
grid.addEventListener('focusin', event => stopOn(event.target.closest('.c')));

// Lets text too long for its cell run on over the empty cells beside it, as Google Sheets does
// for text that neither wraps nor is clipped, and takes the gridlines it crosses away.
function overflow(drawn, blank, columns) {
  drawn.forEach(({ node, text, format, cell, merge, width }, c) => {
    if (!text || merge || format?.wrap === 'WRAP' || format?.wrap === 'CLIP' || format?.rotation || cell?.link) return;
    const need = widthOf(text, format) - width;
    if (need <= 0) return;
    // A number with no alignment of its own stands at the right, and so runs on to the left.
    const align = format?.horizontalAlignment ?? (cell?.kind === 'number' ? 'RIGHT' : cell?.kind ? 'CENTER' : 'LEFT');
    const side = align === 'RIGHT' ? [1, 0] : align === 'CENTER' ? [.5, .5] : [0, 1];
    const reach = [0, 0];
    const crossed = [];
    side.forEach((share, way) => {
      const step = way ? 1 : -1;
      let wanted = need * share;
      for (let n = c + step; wanted > 0 && blank[n] && columns[n].number === columns[n - step].number + step; n += step) {
        reach[way] += columns[n].size;
        wanted -= columns[n].size;
        crossed.push(way ? drawn[n - 1].node : drawn[n].node);
      }
    });
    if (!reach[0] && !reach[1]) return;
    for (const neighbour of crossed) if (!neighbour.style.borderRightStyle) neighbour.style.borderRightWidth = '0';
    const run = node.querySelector('.rich') ?? make('span', '', text);
    Object.assign(run.style, { left: `${-reach[0]}px`, right: `${-reach[1]}px` });
    node.replaceChildren(run);
    node.classList.add('over');
  });
}

// ---------------------------------------------------------------------------------------------
// Where the pending changes show: a ring around each area, which the navigator steps through,
// and a line where rows or columns were deleted. They lie over the whole sheet, so a change
// outside the window drawn still has a place to go to.

let rings = [];
// The areas the last drawing ringed, so the next one can tell what is new.
let ringed = new Set();
let axes = axesOf({ rowCount: 0, columnCount: 0 });

function placeRings() {
  const { frozenRowCount = 0, frozenColumnCount = 0 } = shown?.drawing.sheet ?? {};
  const rows = starts(axes.rows);
  const columns = starts(axes.columns);
  const merges = shown?.drawing.merges.map(rectOf) ?? [];
  for (const ring of rings) {
    // A change to a merged cell names the cell the merge starts on, and shows over all of it.
    const covers = ({ r0, r1, c0, c1 }) => ring.at.r0 >= r0 && ring.at.r1 <= r1 && ring.at.c0 >= c0 && ring.at.c1 <= c1;
    const { r0, r1, c0, c1 } = ring.cut ? ring.at : merges.find(covers) ?? ring.at;
    // Deleted rows are a line across where they stood, and deleted columns one down.
    const [across, down] = [ring.cut === 'deleteRows', ring.cut === 'deleteColumns'];
    Object.assign(ring.style, {
      top: `${HEAD_H + rows[across && ring.after ? r1 : r0] - 1}px`,
      left: `${HEAD_W + columns[down && ring.after ? c1 : c0] - 1}px`,
      width: `${down ? 0 : columns[c1] - columns[c0] + 1}px`,
      height: `${across ? 0 : rows[r1] - rows[r0] + 1}px`,
    });
    if (ring.tag) Object.assign(ring.tag.style, across ? { top: ring.style.top } : { left: ring.style.left });
    // A frozen cell does not scroll, so a ring drawn where it started would part from it.
    ring.classList.toggle('under', r1 <= frozenRowCount || c1 <= frozenColumnCount);
  }
}

// Lights the headers of the rows and columns the changes touch. Inserted rows run the sheet's
// whole width and say nothing of its columns, as inserted columns say nothing of its rows; and
// deleted ones have no header left.
function lightHeads() {
  for (const { op, range } of info.areas) {
    const { r0, r1, c0, c1 } = rectOf(range);
    if (op.startsWith('delete')) continue;
    if (op !== 'insertColumns') for (const { at } of within(shown.rows, r0, r1)) shown.head.row[at].classList.add('hit');
    if (op !== 'insertRows') for (const { at } of within(shown.columns, c0, c1)) shown.head.column[at].classList.add('hit');
  }
}

function ringAreas() {
  const fresh = loaded ? ringed : undefined;
  ringed = new Set();
  const tagged = new Map();
  rings = info.areas.map(({ change, op, range, count, after }) => {
    const key = `${change}\u0000${op}\u0000${range}`;
    const gone = op.startsWith('delete');
    const ring = make('div', gone ? 'ring gone' : op === 'clearRange' ? 'ring cleared' : 'ring');
    Object.assign(ring, { at: rectOf(range), after, cut: gone ? op : undefined });
    if (gone) {
      // Deletes that meet on one line are counted together there, and stepped through one by one.
      const place = `${op}\u0000${range}\u0000${after}`;
      const first = tagged.get(place) ?? ring;
      tagged.set(place, first);
      first.count = (first.count ?? 0) + count;
      first.tag ??= make('div', op === 'deleteRows' ? 'tag across' : 'tag down');
      first.tag.replaceChildren(make('span', '', `−${plural(first.count, op === 'deleteRows' ? 'row' : 'col')}`));
      first.tag.title = `${plural(first.count, op === 'deleteRows' ? 'row' : 'column')} deleted by ` +
        (first === ring ? 'a pending change' : 'pending changes');
    }
    if (fresh && !fresh.has(key)) ring.classList.add('fresh');
    ringed.add(key);
    return ring;
  });
  setStops(rings.map(ring => [ring]));
}

// ---------------------------------------------------------------------------------------------
// What a pending change did to a cell, said in a card beside it

const FIELDS = {
  bold: 'bold', italic: 'italic', underline: 'underline', strikethrough: 'strikethrough', fontSize: 'font size',
  textColor: 'text color', fillColor: 'fill color', numberFormat: 'number format',
  horizontalAlignment: 'alignment', verticalAlignment: 'vertical alignment', wrap: 'wrapping', borders: 'borders',
};

// Whether `range`, with or without its sheet, holds the cell at `row` and `column`.
function holdsCell(range, row, column) {
  const { r0, r1, c0, c1 } = rectOf(range.slice(range.lastIndexOf('!') + 1));
  return row >= r0 && row < r1 && column >= c0 && column < c1;
}

// The areas of kind `op` that hold the cell at `row` and `column`, latest first.
const areasAt = (row, column, op) =>
  info.areas.filter(area => area.op === op && holdsCell(area.range, row, column)).toReversed();

// Which of the pending changes one is, counted as the person sees them listed.
const nameOf = id => {
  const at = info.changes.findIndex(change => change.id === id);
  return at < 0 ? 'Pending change' : `Pending change ${at + 1} of ${info.changes.length}`;
};

// One side of a before and after: what the cell holds, or that it holds nothing.
const side = (text, look) => text === undefined || text === '' ? make('span', 'none', 'empty') : make('span', look, text);

function describe({ row, column, cell }) {
  const format = areasAt(row, column, 'formatCells')[0];
  if (cell?.change === undefined && !cell?.pending && !(cell?.formatted && format)) return;
  const card = make('div');
  const title = card.appendChild(make('h3', '', nameOf(cell.change ?? format?.change)));
  title.append(make('i', '', cellName(row, column)));
  if (cell.change !== undefined) {
    const swap = card.appendChild(make('div', 'swap'));
    swap.append(side(cell.saved, 'was'), make('span', 'to', '→'),
      side(cell.entered === null ? undefined : String(cell.entered), 'now'));
    if (cell.pending) card.append(make('p', '', 'Google Sheets works out what it shows once the change is saved.'));
  } else if (cell.pending) {
    title.firstChild.data = 'May change';
    card.append(make('p', '', 'This shows what is saved. The pending changes may alter it.'));
  }
  if (cell.formatted && format) {
    const formats = info.changes.find(change => change.id === format.change)?.changes
      .filter(change => change.op === 'formatCells') ?? [];
    // What its batch set on this cell. A batch names each range as it lay when it was made, so
    // where later changes have moved the cell out of them all, all that it set is named.
    const here = formats.filter(change => holdsCell(change.range, row, column));
    const set = new Set((here.length ? here : formats).flatMap(change => Object.keys(change.format)));
    const line = card.appendChild(make('p', '', 'Formatting set: '));
    line.append(make('b', '', [...set].map(field => FIELDS[field] ?? field).join(', ') || 'changed'));
  }
  return card;
}

function showPeek(node) {
  const card = node?.at && describe(node.at);
  peek.hidden = !card;
  if (!card) return;
  peek.replaceChildren(...card.childNodes);
  const box = node.getBoundingClientRect();
  const { width, height } = peek.getBoundingClientRect();
  const below = box.bottom + 8 + height <= innerHeight;
  peek.style.top = `${below ? box.bottom + 8 : Math.max(8, box.top - height - 8)}px`;
  peek.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
}

grid.addEventListener('pointerover', event => showPeek(event.target.closest('.c')));
grid.addEventListener('pointerleave', () => showPeek());
grid.addEventListener('focusin', event => showPeek(event.target.closest('.c')));
grid.addEventListener('focusout', () => showPeek());
scroller.addEventListener('scroll', () => showPeek(), { passive: true });

// The cell picked is ringed as Google Sheets rings it, and said in the strip above the grid.
function pick(name) {
  picked = name;
  for (const lit of grid.querySelectorAll('.picked, .h.on')) lit.classList.remove('picked', 'on');
  const node = shown?.nodes.get(name);
  stripAt.textContent = node ? name : '';
  stripText.textContent = '';
  if (!node) return;
  node.classList.add('picked');
  const { row, column, cell } = node.at;
  shown.head.row[trackOf(shown.rows, row)]?.classList.add('on');
  shown.head.column[trackOf(shown.columns, column)]?.classList.add('on');
  stripText.textContent = cell?.change !== undefined && cell.entered !== null ? String(cell.entered) : showing(cell).text;
}

grid.addEventListener('click', event => {
  const node = event.target.closest('.c');
  if (node?.at) pick(cellName(node.at.row, node.at.column));
});

// ---------------------------------------------------------------------------------------------
// The outline: the spreadsheet's sheets, as its tabs list them, with the ones the pending
// changes add, rename, move, delete or write to marked.

const SHEET_ICON = 'M3.5 4.5h13v11h-13zM3.5 8.5h13M8.5 4.5v11';
// More sheets than this are listed in two groups: the ones the changes touch, then the others.
const GROUPED = 8;

// The ids that keep their order between two lists of the same ids: the longest run that does.
function steady(before, after) {
  const place = new Map(before.map((id, n) => [id, n]));
  const run = after.map(() => 1);
  const from = after.map(() => -1);
  let best = -1;
  after.forEach((id, n) => {
    for (let m = 0; m < n; m++) {
      if (place.get(after[m]) < place.get(id) && run[m] + 1 > run[n]) [run[n], from[n]] = [run[m] + 1, m];
    }
    if (best < 0 || run[n] > run[best]) best = n;
  });
  const kept = new Set();
  for (let n = best; n >= 0; n = from[n]) kept.add(after[n]);
  return kept;
}

// The sheets as they will be, each with what the pending changes do to it, and the ones deleted
// where they stood.
function tabsOf({ saved, pending }) {
  const was = new Map(saved.map(sheet => [sheet.id, sheet]));
  const stays = pending.filter(sheet => was.has(sheet.id)).map(sheet => sheet.id);
  const unmoved = steady(saved.map(sheet => sheet.id).filter(id => stays.includes(id)), stays);
  const tabs = pending.map(sheet => ({
    sheet,
    added: !was.has(sheet.id),
    renamed: was.has(sheet.id) && was.get(sheet.id).title !== sheet.title ? was.get(sheet.id).title : undefined,
    moved: was.has(sheet.id) && !unmoved.has(sheet.id),
  }));
  saved.forEach((sheet, n) => {
    if (stays.includes(sheet.id)) return;
    const before = saved.slice(0, n).findLast(earlier => tabs.some(tab => tab.sheet.id === earlier.id));
    tabs.splice(before ? tabs.findIndex(tab => tab.sheet.id === before.id) + 1 : 0, 0, { sheet, deleted: true });
  });
  return tabs;
}

function renderOutline() {
  const tabs = tabsOf(info.sheets);
  // The sheet whose name holds the keyboard: the name drawn in its place is to hold it again.
  const held = document.activeElement?.dataset.sheet;
  const listing = ({ sheet: listed, added, renamed, moved, deleted }) => {
    const on = listed.id === sheet.id && !deleted;
    // A sheet that is a chart alone has no cells to draw.
    const drawn = listed.rowCount > 0;
    const row = make('div', `tab${on ? ' on' : ''}${deleted ? ' cut' : ''}${listed.hidden || !drawn ? ' away' : ''}`);
    const name = row.appendChild(make('button', 'name'));
    name.dataset.sheet = listed.id;
    name.append(lineIcon(SHEET_ICON), make('span', '', listed.title),
      make('span', 'dims', drawn ? `${listed.rowCount} × ${listed.columnCount}` : 'Chart'));
    // A sheet added or deleted is that whatever else is done to it; any other a change touches is edited.
    const kind = added ? 'added' : deleted ? 'removed' : listed.touched && 'changed';
    const dot = touch(name, kind ? [kind] : [], ITSELF);
    const says = [
      added && 'new, not yet added', renamed && `renamed from “${renamed}”`, moved && 'moved',
      deleted && 'deleted by a pending change', listed.hidden && 'hidden', kind === 'changed' && dot,
      !drawn && 'a chart, not drawn in this preview',
    ].filter(Boolean);
    name.title = says.length ? `${listed.title} (${says.join('; ')})` : listed.title;
    for (const tag of [renamed && 'Renamed', moved && 'Moved']) {
      if (tag) name.append(make('span', 'said', tag));
    }
    name.setAttribute('aria-pressed', String(on));
    if (deleted || !drawn) name.setAttribute('aria-disabled', 'true');
    else {
      name.addEventListener('click', () => {
        if (!on) void open(listed);
        leaveOutline();
      });
    }
    return row;
  };
  const changed = tabs.filter(tab => tab.added || tab.renamed || tab.moved || tab.deleted || tab.sheet.touched);
  const others = tabs.filter(tab => !changed.includes(tab));
  outlineList.replaceChildren(...tabs.length > GROUPED && changed.length && others.length
    ? [make('h3', '', `${changed.length} changed`), ...changed.map(listing), make('h3', '', 'Unchanged'), ...others.map(listing)]
    : tabs.map(listing));
  setOutline('Sheets', tabs.length > 1);
  if (held) outlineList.querySelector(`[data-sheet="${held}"]:not([aria-disabled])`)?.focus();
  outlineList.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------------------------
// Loading and refreshing

// The sheet shown, as the pending changes leave it.
let sheet;
let loaded = false;
// Each load is a generation, and `settled` the one whose sheet, axes and windows are in place:
// the sheet is read on as it scrolls only while that is the latest.
let generation = 0;
let settled = 0;
// The windows read since the last refresh, by range, and whether one is being read.
let windows = new Map();
let reading = false;
// The most cells a window asks for, which a read refused as too large lowers; how many reads
// in a row have failed as the sheet was scrolled; and when the next may be tried.
let room = MAX_CELLS;
let misses = 0;
let retryAt = 0;
const TOO_LARGE = /fewer cells|too large|exceeded the/i;

// The rows and columns in view, each end exclusive.
function inView() {
  const width = scroller.clientWidth || page.clientWidth;
  const height = scroller.clientHeight || page.clientHeight;
  return {
    r0: lineAt(axes.rows, scroller.scrollTop), r1: lineAt(axes.rows, scroller.scrollTop + height - HEAD_H) + 1,
    c0: lineAt(axes.columns, scroller.scrollLeft), c1: lineAt(axes.columns, scroller.scrollLeft + width - HEAD_W) + 1,
  };
}

// The window to read so that `view` is drawn with as much around it as one read allows. The
// sheet's frozen rows and columns come with every window, and count among its cells.
function windowFor(view) {
  const { rowCount, columnCount, frozenRowCount = 0, frozenColumnCount = 0 } = sheet;
  if (room === MAX_CELLS && rowCount <= WHOLE.rows && columnCount <= WHOLE.columns) {
    return { r0: 0, r1: rowCount, c0: 0, c1: columnCount };
  }
  const [wide, tall] = [view.c1 - view.c0, view.r1 - view.r0];
  // What a window has to spare goes around the view: one too small for it starts where it does.
  const before = spare => Math.floor(Math.max(0, spare) / 2);
  // A window made smaller keeps to the view, and a few lines around it.
  const most = room === MAX_CELLS ? Math.min(3 * wide, 160) : wide + 8;
  const across = Math.max(1, Math.min(columnCount, most, Math.floor(room / (frozenRowCount + 1)) - frozenColumnCount));
  const c0 = Math.max(0, Math.min(view.c0 - before(across - wide), columnCount - across));
  const fit = Math.floor(room / (across + frozenColumnCount)) - frozenRowCount;
  const down = Math.max(1, Math.min(rowCount, 5 * tall, fit));
  const r0 = Math.max(0, Math.min(view.r0 - before(down - tall), rowCount - down));
  return { r0, r1: r0 + down, c0, c1: c0 + across };
}

const rangeOf = ({ r0, r1, c0, c1 }) => `${quoted(sheet.title)}!${cellName(r0, c0)}:${cellName(r1 - 1, c1 - 1)}`;

const reaches = (from, to, start, end, count, frozen) =>
  start <= Math.max(frozen, from - 4) && end >= Math.min(count, to + 4);

// Whether the window drawn holds `view` and a few lines around it, as far as the sheet goes.
function holds(view) {
  const { frozenRowCount = 0, frozenColumnCount = 0 } = shown.drawing.sheet;
  return reaches(view.r0, view.r1, shown.r0, shown.r1, sheet.rowCount, frozenRowCount) &&
    reaches(view.c0, view.c1, shown.c0, shown.c1, sheet.columnCount, frozenColumnCount);
}

const sized = list => list.reduce((sum, line) => sum + line.size, 0);

// Reads the window around `view`, asking again for a smaller one while it is refused as too large.
async function readWindow(view, current) {
  for (;;) {
    const at = windowFor(view);
    const range = rangeOf(at);
    if (!windows.has(range)) windows.set(range, gadget.readDrawing(range));
    // Only the last few windows are kept: a long scroll would otherwise keep every one it passed.
    if (windows.size > 8) windows.delete(windows.keys().next().value);
    try {
      return { ...at, range, drawing: await windows.get(range) };
    } catch (error) {
      windows.delete(range);
      if (current !== generation || !TOO_LARGE.test(error?.message) || room <= 600) throw error;
      room = Math.floor(room / 2);
    }
  }
}

// Reads and draws the window around `view`, keeping what is in view where it is.
async function show(view, current, target) {
  const { drawing, range, r0, r1, c0, c1 } = await readWindow(view, current);
  if (current !== generation) return;
  // The lines above and before the view may turn out other sizes than they were taken to be.
  const before = inView();
  const held = { top: scroller.scrollTop - starts(axes.rows)[before.r0], left: scroller.scrollLeft - starts(axes.columns)[before.c0] };
  learn(axes.rows, drawing.rows);
  learn(axes.columns, drawing.columns);
  draw(drawing);
  lightHeads();
  showPeek();
  Object.assign(shown, { r0, r1, c0, c1, range });
  // The frozen lines a window leaves out are drawn before it, and stick from there.
  Object.assign(grid.style, {
    top: `${starts(axes.rows)[r0] - sized(shown.rows.filter(line => line.number <= r0))}px`,
    left: `${starts(axes.columns)[c0] - sized(shown.columns.filter(line => line.number <= c0))}px`,
  });
  Object.assign(sizer.style, {
    width: `${HEAD_W + starts(axes.columns)[axes.columns.count]}px`, height: `${HEAD_H + starts(axes.rows)[axes.rows.count]}px`,
  });
  marks.replaceChildren(...rings, ...rings.flatMap(ring => ring.tag ?? []), ...(drawing.charts ?? []).map(chartBox));
  if (!page.contains(scroller)) page.replaceChildren(strip, scroller, peek, missed);
  const stuck = list => sized(list.filter(line => line.sticks !== undefined));
  scroller.style.scrollPadding = `${HEAD_H + stuck(shown.rows) + 8}px 8px 8px ${HEAD_W + stuck(shown.columns) + 8}px`;
  placeRings();
  if (target) {
    // Clear of the frozen lines, which lie over what scrolls.
    scroller.scrollTo(Math.max(0, starts(axes.columns)[target.c0] - stuck(shown.columns) - 120),
      Math.max(0, starts(axes.rows)[target.r0] - stuck(shown.rows) - 90));
  } else {
    scroller.scrollTo(starts(axes.columns)[before.c0] + held.left, starts(axes.rows)[before.r0] + held.top);
  }
  pick(picked);
  // Text runs on over empty cells as far as it is wide, so a font that arrives is drawn again.
  // Whichever window is drawn by then: a later one asked for no font that was already on its way.
  readFonts(drawing).then(arrived => {
    if (!arrived || !shown) return;
    draw(shown.drawing);
    lightHeads();
    showPeek();
    pick(picked);
  });
}

// A chart is not drawn: the session has no picture of one. It is given its place over the sheet,
// from the corner of the cell it is anchored in, whether or not the window drawn holds that cell.
function chartBox({ title, anchor, offsetX, offsetY, width, height }) {
  const { r0, c0 } = rectOf(anchor);
  const box = make('div', 'chart');
  Object.assign(box.style, {
    left: `${HEAD_W + starts(axes.columns)[c0] + offsetX}px`, top: `${HEAD_H + starts(axes.rows)[r0] + offsetY}px`,
    width: `${width}px`, height: `${height}px`,
  });
  box.append(lineIcon('M4 16V9M8.5 16V4M13 16v-5M17 16H3', 22), make('span', '', title ? `Chart: ${title}` : 'Chart'),
    make('span', '', 'Not drawn in this preview'));
  return box;
}

// Says that the sheet could not be read on, or updated, under what is drawn of it.
function miss(text, retry) {
  missedText.textContent = text;
  missedAgain = retry;
  missed.hidden = false;
}

let missedAgain;
missedRetry.addEventListener('click', () => {
  missed.hidden = true;
  missedAgain();
});

// Reads on as the view nears the edge of the window drawn. `retry` is set when asked for by hand.
async function follow(retry) {
  // Nothing is read on for a page that is not shown, whose view has no size, or while a load is
  // putting another sheet, or other changes, in place.
  if (reading || settled !== generation || !shown || page.hidden || !scroller.clientWidth) return;
  if (holds(inView()) || rangeOf(windowFor(inView())) === shown.range) return;
  // A read that failed is not tried again at once: the next scroll after a while tries it.
  if (retry !== true && Date.now() < retryAt) return;
  const current = generation;
  reading = true;
  sizer.classList.add('reading');
  status('Reading…');
  const failed = await show(inView(), current).then(() => false, () => true);
  reading = false;
  sizer.classList.remove('reading');
  // A load that finished meanwhile left its own reading on to this.
  if (current !== generation) return void follow();
  status('');
  if (!failed) {
    misses = 0;
    missed.hidden = true;
    return void follow();
  }
  // What is drawn stays: the failure is said under it.
  retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** misses++);
  miss('More of this sheet could not be read', () => follow(true));
}

scroller.addEventListener('scroll', () => requestAnimationFrame(follow), { passive: true });
addEventListener('resize', () => requestAnimationFrame(follow));

// What was kept of the sheet last shown, which the next one starts without.
function forget() {
  loaded = false;
  ringed = new Set();
  picked = reached = undefined;
  room = MAX_CELLS;
}

// Shows another sheet, from its top or from the first of its changes.
function open(other) {
  sheet = other;
  forget();
  return load();
}

// The first of `sheets` to open: one in view before one hidden, and one of cells before a chart.
const firstOf = sheets => sheets.find(listed => !listed.hidden && listed.rowCount) ??
  sheets.find(listed => listed.rowCount) ?? sheets[0];

// The pending changes of the sheet shown. On opening that is the first sheet the changes touch,
// or the first there is.
async function readChanges() {
  let title = sheet?.title;
  if (title === undefined) {
    const { sheets } = await gadget.getSpreadsheet();
    title = firstOf(sheets).title;
  }
  const read = await gadget.getPendingChanges(title);
  const { pending } = read.sheets;
  // A pending change may rename the sheet shown, and give another its title: it is the same sheet
  // by its ID, and is read again under the title it is to have.
  const renamed = pending.find(listed => listed.id === sheet?.id);
  if (renamed && renamed.title !== title) return { read: await gadget.getPendingChanges(renamed.title), title: renamed.title };
  const titled = pending.find(listed => listed.title === title);
  // One there already before one a change adds, which is empty until more is written to it.
  const saved = new Set(read.sheets.saved.map(listed => listed.id));
  const changed = pending.filter(listed => listed.touched && !listed.hidden && listed.rowCount);
  const touched = changed.find(listed => saved.has(listed.id)) ?? changed[0];
  if (sheet || !touched || touched === titled) return { read, title };
  return { read: await gadget.getPendingChanges(touched.title), title: touched.title };
}

// The sheet shown as the spreadsheet has it now, after a read of its changes failed: itself when
// it is still there, under the title it has now, and nothing when it is gone.
async function stillThere() {
  const { sheets } = await gadget.getSpreadsheet();
  return sheets.find(listed => listed.id === sheet.id);
}

async function load() {
  const current = ++generation;
  missed.hidden = true;
  if (loaded) status('Updating…');
  else showLoading();
  try {
    const { read, title } = await readChanges().catch(async error => {
      if (!sheet) throw error;
      const kept = await stillThere();
      // A read that failed for any other reason than the sheet's leaving is said, and tried again.
      if (current !== generation || kept?.title === sheet.title) throw error;
      // A sheet renamed is asked for by its new title, and one deleted is left for the first there is.
      sheet = kept;
      if (!kept) forget();
      return readChanges();
    });
    if (current !== generation) return;
    info = read;
    const { pending } = info.sheets;
    // The changes read are those of the sheet with this title, and no other's.
    const found = pending.find(listed => listed.title.toLowerCase() === title.toLowerCase());
    // A sheet a pending change deletes is no longer drawn: the first that stays is.
    if (!found) return void open(firstOf(pending));
    const resized = found.rowCount !== axes.rows.count || found.columnCount !== axes.columns.count;
    if (found.id !== sheet?.id || !loaded || resized) {
      axes = axesOf(found);
      shown = undefined;
      if (!loaded) scroller.scrollTo(0, 0);
    }
    sheet = found;
    windows = new Map();
    ringAreas();
    renderOutline();
    stripTitle.textContent = sheet.title;
    stripSize.textContent = `${sheet.rowCount.toLocaleString()} × ${sheet.columnCount.toLocaleString()}`;

    // A sheet is opened on the first of its changes, and a new change is what to look at.
    const fresh = rings.find(ring => ring.classList.contains('fresh'));
    const target = loaded ? fresh?.at : rings[0]?.at;
    const view = target
      ? { r0: Math.max(0, target.r0 - 4), r1: target.r0 + 30, c0: Math.max(0, target.c0 - 2), c1: target.c0 + 12 }
      : inView();
    await show(view, current, target);
    if (current !== generation) return;
    grid.classList.toggle('arriving', !loaded);
    showStale(info.changes.filter(change => change.stale).length, 'spreadsheet');
    showPage();
    renderOutline();
    status('');
    loaded = true;
    settled = current;
    misses = retryAt = 0;
    if (fresh) flash(fresh);
    void follow();
  } catch (error) {
    if (current !== generation) return;
    status('');
    // A sheet already drawn stays, with the failure said under it. Only one with nothing to
    // show gives the page over to the error.
    if (!loaded || !shown || !page.contains(scroller)) return showError(error, 'spreadsheet', load);
    settled = current;
    miss('This sheet could not be updated', load);
  }
}

export default {
  main(session) {
    gadget = session;
    loadOnRefresh(load);
  },
};
