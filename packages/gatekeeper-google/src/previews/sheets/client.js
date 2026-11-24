// The Google Sheets preview (GoogleSheetsGatekeeperImpl.getGadgetUi()): gadget-format client code
// that runs in the gadget UI frame, whose page starts it with main(gadget, host), at the end of
// this file. There `gadget` is a GoogleSpreadsheetSession rather than a gadget server.
// The gatekeeper imports it as text through client.txt, a symlink to this file, and returns it
// with window.js, which says what of a sheet to read, and ui/chrome.js, which the previews of
// this gatekeeper share.
//
// A sheet is drawn a window at a time, as readDrawing() returns it: a small sheet whole, a large
// one around what is in view, read again as the view moves. Everything the spreadsheet says is set
// as text or built node by node. Nothing from it is parsed as HTML into this document. A link is
// followed only by a click, in a new browser tab, from a cell Google Sheets has saved.

import {
  flash, fontReader, leaveOutline, lift, lineIcon, loadOnRefresh, make, miss, outlineList, page, reportSpot, setOutline, setStops,
  showError, showLoading, showPage, showStale, status, touch, ITSELF,
} from './ui/chrome.js';
import { MAX_CELLS, inView, laidOut, learnt, lines, readOn, smaller, starts, windowOf } from './window.js';

// The session main() is handed, which every read below goes through.
let gadget;
// Tells the host where the reader is, once main() has one to tell.
let saySpot = () => {};

// The headers' height and width.
const HEAD_H = 24;
const HEAD_W = 46;
// The most fonts read for one spreadsheet.
const MAX_FONTS = 24;

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
  /* A title the pending changes give the sheet is marked as what they write is. */
  #strip b.new { padding: 1px 6px; border-radius: 4px; background: var(--mark); color: var(--mark-ink); }
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

  /* What of the sheet is not drawn as it lies, said over it. */
  #limit { flex: none; margin: 0; padding: 6px 16px; border-bottom: 1px solid var(--line); color: var(--dim); font-size: 12px; }

  /* What is in view is kept where it is as its window arrives by the client, not the browser. */
  #scroll { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; overscroll-behavior: contain; scrollbar-width: thin;
    scrollbar-color: var(--line) transparent; }
  /* The sheet at its full size. What no window has drawn yet is left plain, since its rows and
     columns may be any size, and glimmers while it is read. */
  /* The last rows scroll clear of the Workshop's card for a change waiting. */
  #scroll::after { content: ''; display: block; height: var(--foot, 0px); }
  #sizer { position: relative; background: color-mix(in srgb, var(--head) 55%, var(--page)); }
  #sizer.reading { background: linear-gradient(90deg, transparent 20%, var(--page) 50%, transparent 80%) 0 0 / 640px 100%
    color-mix(in srgb, var(--head) 55%, var(--page)); animation: glimmer 1.6s linear infinite; }
  @keyframes glimmer { from { background-position: 0 0; } to { background-position: 640px 0; } }
  @media (prefers-reduced-motion: reduce) { #sizer.reading { animation: none; } }
  /* What is said of a view left short, in the middle of it. */
  #more { position: sticky; z-index: 8; top: 45%; left: 50%; width: max-content; margin: 0; padding: 5px 12px; translate: -50%;
    border-radius: 999px; background: var(--page); box-shadow: var(--float); color: var(--dim); font-size: 12px; pointer-events: none; }
  #more:empty { display: none; }
  /* The sheet and the marks over it arrive as one, or the marks would lie over its headers meanwhile. */
  #sizer.arriving { animation: arrive .25s ease-out; }
  .line { display: contents; }
  #grid { position: absolute; display: grid; font: 10pt/1.2 Arial, Helvetica, sans-serif; color: var(--ink); }
  /* A gridline left out has no width, so a border beside it is square at its end. */
  .bare .c { border-width: 0; }
  .c, .h { box-sizing: border-box; min-width: 0; min-height: 0; overflow: hidden;
    border-right: 1px solid var(--grid); border-bottom: 1px solid var(--grid); }
  .c { display: flex; align-items: flex-end; padding: 0 3px 1px; background: var(--page);
    white-space: pre; cursor: cell; }
  .c > span { min-width: 0; }
  .num { justify-content: flex-end; text-align: right; }
  .mid { justify-content: center; text-align: center; }
  .h { display: grid; place-items: center; position: sticky; z-index: 9; background: var(--head);
    border-color: var(--line); color: var(--head-ink); font-size: 11px; user-select: none;
    transition: background .12s, color .12s; }
  .h.col { top: 0; z-index: 10; } .h.row { left: 0; } .h.row.fr { z-index: 10; } .h.col.fc { z-index: 11; }
  .h.corner { top: 0; left: 0; z-index: 12; border-right: 3px solid var(--freeze); border-bottom: 3px solid var(--freeze); }
  /* The rows and columns a pending change touches, lit as those of a selection are. */
  .h.hit { background: var(--mark); color: var(--mark-ink); }
  .h.hit.col { box-shadow: inset 0 -2px 0 var(--mark-ink); }
  .h.hit.row { box-shadow: inset -2px 0 0 var(--mark-ink); }
  /* The lines a pending freeze takes into those kept in view, or lets go of, are striped, and
     the line that parts the frozen from the rest is drawn in the change's color. */
  .h.refrozen { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--mark-ink) 28%, transparent) 0 3px,
    transparent 3px 7px), var(--mark); color: var(--mark-ink); }
  .refrozen-rows :is(.fr-edge, .h.corner) { border-bottom-color: var(--mark-ink) !important; }
  .refrozen-columns :is(.fc-edge, .h.corner) { border-right-color: var(--mark-ink) !important; }
  /* Rows or columns a pending change resizes end on a dashed line, here and across the sheet. */
  .h.row.sized, .ring.sized.across { border-bottom: 2px dashed var(--mark-ink); }
  .h.col.sized, .ring.sized.down { border-right: 2px dashed var(--mark-ink); }
  /* And stay dashed where they are the last a sheet keeps in view. */
  .h.row.sized.fr-edge { border-bottom-style: dashed !important; }
  .h.col.sized.fc-edge { border-right-style: dashed !important; }
  .h.on { background: var(--pick-tint); color: var(--pick); font-weight: 700; }
  /* Rows or columns hidden just before this one. */
  .h.col.jump { box-shadow: inset 3px 0 0 var(--freeze); }
  .h.row.jump { box-shadow: inset 0 3px 0 var(--freeze); }
  /* Frozen rows and columns stay where they are while the rest scrolls under them, and the cells
     frozen both ways while those scroll under them. Each of the three has the rings among it
     over it (.held, below): over its text that runs on too. */
  .fr, .fc { position: sticky; z-index: 3; } .fr.fc { z-index: 6; }
  /* The last of them is named by its side: a cell can be in a frozen row and the last frozen column. */
  .fr-edge { border-bottom: 3px solid var(--freeze) !important; }
  .fc-edge { border-right: 3px solid var(--freeze) !important; }
  /* The shadow the frozen lines cast on what scrolls under them. */
  .cast { position: sticky; z-index: 3; pointer-events: none; }
  .cast.fr { align-self: start; height: 6px; background: linear-gradient(var(--shade), transparent); }
  .cast.fc { justify-self: start; width: 6px; background: linear-gradient(90deg, var(--shade), transparent); }
  /* Text too long for its cell runs on over the empty ones beside it. */
  .over { position: relative; z-index: 1; overflow: visible; }
  .fr.over, .fc.over { position: sticky; z-index: 4; } .fr.fc.over { z-index: 7; }
  .over > span { position: absolute; top: 0; bottom: 0; display: flex; align-items: inherit;
    justify-content: inherit; padding: inherit; overflow: hidden; pointer-events: none; }
  .link { color: inherit; }
  .box { flex: none; box-sizing: border-box; display: grid; place-items: center; width: 15px; height: 15px;
    margin: 0 auto 2px; border: 2px solid var(--dim); border-radius: 2px; color: var(--page); }
  .box.ticked { border-color: var(--pick); background: var(--pick); }
  .drop::after { content: ''; flex: none; margin: 0 0 5px auto; border: 4px solid transparent;
    border-top-color: var(--dim); border-bottom: 0; }
  .note { --note: linear-gradient(225deg, var(--ink) 4px, transparent 4px); background-image: var(--note); }
  .sift::after { content: ''; flex: none; width: 9px; height: 7px; margin: 0 0 4px auto;
    background: var(--dim); clip-path: polygon(0 0, 100% 0, 62% 55%, 62% 100%, 38% 100%, 38% 55%); }
  .picked { box-shadow: inset 0 0 0 2px var(--pick); }

  /* What a pending change did. A changed cell is tinted and keeps its change at hand. */
  .c { --corner: linear-gradient(135deg, var(--mark-ink) 5px, transparent 5px); }
  .c.new:not(.styled) { background: var(--corner), var(--mark) !important; color: var(--mark-ink) !important; }
  .c.cut { --corner: linear-gradient(135deg, var(--gone-ink) 5px, transparent 5px);
    background: var(--corner), var(--gone) !important; color: var(--gone-ink) !important;
    text-decoration: line-through color-mix(in srgb, currentColor 55%, transparent); }
  /* Only Google Sheets can say what a formula comes to, so it shows as its text. */
  .c.new.formula { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9pt; font-style: normal; }
  .c.new.formula:not(.styled) { background: var(--corner), repeating-linear-gradient(135deg,
    color-mix(in srgb, var(--mark-ink) 9%, transparent) 0 4px, transparent 4px 8px), var(--mark) !important; }
  /* One the changes may alter and do not write shows what is saved, and the corner's edge alone.
     The mark of a note it holds stays, as under the corner of the next. */
  .may { background-image: linear-gradient(135deg, transparent 3px, var(--mark-ink) 3px 5px, transparent 5px), var(--note, none) !important; }
  /* A cell a change formats keeps its own look, and the corner, also where it is written: the
     tint would hide the fill and the color it is given. So does one merged or unmerged and not written. */
  .styled { background-image: var(--corner), var(--note, none) !important; }
  /* One it writes, too, is underlined: what it holds is as pending as its look. */
  .c.new.styled { background-image: var(--corner), linear-gradient(0deg, var(--mark-ink) 2px, transparent 2px), var(--note, none) !important; }
  .c:focus-visible { outline: 2px solid var(--link); outline-offset: -2px; }
  .band { background-color: color-mix(in srgb, var(--mark) 55%, var(--page)) !important; }
  .h.band { color: var(--mark-ink); font-weight: 700; }
  /* What is laid over the sheet, in four layers: one that scrolls with it, and one for each way
     frozen lines stay in view, on which a ring wholly among them stays over its cells. */
  #marks { position: absolute; inset: 0; display: grid; pointer-events: none; }
  #marks > div { grid-area: 1 / 1; }
  .held { position: sticky; z-index: 5; }
  .held.rows { top: 0; height: 0; }
  .held.columns { left: 0; width: 0; }
  .held.rows.columns { z-index: 8; }
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
  /* A resize is its dashed line alone, and a freeze shows in the headers: its ring is where the
     navigator stops. */
  .ring:is(.sized, .frozen) { border-width: 0; border-radius: 0; box-shadow: none; }
  /* How many went, said in the headers on the line, where it stays in view: small enough to
     stand between two rows' numbers. */
  .tag { position: absolute; pointer-events: none; }
  .tag.across { left: 0; width: 100%; height: 0; z-index: 9; }
  .tag.down { top: 0; height: 100%; width: 0; z-index: 10; }
  /* On a line among the frozen ones, which does not scroll: over their headers. */
  .tag.stuck { position: sticky; }
  .tag.across.stuck { z-index: 10; } .tag.down.stuck { z-index: 11; }
  .tag > span { position: sticky; left: 2px; top: 4px; display: block; width: max-content; padding: 0 4px; border-radius: 999px;
    background: var(--gone-ink); color: var(--page); font-size: 8px; font-weight: 700; line-height: 11px;
    white-space: nowrap; transform: translateY(-50%); pointer-events: auto; }
  .tag.down > span { transform: translateX(-50%); }
  .ring.here { box-shadow: 0 0 0 5px color-mix(in srgb, currentColor 30%, transparent); color: var(--mark-ink); }
  .ring.gone.here, .ring.cleared.here { color: var(--gone-ink); }
  /* What the sheet holds that is not drawn, where it is: the cells under it are still pointed at. */
  .chart { position: absolute; z-index: 2; box-sizing: border-box; display: grid; place-content: center;
    pointer-events: none;
    justify-items: center; gap: 6px; padding: 12px; border: 1px dashed var(--line); border-radius: 6px;
    background: color-mix(in srgb, var(--page) 88%, transparent); color: var(--dim); font-size: 12px;
    text-align: center; overflow: hidden; }

  /* The card that says what a pending change did to the cell under the pointer. */
  #peek { position: fixed; z-index: 13; max-width: 300px; padding: 10px 12px; border-radius: 10px;
    background: var(--page); box-shadow: var(--float); font-size: 12px; line-height: 1.45;
    animation: arrive .12s ease-out; }
  /* The pointer crosses from the cell to its card without leaving either. */
  #peek::before { content: ''; position: absolute; inset: -8px 0; z-index: -1; }
  #peek h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 11px; font-weight: 700;
    letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  #peek h3::before { content: ''; flex: none; width: 6px; height: 6px; margin: 0 1px 0 3px; border-radius: 50%;
    background: var(--mark-ink); box-shadow: 0 0 0 3px var(--mark); }
  #peek h3 i { margin-left: auto; padding: 0 6px; border-radius: 4px; background: var(--chip); color: var(--ink);
    font-style: normal; letter-spacing: 0; }
  /* What the cell held, and what it will hold. */
  #peek .swap { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px; }
  #peek .swap > span { max-width: 100%; max-height: 5.8em; overflow: auto; overflow-wrap: anywhere;
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
// One rule for each format of the window drawn, which its cells are classed by.
const lookSheet = document.createElement('style');

// The page's parts, which build() makes when main() starts the preview.
let strip, stripTitle, stripSize, stripAt, stripText, limit, scroller, sizer, more, grid, marks, layers, peek, dark, canvas;

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
// The sheet's rows and columns (window.js): how many there are, and the size of each one a window
// has shown. One not yet seen is taken to be as Google Sheets makes it.

const axesOf = ({ rowCount, columnCount }) => ({ rows: lines(rowCount, 21), columns: lines(columnCount, 100) });

// ---------------------------------------------------------------------------------------------
// Looks: the spreadsheet's own fonts, colors, alignment and borders

const COLOR = /^#[0-9a-f]{6}$/i;
// The only links followed: a cell can hold any address, a script's included.
const WEB = /^https?:\/\//i;
const SERIF = /times|georgia|garamond|merriweather|playfair|lora|cambria|baskerville|slab|serif(?! ?pro)/i;
const MONO = /mono|courier|consolas|source code|menlo/i;

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

// How wide `text` is in a cell of `format`, padding included: as wide as the widest of its lines,
// which a canvas would measure as one.
function widthOf(text, format = {}) {
  canvas.font = `${format.italic ? 'italic ' : ''}${format.bold ? 700 : 400} ${format.fontSize ?? 10}pt ` +
    fontStack(format.fontFamily ?? 'Arial');
  return Math.max(...text.split('\n').map(line => canvas.measureText(line).width)) + 7;
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
  if (track.edge) node.classList.add(across ? 'fc-edge' : 'fr-edge');
}

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
      // A formula still to be worked out is shown as its text, as is one that fails: neither has
      // a tick to show.
      const ticks = cell?.holds?.includes('checkbox') && !look?.includes('formula') && cell.kind !== 'error';
      if (ticks) {
        const box = node.appendChild(make('span', text === 'TRUE' ? 'box ticked' : 'box'));
        Object.assign(box, { role: 'img', ariaLabel: text === 'TRUE' ? 'Checked' : 'Unchecked' });
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
      // A merged cell is named by the cell it starts on, wherever that is.
      const at = { row: merge?.row ?? row.number - 1, column: merge?.column ?? column.number - 1 };
      const joined = areaAt(at.row, at.column, ...MERGES);
      if ((cell?.formatted && look !== 'cut') || (joined && !look)) node.classList.add('styled');
      else if (cell?.pending && !look) node.classList.add('may');
      if (row.inserted || column.inserted) node.classList.add('band');
      // A cell a change touches can be reached with the keyboard, which shows its card: one of
      // them by Tab, and the others from it with the arrow keys.
      if (look || cell?.formatted || cell?.pending || joined) {
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

      node.at = { ...at, cell };
      nodes.set(cellName(node.at.row, node.at.column), node);
      blank[c] = !merge && !text && cell?.text !== '' && !cell?.holds?.includes('checkbox');
      // A tick box is no text to run on over the cells beside it.
      drawn[c] = { node, text: ticks ? '' : text, format, cell, merge, width: column.size };
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
  // The cell the keyboard was on, or on the link in, is the same cell in the next window.
  const active = grid.contains(document.activeElement) && document.activeElement;
  const focused = active && active.closest('.c')?.at;
  grid.replaceChildren(...parts);
  // Where the window lies is drawWindow()'s to say, and stays as it was when the same one is drawn again.
  shown = { ...shown, drawing, rows, columns, nodes, head };
  // A cell no change touches any longer leaves the stop, and the keyboard, to the first one does.
  const stop = [nodes.get(reached), grid.querySelector('.c[tabindex]')].find(node => node?.hasAttribute('tabindex'));
  stopOn(stop);
  const held = focused && nodes.get(cellName(focused.row, focused.column));
  const link = active.localName === 'a' && held?.querySelector('a');
  if (held) (link || (held.hasAttribute('tabindex') ? held : stop))?.focus({ preventScroll: true });
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
function moveAmong(event) {
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
}

// Lets text too long for its cell run on over the empty cells beside it, as Google Sheets does
// for text that neither wraps nor is clipped, and takes the gridlines it crosses away. It stops
// where the frozen columns end: what scrolls would pass under text that does not.
function overflow(drawn, blank, columns) {
  const frozen = n => columns[n].sticks !== undefined;
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
      for (let n = c + step; wanted > 0 && blank[n] && frozen(n) === frozen(c) && columns[n].number === columns[n - step].number + step; n += step) {
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
  const { frozenRowCount = 0, frozenColumnCount = 0 } = shown.drawing.sheet;
  const rows = starts(axes.rows);
  const columns = starts(axes.columns);
  const merges = shown.drawing.merges.map(rectOf);
  const lying = layers.map(() => []);
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
    // Frozen cells do not scroll, so a ring wholly among them is laid where it stays over them.
    ring.held = (r1 <= frozenRowCount) + 2 * (c1 <= frozenColumnCount);
    if (ring.tag) {
      Object.assign(ring.tag.style, across ? { top: ring.style.top } : { left: ring.style.left });
      ring.tag.classList.toggle('stuck', Boolean(ring.held & (across ? 1 : 2)));
    }
    lying[ring.held].push(ring);
  }
  layers.forEach((layer, n) => layer.replaceChildren(...lying[n]));
}

const sized = list => list.reduce((sum, line) => sum + line.size, 0);
// How far the frozen lines drawn reach.
const stuck = list => sized(list.filter(line => line.sticks !== undefined));

// Steps to a ring. Along frozen lines it is among, it is in view wherever the sheet is scrolled
// to, as it is the way it runs the sheet's whole length (columns inserted, rows resized), so the
// sheet scrolls only the other way: to bring it to the middle of what shows past the frozen
// lines, or its start there when it is larger than that. To one past what is drawn the step is
// made at once, and again as its window is drawn (follow()): the lines read on the way of a
// smooth one may be other sizes than they were taken for, which stops it short.
function reveal(ring, options) {
  const { r0, r1, c0, c1 } = ring.at;
  const still = ring.held | (r1 - r0 >= axes.rows.count) | 2 * (c1 - c0 >= axes.columns.count);
  const far = (!(still & 1) && (r1 <= shown.r0 || r0 >= shown.r1)) || (!(still & 2) && (c1 <= shown.c0 || c0 >= shown.c1));
  aim = far ? [ring, options] : undefined;
  const behavior = far ? 'instant' : options.behavior;
  if (!still) return Element.prototype.scrollIntoView.call(ring, { ...options, behavior });
  const to = (side, length, lead) =>
    ring[`offset${side}`] - lead - Math.max(0, (scroller[`client${length}`] - lead - ring[`offset${length}`]) / 2);
  scroller.scrollTo({
    ...still & 1 ? {} : { top: to('Top', 'Height', HEAD_H + stuck(shown.rows)) },
    ...still & 2 ? {} : { left: to('Left', 'Width', HEAD_W + stuck(shown.columns)) },
    behavior,
  });
}

// What a resize or a freeze says in the headers of its lines.
const said = ({ op, size, frozen }) => frozen
  ? `${frozen.after > frozen.before ? 'Frozen' : 'Unfrozen'} by a pending change: ` +
    `${plural(frozen.after, frozen.axis === 'rows' ? 'row' : 'column')} frozen, ${frozen.before} before`
  : `${op === 'resizeRows' ? 'Height' : 'Width'} set to ${size} px by a pending change`;

// Lights the headers of the rows and columns the changes touch. Rows inserted, resized or frozen
// run the sheet's whole width and say nothing of its columns, as columns say nothing of its
// rows; and deleted ones have no header left.
function lightHeads() {
  for (const area of info.areas) {
    const { op, range, size, frozen } = area;
    if (op.startsWith('delete')) continue;
    const { r0, r1, c0, c1 } = rectOf(range);
    const along = frozen?.axis ?? (op.endsWith('Rows') ? 'rows' : op.endsWith('Columns') ? 'columns' : undefined);
    const lit = [
      ...along === 'columns' ? [] : within(shown.rows, r0, r1).map(line => [shown.head.row[line.at], line.number === r1]),
      ...along === 'rows' ? [] : within(shown.columns, c0, c1).map(line => [shown.head.column[line.at], line.number === c1]),
    ];
    for (const [head, last] of lit) {
      head.classList.add(frozen ? 'refrozen' : 'hit');
      if (!frozen && size === undefined) continue;
      // Beside what the header says already, of this line or of an earlier change to it.
      head.title = [head.title, said(area)].filter(Boolean).join('\n');
      // The dashed line of a resize is under the last of its rows, or after the last of its columns.
      if (!frozen && last) head.classList.add('sized');
    }
  }
  for (const axis of ['rows', 'columns']) grid.classList.toggle(`refrozen-${axis}`, info.areas.some(({ frozen }) => frozen?.axis === axis));
}

// How an area is ringed, where not as cells written are: what goes in red, a resize as the line
// its rows or columns end on, and a freeze not at all.
const RINGS = {
  deleteRows: 'ring gone', deleteColumns: 'ring gone', clearRange: 'ring cleared',
  resizeRows: 'ring sized across', resizeColumns: 'ring sized down', freeze: 'ring frozen',
};

// The rings of `areas`, and what each goes by. One the last drawing did not ring is fresh.
function ringsOf(areas) {
  const fresh = loaded ? ringed : undefined;
  const keys = new Set();
  const tagged = new Map();
  const made = areas.map(({ change, op, range, count, after }) => {
    const key = `${change}\u0000${op}\u0000${range}`;
    const gone = op.startsWith('delete');
    const ring = make('div', RINGS[op] ?? 'ring');
    Object.assign(ring, { at: rectOf(range), after, cut: gone ? op : undefined, scrollIntoView: options => reveal(ring, options) });
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
    keys.add(key);
    return ring;
  });
  return { made, keys };
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

// The latest area of one of the kinds `ops` that holds the cell at `row` and `column`.
const areaAt = (row, column, ...ops) => info.areas.findLast(area => ops.includes(area.op) && holdsCell(area.range, row, column));
const MERGES = ['mergeCells', 'unmergeCells'];

// Which of the pending changes one is, counted as the person sees them listed.
const nameOf = id => {
  const at = info.changes.findIndex(change => change.id === id);
  return at < 0 ? 'Pending change' : `Pending change ${at + 1} of ${info.changes.length}`;
};

// One side of a before and after: what the cell holds, or that it holds nothing.
const side = (text, look) => text === undefined || text === '' ? make('span', 'none', 'empty') : make('span', look, text);

function describe({ row, column, cell }) {
  const format = areaAt(row, column, 'formatCells');
  const joined = areaAt(row, column, ...MERGES);
  if (cell?.change === undefined && !cell?.pending && !(cell?.formatted && format) && !joined) return;
  const card = make('div');
  const title = card.appendChild(make('h3', '', nameOf(cell?.change ?? format?.change ?? joined?.change)));
  title.append(make('i', '', cellName(row, column)));
  if (cell?.change !== undefined) {
    const swap = card.appendChild(make('div', 'swap'));
    swap.append(side(cell.saved, 'was'), make('span', 'to', '→'),
      side(cell.entered === null ? undefined : String(cell.entered), 'now'));
    if (cell.pending) card.append(make('p', '', 'Google Sheets works out what it shows once the change is saved.'));
  } else if (cell?.pending) {
    title.firstChild.data = 'May change';
    card.append(make('p', '', 'This shows what is saved. The pending changes may alter it.'));
  }
  if (cell?.formatted && format) {
    const formats = info.changes.find(change => change.id === format.change)?.changes
      .filter(change => change.op === 'formatCells') ?? [];
    // What its batch set on this cell. A batch names each range as it lay when it was made, so
    // where later changes have moved the cell out of them all, all that it set is named.
    const over = formats.filter(change => holdsCell(change.range, row, column));
    const set = new Set((over.length ? over : formats).flatMap(change => Object.keys(change.format)));
    const line = card.appendChild(make('p', '', 'Formatting set: '));
    line.append(make('b', '', [...set].map(field => FIELDS[field] ?? field).join(', ') || 'changed'));
  }
  if (joined) {
    card.append(make('p', '', joined.op === 'mergeCells'
      ? 'Merged: a merged cell keeps what its first cell holds.' : 'Unmerged into separate cells.'));
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

// The card of the cell that has the focus, where the grid has been drawn again or scrolled under
// it: one the pointer opened is closed.
const peekFocused = () => showPeek(document.activeElement.closest('.c'));

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

// Lists `sheets`, as saved and as the pending changes leave them, with `opened` the one shown.
function renderOutline(sheets = info.sheets, opened = sheet) {
  const tabs = tabsOf(sheets);
  // The sheet whose name holds the keyboard: the name drawn in its place is to hold it again.
  const held = document.activeElement?.dataset.sheet;
  const listing = ({ sheet: listed, added, renamed, moved, deleted }) => {
    const on = listed.id === opened.id && !deleted;
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
  lift(changed.length > 0);
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
// The windows Google or the session refused as too large since then, each with its refusal: one
// would be refused again, so it is asked for once.
let refused = new Map();
// The most cells a window asks for, which a read refused as too large lowers and a view moved
// past what is drawn raises again (window.js); how many reads in a row have failed as the sheet
// was scrolled; and when the next may be tried.
let room = MAX_CELLS;
let misses = 0;
// Whether the last refresh failed: its note stays until the sheet is read anew.
let behind = false;
let retryAt = 0;
const TOO_LARGE = /fewer cells|too large|exceeded the|may draw at most/i;
const FROZEN = { rows: 'frozenRowCount', columns: 'frozenColumnCount' };

// How much of the view scrolls each way, past the headers: as with nothing said over the sheet,
// or what is said there of its frozen lines would take the room it says they have not.
const pane = () => ({
  rows: (scroller.clientHeight + limit.offsetHeight || page.clientHeight) - HEAD_H, columns: (scroller.clientWidth || page.clientWidth) - HEAD_W,
});

// Where the view is scrolled to; and its place and size, which were `rested` when the last read
// on was asked for or its window drawn: once they are not, its reader has moved it since.
const where = () => ({ rows: scroller.scrollTop, columns: scroller.scrollLeft });
const place = () => `${Object.values(where())} ${Object.values(pane())}`;
let rested;
// The ring stepped to past what is drawn, and how, until the window there is read (reveal()).
let aim;

// The sheet `of`, whose lines are `known`, as window.js takes it.
const laid = (of = sheet, known = axes) => laidOut(known, { rows: of.frozenRowCount ?? 0, columns: of.frozenColumnCount ?? 0 }, pane());

// Reads the window around `view` of the sheet `of`, whose lines are `known`: which cells, the
// axes whose frozen lines are `cut`, drawn as lines that scroll, and those the window is asked
// for `without` (windowOf()). `lacks` names the ways the read before left the view short. One
// refused as too large is asked for again as a smaller one, where there is one.
async function readWindow(view, current, of = sheet, known = axes, lacks = []) {
  const lay = laid(of, known);
  // A sheet that is a chart alone has no cells to read.
  if (!of.rowCount) return { ...windowOf(lay, view), drawing: { sheet: of, rows: [], columns: [], cells: [], formats: [], merges: [] } };
  for (;;) {
    const at = windowOf(lay, view, room, lacks);
    const range = `${quoted(of.title)}!${cellName(at.r0, at.c0)}:${cellName(at.r1 - 1, at.c1 - 1)}`;
    const read = `${range} ${at.without}`;
    try {
      if (refused.has(read)) throw refused.get(read);
      if (!windows.has(read)) windows.set(read, gadget.readDrawing(range, at.without));
      // Only the last few windows are kept: a long scroll would otherwise keep every one it passed.
      if (windows.size > 8) windows.delete(windows.keys().next().value);
      return { ...at, drawing: await windows.get(read) };
    } catch (error) {
      windows.delete(read);
      const large = current === generation && TOO_LARGE.test(error?.message);
      if (large) refused.set(read, error);
      const less = large && smaller(lay, view, room, lacks);
      if (!less) throw error;
      room = less;
    }
  }
}

// Draws a window read, keeping what is in view where it is, or with `target` in view. `chain` is
// how many reads on end it is of (readOn()).
function drawWindow({ drawing: read, r0, r1, c0, c1, cut, chain }, target) {
  // A reader who moved the view while this was read has moved it since the read before.
  const moved = place() !== rested;
  // Frozen lines cut are drawn as the sheet's other lines are, which is said over the sheet.
  const drawing = cut.length === 0 ? read
    : { ...read, sheet: { ...read.sheet, ...Object.fromEntries(cut.map(axis => [FROZEN[axis], 0])) } };
  limit.hidden = cut.length === 0;
  if (cut.length) {
    const counts = cut.map(axis => sheet[FROZEN[axis]]);
    const one = counts.length === 1 && counts[0] === 1;
    // A freeze that waits to be applied is not said as the sheet's own.
    const was = info.sheets.saved.find(listed => listed.id === sheet.id);
    const waits = cut.some((axis, n) => (was?.[FROZEN[axis]] ?? 0) !== counts[n]);
    const frozen = cut.map((axis, n) => `${counts[n].toLocaleString()} ${counts[n] === 1 ? axis.slice(0, -1) : axis}`).join(' and ');
    limit.textContent = `${waits ? 'With its pending changes, this' : 'This'} sheet freezes ${frozen}. ` +
      `There is no room to keep ${one ? 'it' : 'them'} in view here, so ${one ? 'it scrolls' : 'they scroll'} with the rest.`;
  }
  // The lines above and before the view may turn out other sizes than they were taken to be.
  const held = learnt(laid(), room, where(), drawing);
  draw(drawing);
  lightHeads();
  Object.assign(shown, { r0, r1, c0, c1, cut, chain });
  // The frozen lines a window leaves out are drawn before it, and stick from there.
  Object.assign(grid.style, {
    top: `${starts(axes.rows)[r0] - sized(shown.rows.filter(line => line.number <= r0))}px`,
    left: `${starts(axes.columns)[c0] - sized(shown.columns.filter(line => line.number <= c0))}px`,
  });
  Object.assign(sizer.style, {
    width: `${HEAD_W + starts(axes.columns)[axes.columns.count]}px`, height: `${HEAD_H + starts(axes.rows)[axes.rows.count]}px`,
  });
  marks.replaceChildren(...layers, ...rings.flatMap(ring => ring.tag ?? []), ...(drawing.charts ?? []).map(chartBox));
  if (!page.contains(scroller)) page.replaceChildren(strip, limit, scroller, peek);
  scroller.style.scrollPadding = `${HEAD_H + stuck(shown.rows) + 8}px 8px calc(8px + var(--foot, 0px)) ${HEAD_W + stuck(shown.columns) + 8}px`;
  placeRings();
  if (target) {
    // Clear of the frozen lines, which lie over what scrolls.
    scroller.scrollTo(Math.max(0, starts(axes.columns)[target.c0] - stuck(shown.columns) - 120),
      Math.max(0, starts(axes.rows)[target.r0] - stuck(shown.rows) - 90));
  } else if (Math.abs(held.rows - scroller.scrollTop) >= 1 || Math.abs(held.columns - scroller.scrollLeft) >= 1) {
    // Only where it is not there already: a step on its way to a change is not stopped for nothing.
    scroller.scrollTo(held.columns, held.rows);
  }
  pick(picked);
  peekFocused();
  rested = moved ? undefined : place();
  // Text runs on over empty cells as far as it is wide, so a font that arrives is drawn again.
  // Whichever window is drawn by then: a later one asked for no font that was already on its way.
  readFonts(drawing).then(arrived => {
    if (!arrived || !shown) return;
    draw(shown.drawing);
    lightHeads();
    peekFocused();
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

// Reads on as the view nears the edge of the window drawn. `retry` is set when asked for by hand.
async function follow(retry) {
  // Nothing is read on for a page that is not shown, whose view has no size, or while a load is
  // putting another sheet, or other changes, in place.
  if (reading || settled !== generation || !shown || page.hidden || !scroller.clientWidth) return;
  // Nor while what is drawn holds the view, or is all that is read of one its reader has not
  // moved (readOn()): a view left short says so, since it is read on only once it is scrolled.
  const [to, step] = [aim, readOn(laid(), where(), shown, room, place() !== rested)];
  aim = undefined;
  // Said anew only when it changes: it is read out to those who do not see it.
  const note = step.short ? 'Not read this far yet. Scroll to read on.' : '';
  if (more.textContent !== note) more.textContent = note;
  if (!step.view) return;
  // A read that failed is not tried again at once: the next scroll after a while tries it.
  // One asked for by hand asks again for what was refused, too.
  if (retry === true) refused.clear();
  else if (Date.now() < retryAt) return;
  const current = generation;
  [rested, room, reading] = [place(), step.room, true];
  sizer.classList.add('reading');
  status('Reading…');
  // A window that cannot be drawn is, to its reader, one that could not be read.
  const drew = await readWindow(step.view, current, sheet, axes, step.lacks)
    // One read by a title another sheet has since taken is not this sheet's: the sheets are listed anew.
    .then(read => current === generation && (read.drawing.sheet.id === sheet.id ? drawWindow({ ...read, chain: step.chain }) : void load()))
    .then(() => true, () => false);
  reading = false;
  sizer.classList.remove('reading');
  // A load that finished meanwhile left its own reading on to this.
  if (current !== generation) return void follow();
  status('');
  if (drew) {
    if (!behind) miss();
    misses = 0;
    // The step is made again only where the view was not moved while its window was read.
    if (to && rested) reveal(...to);
    return void follow();
  }
  // What is drawn stays: the failure is said under it.
  retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** misses++);
  if (!behind) miss('More of this sheet could not be read', () => follow(true));
}

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

// The sheet the host sent this to, by its ID as an anchor, until a sheet is read.
let sent;

// The pending changes of the sheet `of`. With none, on opening, that is the sheet the host sent
// this to, or else the first sheet the changes touch, or the first there is.
async function readChanges(of) {
  let title = of?.title;
  let asked;
  if (title === undefined) {
    const { sheets } = await gadget.getSpreadsheet();
    asked = sheets.find(listed => String(listed.id) === sent && listed.rowCount);
    title = (asked ?? firstOf(sheets)).title;
  }
  const read = await gadget.getPendingChanges(title);
  const { pending } = read.sheets;
  // A pending change may rename the sheet shown or asked for, and give another its title: it is
  // the same sheet by its ID, and is read again under the title it is to have.
  const renamed = pending.find(listed => listed.id === (of ?? asked)?.id);
  if (renamed && renamed.title !== title) return { read: await gadget.getPendingChanges(renamed.title), title: renamed.title };
  const titled = pending.find(listed => listed.title === title);
  // One there already before one a change adds, which is empty until more is written to it.
  const saved = new Set(read.sheets.saved.map(listed => listed.id));
  const changed = pending.filter(listed => listed.touched && !listed.hidden && listed.rowCount);
  const touched = changed.find(listed => saved.has(listed.id)) ?? changed[0];
  if (of || asked || !touched || touched === titled) return { read, title };
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
  miss();
  if (loaded) status('Updating…');
  else showLoading();
  try {
    const { read, title } = await readChanges(sheet).catch(async error => {
      if (!sheet) throw error;
      const kept = await stillThere();
      // A read that failed for any other reason than the sheet's leaving is said, and tried again.
      if (current !== generation || kept?.title === sheet.title) throw error;
      // A sheet renamed is asked for by its new title, and what is drawn stays the sheet shown
      // until its window is read. One deleted is left for the first there is.
      if (!kept) {
        sheet = undefined;
        forget();
      }
      return readChanges(kept);
    });
    if (current !== generation) return;
    const { saved, pending } = read.sheets;
    // The changes read are those of the sheet with this title, and no other's.
    const found = pending.find(listed => listed.title.toLowerCase() === title.toLowerCase());
    // A sheet a pending change deletes is no longer drawn: the first that stays is.
    if (!found) return void open(firstOf(pending));
    const same = loaded && found.id === sheet.id && found.rowCount === axes.rows.count && found.columnCount === axes.columns.count;
    const known = same ? axes : axesOf(found);
    const { made, keys } = ringsOf(read.areas);
    // A sheet is opened on the first of its changes, and a new change is what to look at.
    const fresh = made.find(ring => ring.classList.contains('fresh'));
    const target = loaded ? fresh?.at : made[0]?.at;
    const view = target
      ? { r0: Math.max(0, target.r0 - 4), r1: target.r0 + 30, c0: Math.max(0, target.c0 - 2), c1: target.c0 + 12 }
      : inView(laid(found, known), room, where());
    [windows, refused] = [new Map(), new Map()];
    // A sheet being opened has nothing drawn to keep: the sheets are listed at once, for another
    // to be opened should the read of this one fail.
    if (!loaded) renderOutline(read.sheets, found);
    const drawn = await readWindow(view, current, found, known);
    if (current !== generation) return;

    // What was read takes the place of what is drawn only now that its window is read: a read
    // that fails leaves the sheet drawn, with its own changes, rings and places to stop at.
    [info, sheet, axes, rings, ringed] = [read, found, known, made, keys];
    sent = undefined;
    if (!same) shown = undefined;
    if (!loaded) scroller.scrollTo(0, 0);
    setStops(rings.map(ring => [ring]));
    const was = saved.find(listed => listed.id === sheet.id);
    stripTitle.textContent = sheet.title;
    stripTitle.title = !was ? 'Added by a pending change'
      : was.title === sheet.title ? '' : `Renamed from “${was.title}” by a pending change`;
    stripTitle.classList.toggle('new', stripTitle.title !== '');
    stripSize.textContent = sheet.rowCount ? `${sheet.rowCount.toLocaleString()} × ${sheet.columnCount.toLocaleString()}` : 'Chart';
    drawWindow(drawn, target);
    sizer.classList.toggle('arriving', !loaded);
    showStale(info.changes.filter(change => change.stale).length, 'spreadsheet');
    showPage();
    renderOutline();
    status('');
    loaded = true;
    settled = current;
    // What a refresh draws is where the view rests: its reader has not moved it, nor is stepping to a ring of before.
    [misses, retryAt, behind, rested, aim] = [0, 0, false, place()];
    if (fresh) flash(fresh);
    saySpot();
    void follow();
  } catch (error) {
    if (current !== generation) return;
    status('');
    // A sheet already drawn stays, with the failure said under it. Only one with nothing to
    // show gives the page over to the error.
    if (!loaded || !shown || !page.contains(scroller)) return showError(error, 'spreadsheet', load);
    // What was read for the sheet as it would have been is not of the one still drawn.
    [windows, refused, misses, retryAt, behind] = [new Map(), new Map(), 0, 0, true];
    settled = current;
    miss('This sheet could not be updated', load);
  }
}

// Makes the page's parts and listens to them. Called by main(), not on import: this module's own
// scope makes its two style elements and attaches nothing. ui/chrome.js builds the chrome the
// previews share when it is imported.
function build() {
  document.head.append(styleSheet, lookSheet);
  dark = matchMedia('(prefers-color-scheme: dark)');
  canvas = document.createElement('canvas').getContext('2d');
  strip = Object.assign(make('div'), { id: 'strip' });
  stripTitle = strip.appendChild(make('b'));
  stripSize = strip.appendChild(make('span', 'size'));
  stripAt = strip.appendChild(make('span', 'at'));
  stripText = strip.appendChild(make('span', 'fx'));
  limit = Object.assign(make('p'), { id: 'limit', hidden: true });
  scroller = Object.assign(make('div'), { id: 'scroll' });
  sizer = scroller.appendChild(Object.assign(make('div'), { id: 'sizer' }));
  more = sizer.appendChild(Object.assign(make('p'), { id: 'more', role: 'status' }));
  grid = sizer.appendChild(Object.assign(make('div'), { id: 'grid', role: 'grid' }));
  // The rings and labels laid over the sheet, and the layers its rings lie in: by which of the
  // sheet's frozen lines a ring is wholly among, its rows counting one and its columns two.
  marks = sizer.appendChild(Object.assign(make('div'), { id: 'marks' }));
  layers = ['', 'held rows', 'held columns', 'held rows columns'].map(name => make('div', name));
  peek = Object.assign(make('div'), { id: 'peek', hidden: true });

  // A window that arrives as the sheet is scrolled takes its place without moving.
  sizer.addEventListener('animationend', () => sizer.classList.remove('arriving'));
  grid.addEventListener('keydown', moveAmong);
  grid.addEventListener('click', event => {
    const node = event.target.closest('.c');
    if (node?.at) pick(cellName(node.at.row, node.at.column));
  });
  grid.addEventListener('pointerover', event => showPeek(event.target.closest('.c')));
  // The card stays while the pointer is on it.
  grid.addEventListener('pointerleave', event => peek.contains(event.relatedTarget) || showPeek());
  peek.addEventListener('pointerleave', () => showPeek());
  grid.addEventListener('focusin', event => {
    stopOn(event.target.closest('.c'));
    showPeek(event.target.closest('.c'));
  });
  grid.addEventListener('focusout', () => showPeek());
  scroller.addEventListener('scroll', () => {
    peekFocused();
    requestAnimationFrame(follow);
  }, { passive: true });
  // The card goes at Escape with the focus where it is.
  addEventListener('keydown', event => event.key === 'Escape' && showPeek());
  // The view is resized with its frame, and by the outline that opens beside it.
  new ResizeObserver(() => requestAnimationFrame(follow)).observe(scroller);
}

// ---------------------------------------------------------------------------------------------
// Where the reader is

// The sheet shown, in a spreadsheet of several, by its ID and under the title Google has saved
// for it, since a host shows it and tells an agent of it: a title can be changed, and a sheet
// only a change adds is no spot yet.
function here() {
  const saved = loaded && info.sheets.pending.length > 1 ? info.sheets.saved.find(listed => listed.id === sheet.id) : undefined;
  return saved && { anchor: String(sheet.id), label: saved.title };
}

// Shows the sheet `anchor` names (GadgetHost.onNavigate()). It is one here() gave, but may come
// from anywhere, so it only chooses what to show. False for a sheet no longer there, or one with
// no cells to draw: the reader stays on the sheet they are on, or starts where readChanges() does.
async function goTo(anchor) {
  if (!sheet) {
    sent = anchor;
    await load();
    // Not read, as when Google could not be reached: the sheet may well still be there.
    if (!loaded) return true;
  } else {
    const listed = info.sheets.pending.find(found => String(found.id) === anchor && found.rowCount);
    if (listed && listed.id !== sheet.id) await open(listed);
  }
  return String(sheet?.id) === anchor;
}

export default {
  async main(session, host) {
    gadget = session;
    build();
    saySpot = reportSpot(host, here);
    loadOnRefresh(load);
    // The host sends this to the sheet the reader left, if there is one, before anything is read:
    // the first sheet read is then that one.
    await host.onNavigate(goTo);
    if (!generation) void load();
  },
};
