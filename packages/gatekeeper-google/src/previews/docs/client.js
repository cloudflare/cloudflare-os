// The Google Doc preview (GoogleDocGatekeeperImpl.getPreviewUi()): gadget-format client code that
// runs in the gadget UI frame, whose page starts it with main(gadget), at the end of this file.
// There `gadget` is a GoogleDocSession rather than a gadget server.
// The gatekeeper imports it as text through client.txt, a symlink to this file, and returns it
// with the modules beside it and ui/chrome.js, which the previews of this gatekeeper share.
//
// The tab is drawn as Google Docs draws it, on its pages: from its drawing (readDrawing()) what
// the pending changes leave alone, and from its Markdown (getPendingChanges()) what they write.
//
// Everything the document says is set as text or built node by node. Nothing from it is parsed
// as HTML into this document. A link is followed only by a click: inside the document to a tab
// or a heading, and out to the web, in a new browser tab, from text Google Docs has saved.

import {
  addControl, dataUrl, flash, foldArrow, ghostLines, leaveOutline, lineIcon, loadOnRefresh, make, motion, outline,
  outlineList, page, partNavigator, press, segmented, setOutline, setStops, showError, showPage, showStale, status,
  touch,
} from './ui/chrome.js';
import { drawer, headingLevel, newList, showPicture } from './draw.js';
import { paginate } from './pages.js';
import { BOLD, ITALIC, STRIKE, blockKey, diff, pairEdits, parseBlocks, tablesOf, wordsOf } from './text.js';

// The session main() is handed, which every read below goes through.
let gadget;

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
    --gone-ink: #a50e0e; --chip: #f1f3f4; --shine: #e8eaed; }
  .sheet.ghosted { box-sizing: border-box; padding: 72pt; }

  @media (max-width: 560px) { #nav > span { display: none; } #nav { padding-left: 3px; }
    #bar .views button { padding: 3px 8px; } }
  /* A page the page navigator steps to stops clear of the controls at the head of the frame. */
  .sheet { scroll-margin-top: ${HEAD}px; }

  /* A changed paragraph carries a bar in the page's margin, and what changed in it is tinted.
     The document's own colors stay, except where every change is read in place. */
  :is(.added, .changed) { --glow: var(--mark-ink); }
  .removed { --glow: var(--gone-ink); }
  /* A mark has no box to ring: it glows itself. */
  .omit { outline: none !important; }
  :is(.added, .removed, .changed)::before { content: ''; position: absolute; width: 2.5pt;
    left: calc(-1 * var(--in, 0pt) - 13pt); top: calc(var(--above, 0pt) + 1pt);
    bottom: calc(var(--below, 0pt) + 1pt); border-radius: 2pt; background: var(--mark-ink);
    transition: box-shadow .2s ease-out; }
  .removed::before { background: var(--gone-ink); }
  /* The tint is on the text, line by line and down to the next line, so it goes round an image
     the text is wrapped round as the text does. */
  ins, del { text-decoration-line: none; }
  ins, del, :is(.added, .removed) > :is(span, a):not(.lift, .row, .obj, .tick, .marker, .chip) {
    padding-bottom: calc(var(--l, 1.18em) - 1.18em); -webkit-box-decoration-break: clone;
    box-decoration-break: clone; }
  ins, .added > :is(span, a):not(.lift, .row, .obj, .tick) { background-color: var(--mark); }
  del, .removed > :is(span, a):not(.lift, .row, .obj, .tick) { background-color: var(--gone); }
  .redline :is(ins, .added > :is(span, a)) { color: var(--mark-ink); }
  .redline :is(del, .removed > :is(span, a)) { color: var(--gone-ink);
    text-decoration: line-through color-mix(in srgb, currentColor 55%, transparent); }
  /* The change the navigator is on. */
  .here::before { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent); }
  .here:is(.added, .changed)::before { color: var(--mark-ink); }
  .here.removed::before { color: var(--gone-ink); }

  /* Where the copy shown leaves something out: words, as a caret under the line, and whole
     paragraphs, as a wedge in the margin. Neither takes any room, so the page is set as it will be. */
  .tick { position: relative; cursor: pointer; }
  .tick::before { content: ''; position: absolute; left: -3.5pt; top: -1pt; border: 3.5pt solid transparent;
    border-top: 0; border-bottom: 4.5pt solid var(--gone-ink); }
  .omit { position: relative; height: 0; cursor: pointer; }
  .omit::before { content: ''; position: absolute; left: -13pt; top: -4pt; border: 4pt solid transparent;
    border-right: 0; border-left: 5pt solid var(--gone-ink); }
  .tick.came::before { border-bottom-color: var(--mark-ink); }
  .omit.came::before { border-left-color: var(--mark-ink); }
  .omit.here::before, .omit.fresh::before { filter: drop-shadow(0 0 3px currentColor); }

  #outline .tab + #rail { margin: 4px 0 8px 14px; }
  /* One rail down the headings, and a thumb on it that slides to the one being read. */
  #rail { position: relative; border-left: 1px solid var(--line); }
  #thumb { position: absolute; top: 0; left: -2px; width: 3px; border-radius: 3px;
    background: var(--link); transition: transform .2s ease-out, height .2s ease-out; }
  /* Clear of the panel's header when the outline scrolls to the heading being read. */
  #rail .row { display: flex; align-items: center; scroll-margin: 46px 0 8px; }
  .entry { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; padding: 5px 8px 5px 4px;
    border: 0; border-radius: 6px; background: none; color: var(--dim); line-height: 1.4;
    text-align: left; transition: background .12s, color .12s; }
  .entry.top { color: var(--ink); font-weight: 700; }
  .entry:hover { background: var(--chip); color: var(--ink); }
  .entry[aria-current="true"] { color: var(--link); }
  .entry:focus-visible { outline-offset: -2px; }
  .entry > span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
document.head.append(styleSheet);

/** What the sheets are set in, inside the room `page` keeps for them. */
const sheets = page.appendChild(make('div'));
sheets.id = 'sheets';

const rail = make('div');
rail.id = 'rail';
const thumb = make('div');
thumb.id = 'thumb';

// ---------------------------------------------------------------------------------------------
// What is loaded

let tabs = [];
let tabId = null;
let loaded = false;
let generation = 0;
// What the last drawing showed as changed, so the next one can tell what is new.
let shown = new Set();
// The tab shown: its drawing, the rows its pending changes make of its blocks, and the saved
// block each row was.
let tab;

/** Which copy is shown: the tab `after` its pending changes, `before` them, or both `inline`. */
let view = 'after';

// Google Docs' own styles, which a tab is drawn in where its drawing says nothing: one still to
// be added has no drawing at all.
const type = (fontSize, more) => ({ fontFamily: 'Arial', fontSize, weight: 400, ...more });
const set = (spaceAbove, spaceBelow) => ({ lineSpacing: 1.15,
  ...spaceBelow ? { spaceAbove, spaceBelow, keepWithNext: true, keepLinesTogether: true } : {} });
const PLAIN = {
  NORMAL_TEXT: { paragraph: set(), text: type(11) },
  TITLE: { paragraph: set(0, 3), text: type(26) },
  SUBTITLE: { paragraph: set(0, 16), text: type(15, { color: '#666666' }) },
  HEADING_1: { paragraph: set(20, 6), text: type(20) },
  HEADING_2: { paragraph: set(18, 6), text: type(16) },
  HEADING_3: { paragraph: set(16, 4), text: type(14, { color: '#434343' }) },
  HEADING_4: { paragraph: set(14, 4), text: type(12, { color: '#666666' }) },
  HEADING_5: { paragraph: set(12, 4), text: type(11, { color: '#666666' }) },
  HEADING_6: { paragraph: set(12, 4), text: type(11, { color: '#666666', italic: true }) },
};
const BLANK = {
  page: { width: 612, height: 792 },
  sections: [{ margins: { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36 } }],
  blocks: [], headers: {}, footers: {}, footnotes: {}, lists: {}, objects: {},
  paragraphLooks: [], textLooks: [], named: {},
};

/** What a paragraph of the named style `style` is set in, and its text. */
function namedOf(style) {
  const { named, paragraphLooks, textLooks } = tab.drawing;
  const found = named[style];
  return found ? { paragraph: paragraphLooks[found.paragraph], text: textLooks[found.text] } : PLAIN[style] ?? PLAIN.NORMAL_TEXT;
}

// Per tab: the saved Markdown and the revision its drawing was read for, and the drawing. The
// revision tells of a change to how the tab is drawn that its Markdown does not show.
const drawings = new Map();

async function readDrawing(savedMarkdown, revisionId) {
  // The tab asked about, which is no longer the one shown if another was chosen meanwhile.
  const id = tabId;
  const held = drawings.get(id);
  if (held?.savedMarkdown === savedMarkdown && held.revisionId === revisionId) return held.drawing;
  const drawing = await gadget.readDrawing(id);
  drawings.set(id, { savedMarkdown, revisionId, drawing });
  return drawing;
}

// Whether a saved block of the Markdown and a block of the drawing are the same kind of thing: if
// any pair is not, the two were not read of the same document and the drawing is of no use.
const sameKind = (block, drawn) => block.type === 'table' ? drawn.type === 'table'
  : block.type === 'structure' ? drawn.type === 'contents' || drawn.type === 'section'
  : drawn.type === 'paragraph' && headingLevel(drawn.style) === block.heading;

// ---------------------------------------------------------------------------------------------
// A paragraph the pending changes wrote, drawn from its Markdown: set as the paragraph it was, or
// as a new one of its kind, each word in the look of the saved text it was or stands beside.

const excerpt = text => text.length > 120 ? `${text.slice(0, 119)}…` : text;
const plain = words => words.map(word => word.kind === 'br' ? ' ' : word.kind ? '' : word.text).join('');

/**
 * What draw.js draws for `item`, a block of the Markdown. `saved` is the paragraph of the drawing
 * that `was`, the block it replaces, is; `hidden` the kind of change the view leaves out; `state`
 * the lists the changes start, the one the paragraph before this is in, and that paragraph.
 */
function written(item, words, saved, was, mark, hidden, state) {
  const { drawing } = tab;
  const { textLooks } = drawing;
  const style = saved && headingLevel(saved.style) === item.heading ? saved.style
    : item.heading ? `HEADING_${item.heading}` : 'NORMAL_TEXT';
  const named = namedOf(style);
  // Google writes new paragraphs into the saved one before them, whose setting each keeps unless
  // it is given another named style, which sets it afresh.
  const before = saved ? undefined : [state.before, state.container].find(found => found?.style === style);
  const base = before?.end ?? named.text;
  let look = saved?.style === style ? drawing.paragraphLooks[saved.look] : before?.look ?? named.paragraph;

  let list;
  if (item.type !== 'p') {
    const numbered = item.type === 'number';
    const levelsOf = id => drawing.lists[id] ?? state.lists[id];
    // An item goes on with the list it was in, or the one above it, when that is its kind.
    let id = [saved?.list?.id, state.list].find(found =>
      found !== undefined && !!levelsOf(found)?.[item.level]?.numbering === numbered);
    if (id === undefined) state.lists[id = `new-${Object.keys(state.lists).length}`] = newList(numbered);
    const level = levelsOf(id)[item.level];
    if (saved?.list?.id !== id || saved.list.level !== item.level) {
      look = { ...look, indentStart: level?.indentStart, indentFirstLine: level?.indentFirstLine };
    }
    list = { id, level: item.level, look: saved?.list ? textLooks[saved.list.look] : base };
  } else if (saved?.list || before?.list) {
    look = { ...look, indentStart: named.paragraph.indentStart, indentFirstLine: named.paragraph.indentFirstLine };
  }

  // The saved runs by where they are in the paragraph's line of the saved Markdown.
  const spans = (saved?.runs ?? []).filter(run => run.text !== undefined && run.at !== undefined);
  // A word that was saved is cut where a run starts or ends inside it: a run is of characters,
  // and a word may be `(note)` with only `note` highlighted.
  const pieces = (words ?? wordsOf(item.text).map(word => ({ ...word, at: undefined }))).flatMap(word => {
    if (word.at === undefined || word.kind || !spans.length) return [word];
    const from = was.offset + word.at;
    const inside = spans.flatMap(run => [run.at - from, run.at + run.text.length - from])
      .filter(place => place > 0 && place < word.text.length);
    const cuts = [...new Set([0, ...inside, word.text.length])].toSorted((a, b) => a - b);
    return cuts.slice(1).map((end, n) => ({
      ...word,
      text: word.text.slice(cuts[n], end),
      run: spans.find(run => run.at <= from + cuts[n] && from + cuts[n] < run.at + run.text.length),
    }));
  });

  // Google draws text written into a paragraph as the text before it is, or as the text after it
  // at the paragraph's start, and what the edit removes is gone by then. Its weight and slant are
  // what the Markdown says, over what the paragraph's style gives all its text.
  const stays = piece => piece.run && piece.mark !== 'removed';
  let beside = pieces.find(stays)?.run ?? spans[0];
  const typed = ({ style: flags = 0, href }) => {
    const { fontFamily, fontSize, color, highlight } = beside && !beside.link ? textLooks[beside.look]
      : { ...base, ...beside && { fontFamily: textLooks[beside.look].fontFamily, fontSize: textLooks[beside.look].fontSize } };
    const bold = named.text.weight < 400 ? 400 : named.text.weight < 700 ? 700 : 900;
    return {
      fontFamily,
      fontSize,
      weight: flags & BOLD ? bold : named.text.weight,
      // The converter writes a subtitle as italic whatever its style says.
      ...(flags & ITALIC && style !== 'SUBTITLE' || named.text.italic) && { italic: true },
      ...flags & STRIKE && { strikethrough: true },
      ...href ? { underline: true, color: '#1155cc' } : color && { color },
      ...highlight && { highlight },
    };
  };

  // The saved paragraph's images in the order its Markdown names them: those tethered to it, and
  // then those in its text. One the changes leave is drawn as it is, where a new one is only named.
  const tethered = saved?.objects ?? [];
  const images = saved ? [...tethered, ...saved.runs.flatMap(run => run.object ?? [])] : [];
  const kept = [];
  let image = 0;
  // Set past a tethered image, whose name in the Markdown has a space after it that the text lacks.
  let apart = false;

  const runs = [];
  // What the view leaves out, gathered into the one place it is left out of.
  let left = [];
  const leave = () => {
    const text = plain(left).trim();
    if (text) runs.push({ tick: hidden === 'removed' ? 'gone' : 'came',
      note: `${hidden === 'removed' ? 'Removed here' : 'Added here'}: “${excerpt(text)}”` });
    left = [];
  };
  for (const piece of pieces) {
    // Google holds an image, an equation, a page break or a rule where the saved Markdown names
    // one. A pending change cannot write one: where it writes the name, the name is the text it writes.
    const native = piece.mark !== 'added' && mark !== 'added';
    const chip = piece.kind === 'chip' && native;
    const held = chip && piece.text === 'Image' ? images[image++] : undefined;
    const spaced = apart && !piece.kind && !piece.text.trim();
    apart = held !== undefined && image <= tethered.length;
    if (piece.mark && piece.mark === hidden) {
      left.push(piece);
      continue;
    }
    if (apart) kept.push(held);
    if (apart || spaced) continue;
    leave();
    if (stays(piece)) beside = piece.run;
    const text = piece.run ? textLooks[piece.run.look] : typed(piece);
    const change = piece.mark;
    if (piece.kind === 'hr' && native) runs.push({ rule: true, look: text });
    else if (held !== undefined) runs.push({ object: held, look: text });
    else if (chip && piece.text === 'Page break') runs.push({ break: 'page', look: text });
    else if (chip) runs.push({ chip: piece.text, look: text, change });
    else if (piece.kind === 'chip') runs.push({ text: `[${piece.text}]`, look: text, change });
    else runs.push({ text: piece.kind === 'br' ? '\u000b' : piece.text, look: text, link: piece.href, change });
  }
  leave();

  return {
    style,
    look,
    end: saved ? textLooks[saved.end] : runs.findLast(run => run.look)?.look ?? base,
    runs,
    list,
    objects: kept,
    headingId: item.heading && saved?.headingId,
    level: item.heading,
    mark,
  };
}

/**
 * The tab as the view shows it: the items pages.js sets on sheets, each element marked with the
 * row it draws and, where the row is a change, with the place the navigator counts it in.
 */
function compose() {
  const { drawing, rows, drawnOf } = tab;
  const { margins } = drawing.sections[0];
  const state = { lists: {}, list: undefined, before: undefined, container: undefined };
  const draw = drawer(drawing, drawing.page.width - margins.left - margins.right, state.lists);
  const hidden = view === 'after' ? 'removed' : view === 'before' ? 'added' : undefined;
  const items = [];
  const keys = new Set();
  let stop = -1;
  let marked = false;
  let fresh = false;

  for (const [index, { item, mark, words, was, over }] of rows.entries()) {
    const saved = was && drawnOf(was);
    if (mark && !marked) stop++;
    marked = !!mark;
    const key = mark && `${mark}\u0000${blockKey(item)}`;
    if (key) keys.add(key);
    const place = element => {
      element.dataset.row = index;
      if (!mark) return;
      element.dataset.stop = stop;
      if (!loaded || shown.has(key)) return;
      element.classList.add('fresh');
      fresh = true;
    };

    // A whole block the view leaves out is a mark where it is left out, one for all side by side.
    // One written over needs none: the block that took its place is there, and marked.
    if (mark && mark === hidden && over) continue;
    if (mark && mark === hidden) {
      const text = item.type === 'table' ? 'a table' : `“${excerpt(plain(wordsOf(item.text)).trim())}”`;
      const last = items.at(-1);
      if (last?.gap) {
        last.element.title = `${++last.count} paragraphs ${hidden} here, from ${last.text}`;
      } else {
        const element = make('div', hidden === 'removed' ? 'omit gone' : 'omit came');
        element.title = `${hidden === 'removed' ? 'Removed' : 'Added'} here: ${text}`;
        place(element);
        items.push({ element, gap: true, count: 1, text });
      }
      continue;
    }
    if (saved?.type === 'section' && !mark) {
      items.push({ section: saved.section });
      state.list = state.before = state.container = undefined;
      continue;
    }

    let elements;
    if (saved && mark !== 'changed' && mark !== 'added') {
      // Left alone, or removed: the block as Google has it.
      elements = draw.blocks(saved, mark);
      state.list = saved.list?.id;
      // What is being removed is not there for a new paragraph to be written into.
      if (mark !== 'removed') {
        state.before = state.container = saved.type === 'paragraph'
          ? { style: saved.style, look: drawing.paragraphLooks[saved.look], end: drawing.textLooks[saved.end], list: !!saved.list }
          : undefined;
      }
    } else if (item.type === 'table' || item.type === 'structure') {
      const { paragraph, text } = namedOf('NORMAL_TEXT');
      elements = [draw.paragraph({ look: paragraph, end: text, runs: [{ chip: item.type === 'table' ? 'Table' : item.text, look: text }], mark })];
      state.list = state.before = state.container = undefined;
    } else {
      const model = written(item, words, saved?.type === 'paragraph' ? saved : undefined, was, mark, hidden, state);
      elements = [draw.paragraph(model)];
      state.list = model.list?.id;
      state.before = { style: model.style, look: model.look, end: model.end, list: !!model.list };
      if (saved) state.container = state.before;
    }
    for (const element of elements) {
      place(element);
      items.push({ element });
    }
  }
  return { items, keys, fresh, draw };
}

// ---------------------------------------------------------------------------------------------
// The page navigator: steps from sheet to sheet, where the tab is drawn on more than one

const pager = partNavigator('page');

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
  // The outline stands at the edge of the page as it is drawn.
  document.documentElement.style.setProperty('--width', `${sheetWidth * scale}px`);
  markPage();
}
new ResizeObserver(fit).observe(page);

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
  const { items, keys, fresh, draw } = compose();
  // A tab with nothing pending has one copy.
  views.hidden = !tab.changed;
  press(views, view);
  showPage();
  // The sheets are measured as they are filled, so they are filled at their own size.
  sheets.style.transform = '';
  sheets.className = view === 'inline' ? 'redline' : '';
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
addControl(views);

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

// What a row's change does: adds or removes, or edits, as a block written over another and a
// paragraph whose words both come and go do, and one restyled with its words left alone.
function changeOf({ mark, words, over }) {
  if (over) return 'changed';
  if (mark !== 'changed') return mark;
  const marks = new Set(words.flatMap(word => word.mark ?? []));
  return marks.size === 1 ? [...marks][0] : 'changed';
}

let headings = [];
let entries = [];
// What has been folded away: a tab by its ID, a heading by its tab, level and text, and by
// which of the headings that share those it is.
const folded = new Set();
const fold = (key, label) => foldArrow(key, label, folded, renderOutline);
let reading = -1;

// What a heading says, without what is drawn beside its text or is being removed from it.
function headingText(heading) {
  const copy = heading.cloneNode(true);
  for (const gone of copy.querySelectorAll(view === 'inline' ? 'del, .marker, .tick, .obj' : '.marker, .tick, .obj')) gone.remove();
  return copy.textContent.replaceAll('⁠', '').trim();
}

function renderOutline() {
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
    if ('stop' in block.dataset) touched[section]?.push(changeOf(tab.rows[block.dataset.row]));
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
    const says = touch(name, added ? ['added'] : listed.pending ? ['changed'] : []);
    name.title = added ? `${listed.title} (new, not yet added)` : says ? `${listed.title} (${says})` : listed.title;
    name.setAttribute('aria-pressed', String(on));
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
}

/** Marks the heading the top of the view is under, or the one it is folded under. */
function markHeading() {
  if (outline.hidden || !rail.isConnected) return;
  let current = 0;
  headings.forEach((heading, index) => {
    if (heading.getBoundingClientRect().top <= 96) current = index;
  });
  while (current > 0 && entries[current].parentElement.hidden) current--;
  entries.forEach((entry, index) => entry.setAttribute('aria-current', String(index === current)));
  const row = entries[current]?.parentElement;
  if (!row) return;
  thumb.style.transform = `translateY(${row.offsetTop}px)`;
  thumb.style.height = `${row.offsetHeight}px`;
  // The outline follows the reading, so the heading being read stays in it. At the first
  // heading that is the top of the outline, where the tabs are.
  if (current === 0) outline.scrollTop = 0;
  else if (current !== reading) row.scrollIntoView({ block: 'nearest' });
  reading = current;
}

addEventListener('scroll', () => requestAnimationFrame(() => {
  markHeading();
  markPage();
}), { passive: true });
outline.addEventListener('outlinechange', markHeading);

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
  const address = link.dataset.href ?? '';
  const [, to, kind, id] = /^(?:\?tab=([^#]*))?(?:#(heading|bookmark)=(.*))?$/.exec(address) ?? [];
  if (to === undefined && kind === undefined) {
    if (!/^https?:\/\//i.test(address)) return { hint: address };
    return link.closest('ins, del, .added, .removed')
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

page.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches?.('.link.go:not([href])')) event.target.click();
});

page.addEventListener('click', async event => {
  const link = event.target.closest?.('.link');
  if (!link) return;
  const { tab: to, heading } = destination(link);
  if (to) {
    selectTab(to);
    await load();
  }
  const target = heading && headingAt(heading);
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: motion() });
  flash(target);
});

// ---------------------------------------------------------------------------------------------
// Loading and refreshing

function selectTab(id) {
  tabId = id;
  loaded = false;
  shown = new Set();
  // The copies offered are of the tab drawn, which is the one left until this one is read.
  views.hidden = true;
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
    // One read: the tab as saved, the tab with its pending changes, and those changes. Asked
    // for with the list, as the tab shown is nearly always still on it.
    let pending = tabId && Promise.resolve(gadget.getPendingChanges(tabId));
    pending?.catch(() => {});
    const listed = await listing;
    if (current !== generation) return;
    tabs = listed;
    if (!tabs.some(found => found.id === tabId)) {
      selectTab(([tabs[at], ...tabs].find(found => found?.title === title) ?? tabs.find(found => found.pending) ?? tabs[0])?.id);
      showSkeleton();
      pending = gadget.getPendingChanges(tabId);
    }
    if (tab) renderOutline();
    const { savedMarkdown, markdown, changes, revisionId } = await pending;
    if (current !== generation) return;
    // Without its drawing the tab is still drawn, as a document of Google's own styles.
    const drawing = await readDrawing(savedMarkdown, revisionId).catch(() => BLANK);
    if (current !== generation) return;
    const stale = changes.filter(change => change.stale).length;
    // The card is over every tab while a change waits on any of them.
    pager.lift(changes.length > 0 || tabs.some(listed => listed.pending));
    // Nothing of this tab moved, as when a change is made to another: what is drawn stands.
    if (loaded && !page.hidden && tab.drawing === drawing && tab.savedMarkdown === savedMarkdown && tab.markdown === markdown) {
      for (const arrived of document.querySelectorAll('.fresh')) arrived.classList.remove('fresh');
      // An image that could not be read is asked for again.
      showPictures();
      showStale(stale, 'document');
      return void status('');
    }

    // The Markdown does not escape the document's text, so a paragraph whose text starts "# "
    // reads in it as a heading, and one that is "<table>" as a table: the drawing says which
    // lines are those. Without it, every line is what it reads as.
    const lines = savedMarkdown.split('\n');
    const plain = new Set(drawing.blocks.filter(block => block.type === 'paragraph' && !headingLevel(block.style) &&
      /^#{1,6} /.test(block.runs.map(run => run.text ?? '').join(''))).map(block => lines[block.line]));
    const tables = drawing === BLANK ? undefined
      : new Set(drawing.blocks.filter(block => block.type === 'table').map(block => block.line));
    const saved = parseBlocks(savedMarkdown, (_, line) => tables?.has(line) ?? true, plain);
    const byLine = new Map(drawing.blocks.map(block => [block.line, block]));
    // An empty line is an empty paragraph, whatever its style.
    const drawnOf = block => {
      const drawn = byLine.get(block.line);
      return block.text || drawn?.type === 'paragraph' && !drawn.runs.length ? drawn : undefined;
    };
    const fits = saved.every(block => !block.text || !drawnOf(block) || sameKind(block, drawnOf(block)));
    const held = tablesOf(saved);
    const rows = pairEdits(diff(saved, markdown === savedMarkdown ? saved : parseBlocks(markdown, text => held.has(text), plain), blockKey));
    tab = { drawing, savedMarkdown, markdown, rows, drawnOf: fits ? drawnOf : () => undefined, changed: rows.some(row => row.mark) };
    if (!tab.changed) view = 'after';

    render(true);
    showStale(stale, 'document');
    status('');
    loaded = true;
  } catch (error) {
    if (current !== generation) return;
    status('');
    views.hidden = true;
    showError(error, 'document', load);
  }
}

export default {
  main(session) {
    gadget = session;
    loadOnRefresh(load);
  },
};
