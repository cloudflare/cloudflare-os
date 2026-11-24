// The Google Doc preview (GoogleDocGatekeeperImpl.getGadgetUi()): gadget-format client code that
// runs in the gadget UI frame, whose page starts it with main(gadget, host), at the end of this
// file. There `gadget` is a GoogleDocSession rather than a gadget server.
// The gatekeeper imports it as text through client.txt, a symlink to this file, and returns it
// with the modules beside it and ui/chrome.js, which the previews of this gatekeeper share.
//
// The tab is drawn as Google Docs draws it, on its pages: from its drawing (readDrawing()) what
// the pending changes leave alone, and from its pending drawing (readPendingDrawing()) the blocks
// they put in place of which of those, each set as the saved block it stands for or beside
// (merge.js).
//
// Everything the document says is set as text or built node by node. Nothing from it is parsed
// as HTML into this document. A link is followed only by a click: inside the document to a tab
// or a heading, and out to the web, in a new browser tab, from text Google Docs has saved.

import {
  addControl, dataUrl, flash, foldArrow, fontReader, ghostLines, leaveOutline, lift, lineIcon, loadOnRefresh, make, miss,
  motion, outline, outlineList, page, partNavigator, picking, press, quote, reportSpot, segmented, setOutline, setStops,
  showError, showPage, showStale, status, takesIn, touch, ITSELF,
} from './ui/chrome.js';
import { drawer, drawStyles, faceMeasures, showPicture } from './draw.js';
import { blockOf, excerpt, merge, plain, said } from './merge.js';
import { pageStyles, paginate } from './pages.js';

// The session main() is handed, which every read below goes through.
let gadget;
// Tells the host where the reader is, once main() has one to tell.
let saySpot = () => {};
// What the reader picked: a paragraph, told by the heading it is under and by its text, since a
// document names no paragraph, or a cell of a table, told as the session's table methods name one.
let picker;
// What is drawn of a pending change's own: the text it writes, the blocks and cells it adds, and
// a paragraph or a cell it edits wherever that is not drawn as saved, which reads there as the
// change leaves it though it only takes words away.
const UNSAVED = 'ins, .added, #sheets:not([data-view="before"]) :is(.para, td).changed';

// How far under the head of the frame a page stepped to stops.
const HEAD = 52;

const styleSheet = document.createElement('style');
styleSheet.textContent = `
  /* The scrollbar's room is kept, so a page that grows long does not change the width it is fitted to. */
  html { scrollbar-gutter: stable; }
  /* The sheets are laid out at their own size and then scaled to the room there is, so #page is
     the room they take once scaled. Clear, at the top, of the controls that float there. */
  #page { box-sizing: border-box; max-width: calc(100% - 24px); margin: 52px auto 96px; }
  /* Paper is light whatever the frame is, so what is marked on it is marked in the light's colors. */
  #sheets { transform-origin: 0 0; --mark: #e6f4ea; --mark-ink: #137333; --gone: #fce8e6;
    --gone-ink: #a50e0e; --edit: #f3e8fd; --edit-ink: #8430ce; --chip: #f1f3f4; --shine: #e8eaed; }
  .sheet.ghosted { box-sizing: border-box; padding: 72pt; }

  @media (max-width: 560px) { #nav > span { display: none; } #nav { padding-left: 3px; }
    #bar .views button { padding: 3px 8px; } }
  /* A page the page navigator steps to stops clear of the controls at the head of the frame. */
  .sheet { scroll-margin-top: ${HEAD}px; }

  /* A changed block carries a bar in the page's margin, and what changed in it is tinted: green
     for what it adds, red for what it removes, and purple where it edits or does both. The
     document's own colors stay, except where every change is read in place. */
  [data-does="added"] { --glow: var(--mark-ink); }
  [data-does="removed"] { --glow: var(--gone-ink); }
  [data-does="changed"] { --glow: var(--edit-ink); }
  /* What the reader picked: a dashed frame round a paragraph's text, clear of the space above
     and below it, faintly tinted, with the pale edge and the band a change's ring has in Slides.
     It lies over the paragraph, which keeps its own look. A cell is framed inside its borders.
     On paper, which is light in either theme. */
  .para.chosen::after { content: ''; position: absolute; z-index: 1; pointer-events: none;
    inset: calc(var(--above, 0px) - 5px) -5px calc(var(--below, 0px) - 5px);
    border: 1.5px dashed; border-radius: 6px; color: #1a73e8;
    background: color-mix(in srgb, currentColor 5%, transparent);
    box-shadow: 0 0 0 1px rgb(255 255 255 / .75), 0 0 0 4px color-mix(in srgb, currentColor 16%, transparent);
    animation: choose .2s ease-out; }
  td.chosen { outline: 1.5px dashed #1a73e8; outline-offset: -3px; }
  /* Where each change is marked in place, text selected reads as a pick does: without the words
     a change takes away. */
  .redline del { user-select: none; }
  /* A mark has no box to ring: it glows itself. */
  .omit { outline: none !important; }
  .grid:is(.added, .removed, .changed) { position: relative; }
  :is(.added, .removed, .changed):not(td, span, a)::before { content: ''; position: absolute; width: 2.5pt;
    left: calc(-1 * var(--in, 0pt) - 13pt); top: calc(var(--above, 0pt) + 1pt);
    bottom: calc(var(--below, 0pt) + 1pt); border-radius: 2pt; background: var(--glow);
    transition: box-shadow .2s ease-out; }
  /* In a table the cell says it: one that comes or goes is tinted, with all it holds, and one
     that is edited has the bar at its own edge, and what changed in it tinted. */
  td :is(.added, .removed, .changed)::before { content: none; }
  .grid.added td, td.added { background-color: var(--mark) !important; }
  .grid.removed td, td.removed { background-color: var(--gone) !important; }
  td.changed { box-shadow: inset 2.5pt 0 var(--edit-ink); }
  /* The tint is on the text, line by line and down to the next line, so it goes round an image
     the text is wrapped round as the text does. */
  ins, del { text-decoration-line: none; }
  ins, del, :is(.added, .removed) > :is(span, a):not(.lift, .row, .obj, .tick, .marker, .chip) {
    padding-bottom: calc(var(--l, 1.18em) - 1.18em); -webkit-box-decoration-break: clone;
    box-decoration-break: clone; }
  ins, :is(span, a).added, .added > :is(span, a):not(.lift, .row, .obj, .tick) { background-color: var(--mark); }
  del, :is(span, a).removed, .removed > :is(span, a):not(.lift, .row, .obj, .tick) { background-color: var(--gone); }
  .redline :is(ins, :is(span, a).added, .added > :is(span, a)) { color: var(--mark-ink); }
  .redline :is(del, :is(span, a).removed, .removed > :is(span, a), :is(.grid, td).removed :is(span, a)) { color: var(--gone-ink);
    text-decoration: line-through color-mix(in srgb, currentColor 55%, transparent); }
  /* What is no text says what a change does with it as words do: a chip, a footnote's mark or a
     page number in the tint, and what has no ground to tint in the ink: a line, a break where
     the page is read as one sheet, and an image, which is ringed and, read beside what takes
     its place, dimmed. */
  .pagebreak.came { color: var(--mark-ink); }
  .pagebreak.gone { color: var(--gone-ink); text-decoration: line-through; }
  .pagebreak:is(.came, .gone)::before, .pagebreak:is(.came, .gone)::after { border-color: currentColor; }
  .rule.added { border-top-color: var(--mark-ink); }
  .rule.removed { border-top-color: var(--gone-ink); }
  .obj.added { box-shadow: 0 0 0 2pt var(--mark-ink); }
  .obj.removed { box-shadow: 0 0 0 2pt var(--gone-ink); }
  .redline .obj.removed { opacity: .45; }
  /* The change the navigator is on. */
  .here::before { color: var(--glow); box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent); }

  /* Where the copy shown leaves something out: words, as a caret under the line, and whole
     paragraphs, as a wedge in the margin. Neither takes any room, so the page is set as it will be. */
  .tick { position: relative; cursor: pointer; }
  .tick::before { content: ''; position: absolute; left: -3.5pt; top: -1pt; border: 3.5pt solid transparent;
    border-top: 0; border-bottom: 4.5pt solid var(--gone-ink); }
  .omit { position: relative; height: 0; cursor: pointer; }
  .omit::before { content: ''; position: absolute; left: -13pt; top: -4pt; border: 4pt solid transparent;
    border-right: 0; border-left: 5pt solid var(--gone-ink); }
  .tick.came::before { border-bottom-color: var(--mark-ink); }
  /* A row or a column a table's copy leaves out is a seam on the border where it stood. */
  .grid td { position: relative; }
  .seam { position: absolute; z-index: 1; inset: -1.25pt 0 auto; height: 2.5pt; background: var(--gone-ink); }
  .seam.below { inset: auto 0 -1.25pt; }
  .seam:is(.before, .after) { inset: 0 auto 0 -1.25pt; width: 2.5pt; height: auto; }
  .seam.after { inset: 0 -1.25pt 0 auto; }
  .seam.came { background: var(--mark-ink); }
  .seam::before { content: none; }
  .omit.came::before { border-left-color: var(--mark-ink); }
  .omit.here::before, .omit.fresh::before { filter: drop-shadow(0 0 3px currentColor); }

  #outline .tab + #rail { margin: 4px 0 8px 14px; }
  /* One rail down the headings, and a thumb on it that slides to the one being read. */
  #rail { position: relative; border-left: 1px solid var(--line); }
  #thumb { position: absolute; top: 0; left: -2px; width: 3px; border-radius: 3px;
    background: var(--link); transition: transform .2s ease-out, height .2s ease-out; }
  /* Clear of the list's edges when the outline scrolls to the heading being read. */
  #rail .row { display: flex; align-items: center; scroll-margin: 8px 0; }
  .entry { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; padding: 5px 8px 5px 4px;
    border: 0; border-radius: 6px; background: none; color: var(--dim); line-height: 1.4;
    text-align: left; transition: background .12s, color .12s; }
  .entry.top { color: var(--ink); font-weight: 700; }
  .entry:hover { background: var(--chip); color: var(--ink); }
  .entry[aria-current="true"] { background: color-mix(in srgb, var(--link) 12%, transparent); color: var(--link); }
  .entry:focus-visible { outline-offset: -2px; }
  .entry > span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

/** What the sheets are set in, inside the room `page` keeps for them. */
const sheets = make('div');
sheets.id = 'sheets';

const rail = make('div');
rail.id = 'rail';
const thumb = make('div');
thumb.id = 'thumb';

// ---------------------------------------------------------------------------------------------
// What is loaded

let tabs = [];
let tabId = null;
// The ID the tab shown was chosen by, which is not its own where a tab added since was chosen by
// its provisional one.
let chosen;
let loaded = false;
let generation = 0;
// What the last drawing showed as changed, so the next one can tell what is new.
let shown = new Set();
// The tab shown: its drawing, the rows its pending changes make of its blocks, and the lists
// they make or change.
let tab;

/** Which copy is shown: the tab `after` its pending changes, `before` them, or both `inline`. */
let view = 'after';

// The most fonts read for one document, and the reader that brings them into this frame.
const MAX_FONTS = 24;
const fonts = fontReader((...font) => gadget.readFont(...font), MAX_FONTS, () => faceMeasures);

// Each tab's drawing as last read. Google Docs is asked for the whole document for one, so it is
// read again only for a tab whose pending drawing names another saving of the document.
const drawings = new Map();

async function readDrawing(id, version) {
  const held = drawings.get(id);
  if (held?.version && held.version === version) return held;
  const drawing = plain(await gadget.readDrawing(id));
  // Google names no saving to an account that may not edit: one that reads as the one held is it.
  if (held && !drawing.version && JSON.stringify(drawing) === JSON.stringify(held)) return held;
  drawings.set(id, drawing);
  return drawing;
}

/** Reads tab `id`: its drawing, what its pending changes put in place of which blocks of that, and those changes. */
async function read(id) {
  const listed = Promise.resolve(gadget.getPendingChanges(id));
  listed.catch(() => {});
  let pending = await gadget.readPendingDrawing(id);
  let drawing = await readDrawing(id, pending.version);
  // Read apart, the two may be of the document as it was saved at different times, and the edits
  // are then ranges of other blocks than these. The gatekeeper learns so from reading the
  // drawing, so its edits are asked for again, a few times: with either unnamed, nothing tells.
  const apart = () => !!drawing.version && !!pending.version && drawing.version !== pending.version;
  let again = 0;
  for (; again < 3 && apart(); again++) {
    const { version } = pending;
    pending = await gadget.readPendingDrawing(id);
    // Edits of yet another saving are ahead of the drawing, which is then read again.
    if (pending.version !== version) drawing = await readDrawing(id, pending.version);
  }
  // Edits still of another saving would be set over the wrong blocks: what is drawn stands.
  if (apart() && pending.edits.length) throw new Error('The document is being edited');
  // Edits made again may no longer fit: the changes listed before them do not say so.
  const { changes } = await (again ? gadget.getPendingChanges(id) : listed);
  // Still of two savings, the copy the agent reads may count its tables from other blocks.
  return { drawing, pending, apart: apart(), changes };
}

/**
 * The tab as the view shows it: the items pages.js sets on sheets, each element marked with the
 * row it draws and, where the row is a change, with the place the navigator counts it in.
 */
function compose() {
  const { drawing, rows, lists } = tab;
  const { margins } = drawing.sections[0];
  const hidden = view === 'after' ? 'removed' : view === 'before' ? 'added' : undefined;
  // As saved, each list is as the drawing has it.
  const draw = drawer(drawing, drawing.page.width - margins.left - margins.right, view === 'before' ? {} : lists);
  const items = [];
  const keys = new Set();
  let stop = -1;
  let marked = false;
  let fresh = false;
  // How many tables the tab holds so far as the pending changes leave it, which is how the
  // session's table methods number one, from 0: whichever copy is drawn, and however its tables
  // were paired with the saved ones.
  let tables = 0;

  for (const [index, row] of rows.entries()) {
    const { mark } = row;
    const block = blockOf(row, hidden);
    const table = mark !== 'removed' && (row.pending ?? row.saved).type === 'table' ? tables++ : undefined;
    // A section break has no box: one that goes is left where the tab is read as it will be.
    if ((row.pending ?? row.saved).type === 'section') {
      if (block) items.push({ section: block.section });
      continue;
    }
    if (mark && !marked) stop++;
    marked = !!mark;
    const text = said(row.pending ?? row.saved);
    const key = mark && `${mark}\u0000${text}`;
    if (key) keys.add(key);
    const place = element => {
      element.dataset.row = index;
      // Told only where the cells drawn are certainly that table's as the session reads it: where
      // the tab is drawn as the changes leave it, and where no change touches the table. A table
      // drawn with what it was may be drawn with what another was, and none is counted from a
      // drawing the changes were not read against.
      if (table !== undefined && !tab.apart && (view === 'after' || !mark)) element.dataset.table = table;
      if (!mark) return;
      element.dataset.stop = stop;
      element.dataset.does = row.does;
      if (!loaded || shown.has(key)) return;
      element.classList.add('fresh');
      fresh = true;
    };

    // A whole block the view leaves out is a mark where it is left out, one for all side by side.
    if (!block) {
      const name = (row.pending ?? row.saved).type === 'table' ? 'a table' : text.trim() ? `“${excerpt(text.trim())}”` : 'an empty paragraph';
      const last = items.at(-1);
      if (last?.gap) {
        last.element.title = `${++last.count} blocks ${hidden} here, from ${last.name}`;
      } else {
        const element = make('div', hidden === 'removed' ? 'omit gone' : 'omit came');
        element.title = `${hidden === 'removed' ? 'Removed' : 'Added'} here: ${name}`;
        place(element);
        items.push({ element, gap: true, count: 1, name });
      }
      continue;
    }
    const elements = draw.blocks(block);
    for (const [part, element] of elements.entries()) {
      place(element);
      // Which of the elements its row is drawn as: a table of contents is a paragraph for each
      // entry. A changed row drawn as several, or as a table, may be drawn in another copy with
      // other entries or cells at the same places, so what it is drawn as is this copy's alone.
      element.dataset.part = mark && (elements.length > 1 || element.matches('.grid')) ? `${view} ${part}` : part;
      items.push({ element });
    }
  }
  return { items, keys, fresh, draw };
}

// ---------------------------------------------------------------------------------------------
// The page navigator: steps from sheet to sheet, where the tab is drawn on more than one

let pager;

/**
 * Finds the page being read: the one at the head of the view, where stepping to a page puts it,
 * so that a step always moves the count. At the foot of the document that is the last page,
 * which may be too short to reach the head.
 */
function markPage() {
  const pages = sheets.firstElementChild?.matches('.endless') ? [] : [...sheets.children];
  const { scrollTop, clientHeight, scrollHeight } = document.scrollingElement;
  const at = scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 1 ? pages.length - 1
    : pages.findLastIndex(sheet => sheet.getBoundingClientRect().top <= HEAD + 1);
  pager.show(pages, Math.max(0, at));
}

// ---------------------------------------------------------------------------------------------
// Setting the page

// How wide the widest sheet is, which the room for the sheets is scaled from.
let sheetWidth = 816;

/** Scales the sheets to the room there is across the frame, and keeps for them the room that takes. */
function fit() {
  const scale = Math.min(1, page.clientWidth / sheetWidth);
  sheets.style.width = `${sheetWidth}px`;
  sheets.style.transform = scale < 1 ? `scale(${scale})` : '';
  page.style.height = `${sheets.offsetHeight * scale}px`;
  // The page gives way to the outline by its width as it is set, which scaling it to the room
  // that leaves does not change.
  document.documentElement.style.setProperty('--width', `${sheetWidth}px`);
  markPage();
}

/** The outline of a page still to come. */
function showSkeleton() {
  page.hidden = false;
  page.setAttribute('aria-busy', 'true');
  document.getElementById('error')?.remove();
  const sheet = make('section', 'sheet ghosted');
  Object.assign(sheet.style, { width: `${sheetWidth}px`, height: `${sheetWidth * 11 / 8.5}px` });
  sheet.append(...ghostLines());
  sheets.className = '';
  sheets.replaceChildren(sheet);
  page.style.width = `${sheetWidth}px`;
  fit();
}

// The first block in view and how far down the frame it is, so the same one can be put there
// in another drawing of the tab.
function readingPlace() {
  if (!document.scrollingElement.scrollTop) return;
  for (const element of sheets.querySelectorAll('[data-row]')) {
    const { top, bottom } = element.getBoundingClientRect();
    if (bottom > 56) return { row: Number(element.dataset.row), top };
  }
}

function keepPlace(place) {
  const element = place && [...sheets.querySelectorAll('[data-row]')].find(found => Number(found.dataset.row) >= place.row);
  if (element) scrollBy(0, element.getBoundingClientRect().top - place.top);
}

/**
 * Draws the tab in the view chosen. `arriving` says it is drawn for the first time, or with
 * something new; `place` is where the reading was, when that was taken before now.
 */
function render(arriving, place = readingPlace()) {
  // What is picked is that thing for as long as the merge it was picked in is drawn.
  const [held] = tab === drawn ? picker.parts() : [];
  const picked = held && nameOf(held);
  // The scrolls this makes move no reader on.
  picker.keep();
  const { items, keys, fresh, draw } = compose();
  // A tab with nothing pending has one copy.
  views.hidden = !tab.changed;
  press(views, view);
  // The sheets are measured as they are filled, so they are filled at their own size.
  sheets.style.transform = '';
  sheets.className = view === 'inline' ? 'redline' : '';
  sheets.dataset.view = view;
  const endless = view === 'inline' || !!tab.drawing.pageless;
  paginate(sheets, tab.drawing, items, blocks => draw.apart(() => blocks.flatMap(block => draw.blocks(block))), endless);
  sheetWidth = Math.max(...[...sheets.children].map(sheet => sheet.offsetWidth));
  page.style.width = `${sheetWidth}px`;
  fit();

  // Each stretch of changed blocks is one place for the navigator, however many pages it is on.
  const stops = new Map();
  for (const element of sheets.querySelectorAll('[data-stop]')) {
    if (!stops.has(element.dataset.stop)) stops.set(element.dataset.stop, []);
    stops.get(element.dataset.stop).push(element);
  }
  setStops([...stops.values()]);
  renderOutline();
  describeLinks();
  showPictures();
  keepPlace(place);
  // It is picked again where this draws it, or let go, in a copy that leaves it out as in
  // another merge, and the host told.
  picker.set(picked && [...sheets.querySelectorAll(picked)]);
  drawn = tab;
  if (arriving) {
    shown = keys;
    // A new change is what to look at; on opening, so is the first one there is.
    const first = fresh ? sheets.querySelector('.fresh') : loaded ? undefined : stops.values().next().value?.[0];
    first?.scrollIntoView({ block: 'center', behavior: motion() });
  }
}

const views = segmented('Which copy of the document to show', [
  ['after', 'With changes', 'The document as it will be, on its pages'],
  ['inline', 'Inline', 'Every change marked where it is made'],
  ['before', 'As saved', 'The document as Google has it, on its pages'],
], name => showView(name));
views.hidden = true;

function showView(name) {
  if (view === name || !tab) return;
  view = name;
  render();
}

// What a view leaves out is read where every change is marked in place.
sheets.addEventListener('click', event => {
  const mark = event.target.closest?.('.omit, .tick');
  if (!mark) return;
  const row = mark.closest('[data-row]').dataset.row;
  showView('inline');
  const target = [...sheets.querySelectorAll('[data-row]')].find(found => found.dataset.row === row);
  target?.scrollIntoView({ block: 'center', behavior: motion() });
  if (target) flash(target);
});

// ---------------------------------------------------------------------------------------------
// Images: each is a box of its size, filled once its bytes are read

// Each image read, by its tab and its ID: its data: URL, or the promise of one.
const pictures = new Map();
// One at a time, so no more than one image is in flight.
let inFlight = Promise.resolve();

function showPictures() {
  const id = tabId;
  for (const box of sheets.querySelectorAll('.obj[data-object]:not(.none)')) {
    // Shown already, when the page stands as it was drawn.
    if (box.querySelector(':scope > img')) continue;
    const object = tab.drawing.objects[box.dataset.object];
    const key = `${id}\u0000${box.dataset.object}`;
    let url = pictures.get(key);
    if (typeof url === 'string') {
      showPicture(box, object, url);
      continue;
    }
    if (!url) {
      url = inFlight.then(async () => {
        // Its turn may come after its tab was left, and then nothing waits for it.
        if (id !== tabId) throw new Error('This tab is no longer shown.');
        const { mimeType, content } = await gadget.readImage(box.dataset.object, id);
        return dataUrl(content, mimeType);
      });
      inFlight = url.catch(() => {});
      pictures.set(key, url);
      url.then(found => pictures.set(key, found), () => pictures.delete(key));
    }
    box.classList.add('wait');
    url.then(found => box.isConnected && showPicture(box, object, found), () => box.classList.remove('wait'));
  }
}

// ---------------------------------------------------------------------------------------------
// The outline: the document's tabs and, under the one shown, its headings, as Docs lists them
// beside the page, with a dot on each heading whose section holds a change.

let headings = [];
let entries = [];
// What has been folded away: a tab by its ID, a heading by its tab, level and text, and by
// which of the headings that share those it is.
const folded = new Set();
const fold = (key, label) => foldArrow(key, label, folded, renderOutline);
let reading = -1;

// What a heading, or anything picked, says, without what is drawn beside its text or is being
// removed from it: all of it, given the parts its pages cut it in.
function headingText(...parts) {
  const beside = sheets.dataset.view === 'inline' ? 'del, .marker, .tick, .obj' : '.marker, .tick, .obj';
  return parts.map(part => {
    const copy = part.cloneNode(true);
    for (const gone of copy.querySelectorAll(beside)) gone.remove();
    return copy.textContent;
  }).join('').replaceAll('\u2060', '').trim();
}

function renderOutline() {
  // The outline is made anew: what stands for the control that has the keyboard keeps it.
  const held = outlineList.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
  // As in Docs, a heading inside a table is not listed; one being removed is no longer there.
  headings = [...sheets.querySelectorAll('.col > [role="heading"]')]
    .filter(heading => !(view === 'inline' && heading.matches('.removed')) && headingText(heading));
  const top = Math.min(...headings.map(heading => Number(heading.ariaLevel)));
  const levels = headings.map(heading => Number(heading.ariaLevel) - top);
  // What the changes in each heading's section do: the blocks from it to the next heading.
  const touched = headings.map(() => []);
  let section = -1;
  for (const block of sheets.querySelectorAll('.col > *')) {
    const at = headings.indexOf(block);
    if (at >= 0) section = at;
    if ('stop' in block.dataset) touched[section]?.push(block.dataset.does);
  }
  // The heading whose headings are folded away, while the ones under it are passed.
  let folder;
  const named = new Map();
  entries = headings.map((heading, index) => {
    const level = levels[index];
    const entry = make('button', level ? 'entry' : 'entry top');
    entry.appendChild(make('span', '', headingText(heading)));
    const name = entry.textContent;
    const mark = kinds => {
      const says = touch(entry, kinds);
      entry.title = says ? `${name} (${says})` : name;
    };
    mark(touched[index]);
    // A heading that has just arrived arrives here as it does on the page.
    if (heading.matches('.fresh')) entry.classList.add('fresh');
    entry.addEventListener('click', () => {
      heading.scrollIntoView({ block: 'start', behavior: motion() });
      leaveOutline();
    });
    const title = `${tabId}\u0000${level}\u0000${name}`;
    const nth = named.get(title) ?? 0;
    named.set(title, nth + 1);
    const key = `${title}\u0000${nth}`;
    entry.dataset.key = key;
    const row = make('div', 'row');
    row.style.paddingLeft = `${level * 12}px`;
    row.append(fold(levels[index + 1] > level && key, 'Headings under this one'), entry);
    if (folder && level <= folder.level) folder = undefined;
    row.hidden = !!folder;
    // A change in a section folded away still shows, on the heading it is folded under.
    if (folder) {
      folder.kinds.push(...touched[index]);
      folder.mark(folder.kinds);
    } else if (folded.has(key)) folder = { level, mark, kinds: [...touched[index]] };
    return entry;
  });
  rail.replaceChildren(thumb, ...entries.map(entry => entry.parentElement));
  thumb.hidden = entries.length === 0;
  // A document of one tab lists only its headings.
  const several = tabs.length > 1;
  outlineList.replaceChildren(...!several ? [rail] : tabs.flatMap(listed => {
    const on = listed.id === tabId;
    const row = make('div', on ? 'tab on' : 'tab');
    const name = make('button', 'name');
    name.append(lineIcon('M6 3h5.5L15 6.5V17H6zM11.5 3v3.5H15M8.5 10.5h4M8.5 13.5h4'), make('span', '', listed.title));
    // A tab still to be added goes by an ID of this form until Google has it.
    const added = listed.id.startsWith('pending-tab-');
    const says = touch(name, added ? ['added'] : listed.pending ? ['changed'] : [], ITSELF);
    name.title = added ? `${listed.title} (new, not yet added)` : says ? `${listed.title} (${says})` : listed.title;
    name.setAttribute('aria-pressed', String(on));
    name.dataset.key = listed.id;
    name.addEventListener('click', () => {
      if (on) return void document.scrollingElement.scrollTo({ top: 0, behavior: motion() });
      selectTab(listed.id);
      void load();
      renderOutline();
    });
    row.style.marginLeft = `${listed.nestingLevel * 12}px`;
    row.append(fold(on && entries.length > 0 && listed.id, 'Headings in this tab'), name);
    return on && !folded.has(listed.id) ? [row, rail] : [row];
  }));
  reading = -1;
  setOutline(several ? 'Document tabs' : 'Outline', several || headings.length > 0);
  if (held !== undefined) [...outlineList.querySelectorAll('[data-key]')].find(found => found.dataset.key === held)?.focus();
}

// How far under the top of the view going to a heading puts it, and how far under it one is passed.
const PUT = 44;
const PASSED = 96;

// Which of `found`, headings, the view is at: the first between where going to one puts it and
// where one is passed, so the one gone to and not those close under it, or else the last above.
function reached(found) {
  const tops = found.map(heading => heading.getBoundingClientRect().top);
  const at = tops.findIndex(top => top >= PUT - 1 && top <= PASSED);
  return at < 0 ? tops.findLastIndex(top => top <= PASSED) : at;
}

/** Marks the heading the top of the view is under, or the one it is folded under. */
function markHeading() {
  if (outline.hidden || !rail.isConnected) return;
  let current = Math.max(0, reached(headings));
  while (current > 0 && entries[current].parentElement.hidden) current--;
  entries.forEach((entry, index) => entry.setAttribute('aria-current', String(index === current)));
  const row = entries[current]?.parentElement;
  if (!row) return;
  thumb.style.transform = `translateY(${row.offsetTop}px)`;
  thumb.style.height = `${row.offsetHeight}px`;
  // The outline follows the reading, so the heading being read stays in it. At the first
  // heading that is the top of the outline, where the tabs are.
  if (current === 0) outlineList.scrollTop = 0;
  else if (current !== reading) row.scrollIntoView({ block: 'nearest' });
  reading = current;
}

// Where a link leads. One to a tab of this document, or to a heading in one, is followed here.
// One to the web opens in a new browser tab, which in this frame only a link element with an
// address does, unless it is in a pending change: that text is not yet approved, and its
// address could carry what the document holds to wherever it points.
// Google does not say where a bookmark is, so a link to one reaches no further than its tab.
const decoded = text => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const headingAt = id => sheets.querySelector(`[data-heading="${CSS.escape(id)}"]`);

function destination(link) {
  // draw.js says which: `held` of all that is not saved text left alone.
  const address = link.dataset.href ?? link.dataset.held ?? '';
  const [, to, kind, id] = /^(?:\?tab=([^#]*))?(?:#(heading|bookmark)=(.*))?$/.exec(address) ?? [];
  if (to === undefined && kind === undefined) {
    if (!/^https?:\/\//i.test(address)) return { hint: address };
    return 'held' in link.dataset
      ? { hint: `Not opened while its change is pending: ${address}` }
      : { web: address, hint: address };
  }
  const found = tabs.find(listed => listed.id === decoded(to ?? ''));
  const elsewhere = found && found.id !== tabId ? found : undefined;
  if (kind === 'bookmark') {
    return elsewhere
      ? { tab: elsewhere.id, hint: `Go to a bookmark in “${elsewhere.title}”, shown from its top` }
      : { hint: 'A bookmark in this document, which the preview cannot find' };
  }
  const heading = kind && decoded(id);
  if (elsewhere) return { tab: elsewhere.id, heading, hint: `Go to “${elsewhere.title}”` };
  const target = headingAt(heading);
  if (target) return { heading, hint: `Go to “${headingText(target)}”` };
  return { hint: heading ? 'A heading the preview cannot find' : '' };
}

// Each link says where it leads, and looks followed only if it is.
function describeLinks() {
  for (const link of sheets.querySelectorAll('.link')) {
    const { hint, web, ...to } = destination(link);
    link.title = hint;
    link.classList.toggle('go', !!web || Object.keys(to).length > 0);
    if (web) Object.assign(link, { href: web, target: '_blank', rel: 'noopener noreferrer' });
    // One followed in place has no address, which is what puts a link in reach of the keyboard.
    else if (link.classList.contains('go')) Object.assign(link, { tabIndex: 0, role: 'link' });
  }
}

function pressLink(event) {
  if (event.key === 'Enter' && event.target.matches?.('.link.go:not([href])')) event.target.click();
}

async function followLink(event) {
  const link = event.target.closest?.('.link');
  if (!link) return;
  const { tab: to, heading } = destination(link);
  if (to) {
    selectTab(to);
    // Kept as goTo() keeps one, and gone to by the read that answers: a refresh may start one
    // that overtakes this, and the reader may have moved on by the time this one ends.
    if (heading) wanted = { id: encodeURIComponent(heading) };
    return load();
  }
  const target = heading && headingAt(heading);
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: motion() });
  flash(target);
}

// ---------------------------------------------------------------------------------------------
// Where the reader is

// What Google has saved a heading as saying, by its ID, a chip in it by its words too: nothing
// for one only a change makes.
function savedHeading(id) {
  const block = tab.drawing.blocks.find(found => found.headingId === id);
  return block?.runs.map(run => run.text ?? run.chip ?? '').join('').replace(/\s+/g, ' ').trim();
}

// Where `cell` is, as the session's table methods name one: its table among the tab's, as
// compose() counts them, and its row and column there, as draw.js does. Nowhere, for a cell of
// a table compose() gives no number.
function placeOf(cell) {
  const { table } = cell.closest('[data-row]').dataset;
  if (table === undefined) return undefined;
  const [row, column] = cell.dataset.cell.split(' ').map(Number);
  return { table: Number(table), row, column };
}

// Every piece of the cell at `row` and `column` of the tab's table `table`, counted so.
const cellAt = (table, row, column) => [...sheets.querySelectorAll(`.grid[data-table="${table}"] > tbody > tr > td[data-cell="${row} ${column}"]`)];

// What `node` is, a paragraph or a cell, in any drawing of the merge it is drawn from: a selector
// of every piece of it, which are the parts its pages cut it in, and a cell of a row its table
// repeats on each page. By the merge's row, the element of that row (compose()) and a cell's
// place in its table (draw.js), and never by what it says, which says nothing of which it is.
function nameOf(node) {
  const { row, part } = node.closest('[data-row]').dataset;
  return `[data-row="${row}"][data-part="${part}"]${node.matches('td') ? ` > tbody > tr > td[data-cell="${node.dataset.cell}"]` : ''}`;
}

// The tab last drawn, which says of the next drawing whether it is of the same merge.
let drawn;

// The tab shown and the last heading at or before what is picked, or else where the text selected
// starts, or with neither the one the view has passed: an address of the form the document's own
// links to its tabs and headings have, and after it the cell picked, where the session's table
// methods would certainly act on that cell (compose()). A cell of a table drawn with what a change
// makes of it or takes from it is told by its heading and its text alone. The tab and the heading
// are told as Google has them saved, since a host shows them and tells an agent of them: a heading
// goes by its saved words whatever a change makes of them, and a tab or a heading only a change
// makes is no spot yet.
function here(range) {
  // A tab still being read has no place yet, which is not the reader gone from where they were.
  if (!loaded) return false;
  const listed = tabs.find(found => found.id === tabId);
  if (!listed || listed.id.startsWith('pending-tab-')) return undefined;
  // At the foot of the tab every heading has been read, as markPage() has its last page: one
  // near the end scrolls no higher.
  const { scrollTop, clientHeight, scrollHeight } = document.scrollingElement;
  const ended = scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 1;
  const parts = picker.parts();
  const [picked] = parts;
  const named = headings.filter(found => found.dataset.heading);
  // Where what is picked starts, or else the text selected.
  const start = (picked || range) && document.createRange();
  start?.setStart(picked ?? range.startContainer, picked ? 0 : range.startOffset);
  // The last heading at or before that, or with neither the last passed, that Google has, and its words.
  let at = start ? named.findLastIndex(found => start.comparePoint(found, 0) <= 0)
    : ended ? named.length - 1 : reached(named);
  let words;
  while (at >= 0 && !(words = savedHeading(named[at].dataset.heading))) at--;
  const heading = named[at];
  const place = picked?.matches('td') ? placeOf(picked) : undefined;
  // A row its table repeats on each page says its words once.
  const context = picked && headingText(...parts.filter((part, nth) => !nth || !part.closest('tr[data-header]')));
  // Told as it reads with the pending changes, wherever they wrote any of it or took any away.
  const pending = parts.some(part => takesIn(part, UNSAVED));
  // A label says nothing a pending change wrote, and counts as a person does.
  const what = !picked || picked === heading ? undefined
    : place ? `Table ${place.table + 1} › row ${place.row + 1}, column ${place.column + 1}`
    : picked.matches('td') ? picked.closest('.removed') ? 'Cell being deleted' : 'Cell of a table being changed'
    : pending ? 'Pending change' : context ? quote(context) : 'Image';
  const within = [
    heading && `heading=${encodeURIComponent(heading.dataset.heading)}`,
    place && `table=${place.table}&row=${place.row}&column=${place.column}`,
  ].filter(Boolean);
  return {
    anchor: `?tab=${encodeURIComponent(tabId)}${within.length ? `#${within.join('&')}` : ''}`,
    // None at the top of a document of one tab: nowhere more particular than the document.
    label: [tabs.length > 1 && listed.title, words, what].filter(Boolean).join(' › ') || undefined,
    context,
    pending,
  };
}

// A spot here() gives: a tab, a heading in it, and a cell of one of its tables.
const SPOT = /^\?tab=([^#]*)(?:#(?:heading=([^&]*))?(?:&?table=(\d+)&row=(\d+)&column=(\d+))?)?$/;

// Shows the spot `anchor` names (GadgetHost.onNavigate()). It is one here() gave, but may come
// from anywhere, so it only chooses what to show. False for a tab or a heading no longer there:
// the reader stays on the tab they are on, or starts on the one load() opens on. A cell that is
// there is picked again, and one that is not leaves them at its heading.
async function goTo(anchor) {
  const [, to, id, ...place] = SPOT.exec(anchor) ?? [];
  if (to === undefined || loaded && !tabs.some(listed => listed.id === decoded(to))) return false;
  if (decoded(to) !== tabId) selectTab(decoded(to));
  // Kept for the read that finds it: a refresh may start one that overtakes this, and one that
  // fails may be tried again.
  const opening = !loaded;
  if (opening) {
    wanted = { id, place };
    await load();
  }
  if (decoded(to) !== chosen) return false;
  // Not read, as when Google could not be reached: the spot may well still be there.
  if (!loaded) return true;
  // The read that opens the tab has gone there itself, and the reader may have moved on since.
  if (!opening) showSpot({ id, place });
  saySpot();
  return id === undefined || !!headingAt(decoded(id));
}

// Brings a spot of the tab drawn into view: the cell at `place`, which is picked, or else the
// heading `id` names. A cell not there, one of a table told no number here, or one of a tab
// still to be added, where nothing is picked, is none.
function showSpot({ id, place = [] }) {
  const cell = place[0] === undefined || tabId.startsWith('pending-tab-') ? [] : cellAt(...place.map(Number));
  picker.keep();
  (cell[0] ?? (id === undefined ? undefined : headingAt(decoded(id))))?.scrollIntoView({ block: cell[0] ? 'center' : 'start' });
  picker.set(cell);
}

// ---------------------------------------------------------------------------------------------
// Loading and refreshing

// The spot the host sent this to, or the heading a link led to in another tab, until that tab is
// read: as showSpot() takes it.
let wanted;

function selectTab(id) {
  tabId = chosen = id;
  wanted = undefined;
  loaded = false;
  shown = new Set();
  // Where the reading was is a place in the tab left.
  document.scrollingElement.scrollTop = 0;
  // The copies offered are of the tab drawn, which is the one left until this one is read, as
  // are the changes to step to and those counted as no longer fitting.
  views.hidden = true;
  setStops([]);
  showStale(0, 'document');
  // And what was picked is a thing of that tab.
  picker.set();
}

// The looks `block` is set in that an edit made (merge.js), which its drawing does not hold.
const madeLooks = block => block.type === 'table' ? block.rows.flatMap(row => row.cells.flatMap(cell => cell.blocks.flatMap(madeLooks)))
  : [block.end, block.list?.look, ...block.runs?.map(run => run.look) ?? []].filter(look => look?.fontFamily);

// Asks for the fonts the tab is set in, and sets it again in each that arrives: one that could
// not be read is asked for again after a while.
function readFonts() {
  const { drawing, rows } = tab;
  // After the saved looks, those the pending changes write: bold or italic of a family, which
  // no saved look may be.
  const looks = [...drawing.textLooks, ...rows.flatMap(row => row.mark ? madeLooks(blockOf(row)) : [])];
  return fonts.read(looks.map(({ fontFamily, weight, italic }) => [fontFamily, weight, !!italic])).then(any => {
    // Whichever read drew the tab on the page by then: a later one asked for no font that was
    // already on its way.
    if (any && loaded && !page.hidden) render(false, readingPlace());
  });
}

async function load() {
  const current = ++generation;
  if (loaded) status('Updating…');
  else showSkeleton();
  try {
    // Listed each time: a tab can be added, discarded or renamed between two drawings. An added
    // tab is listed under another ID once Google has it, so the one shown is found by its title,
    // where it was listed first: titles can repeat. With none to find, as on opening, the one
    // shown is the first with changes waiting, which are what there is to look at.
    const at = tabs.findIndex(listed => listed.id === tabId);
    const title = tabs[at]?.title;
    const listing = gadget.listTabs();
    // The tab's drawing, its pending drawing and its changes. Asked for with the list, as the
    // tab shown is nearly always still on it.
    let asked = tabId && read(tabId);
    asked?.catch(() => {});
    const listed = await listing;
    if (current !== generation) return;
    tabs = listed;
    // Asked for by the provisional ID of a tab added since, the read names the one it is listed under.
    const adopted = tabs.some(found => found.id === tabId) ? tabId : (await asked?.catch(() => {}))?.pending.tabId;
    if (current !== generation) return;
    if (tabs.some(found => found.id === adopted)) {
      tabId = adopted;
    } else {
      selectTab(([tabs[at], ...tabs].find(found => found?.title === title) ?? tabs.find(found => found.pending) ?? tabs[0])?.id);
      showSkeleton();
      asked = read(tabId);
    }
    if (tab) renderOutline();
    const { drawing, pending, apart, changes } = await asked;
    if (current !== generation) return;
    const stale = changes.filter(change => change.stale).length;
    // The card is over every tab while a change waits on any of them.
    lift(changes.length > 0 || tabs.some(listed => listed.pending));
    // Nothing of this tab moved, as when a change is made to another: what is drawn stands.
    const edits = JSON.stringify(pending);
    if (loaded && !page.hidden && tab.drawing === drawing && tab.edits === edits) {
      for (const arrived of document.querySelectorAll('.fresh')) arrived.classList.remove('fresh');
      // An image or a font that could not be read is asked for again.
      showPictures();
      void readFonts();
      showStale(stale, 'document');
      // A failure said under it is no longer so.
      showPage();
      return void status('');
    }

    const { rows, lists } = merge(drawing, pending);
    tab = { drawing, edits, rows, lists, apart, changed: rows.some(row => row.mark) };
    if (!tab.changed) view = 'after';

    // The text is set in each font as it arrives, and the first time waits a moment for them:
    // a page set in a stand-in breaks its lines, and so its pages, somewhere else.
    const arriving = readFonts();
    if (!loaded) await Promise.race([arriving, new Promise(resolve => setTimeout(resolve, 1500))]);
    if (current !== generation) return;

    // Shown before it is filled, which measures it. A failure said under it is no longer so: one
    // stays through a font that arrives, or another copy of the tab, which read nothing.
    showPage();
    render(true);
    showStale(stale, 'document');
    status('');
    loaded = true;
    if (wanted) showSpot(wanted);
    wanted = undefined;
    saySpot();
  } catch (error) {
    if (current !== generation) return;
    status('');
    // A tab already drawn stays, with the failure said under it.
    if (loaded) miss('This document could not be updated', load);
    else showError(error, 'document', load);
  }
}

export default {
  async main(session, host) {
    gadget = session;
    // Built here, not on import: a Drive connection's frame holds the previews of all three
    // kinds of file and starts one.
    document.head.append(...drawStyles, pageStyles, styleSheet);
    page.append(sheets);
    pager = partNavigator('page');
    new ResizeObserver(fit).observe(page);
    addControl(views);
    saySpot = reportSpot(host, here, UNSAVED, '#sheets');
    // A paragraph of the body with something in it, its text or a picture, or a cell of a table
    // there, in every piece of it: one of a table inside another's cell is told as the cell that
    // holds it.
    picker = picking(target => {
      // Nothing of a tab still to be added, which is no spot a host is told of.
      if (tabId.startsWith('pending-tab-')) return undefined;
      const block = target.closest('[data-row]');
      const node = block?.matches('.grid') ? [...block.querySelectorAll(':scope > tbody > tr > td')].find(cell => cell.contains(target))
        : block?.matches('.para') ? block : undefined;
      const pieces = node ? [...sheets.querySelectorAll(nameOf(node))] : [];
      return pieces.some(piece => piece.matches('td') || headingText(piece) || piece.querySelector('.obj')) ? pieces : undefined;
    }, () => saySpot());
    addEventListener('scroll', () => requestAnimationFrame(() => {
      markHeading();
      markPage();
      saySpot();
    }), { passive: true });
    outline.addEventListener('outlinechange', markHeading);
    // Text is copied as the document has it, without the joiners draw.js sets its lines with.
    addEventListener('copy', event => {
      event.clipboardData.setData('text/plain', String(getSelection()).replaceAll('\u2060', ''));
      event.preventDefault();
    });
    page.addEventListener('keydown', pressLink);
    page.addEventListener('click', followLink);
    loadOnRefresh(load);
    // The host sends this to the spot the reader left, if there is one, before anything is read:
    // the first tab read is then the one it names.
    await host.onNavigate(goTo);
    if (!generation) void load();
  },
};
