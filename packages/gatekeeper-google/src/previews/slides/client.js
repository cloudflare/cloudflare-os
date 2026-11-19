// The Google Slides preview (GooglePresentationGatekeeperImpl.getPreviewUi()): gadget-format client
// code that runs in the gadget UI frame, whose page starts it with main(gadget), at the end of this
// file. There `gadget` is a GooglePresentationSession rather than a gadget server.
// The gatekeeper imports it as text through client.txt, a symlink to this file, and returns it
// with slide.js and shapes.js, which draw one slide, and ui/chrome.js, which the previews of this
// gatekeeper share.
//
// Everything the presentation says is set as text or built node by node. Nothing from it is parsed
// as HTML into this document. A link is followed only from a slide drawn as Google Slides has it
// saved: text of a pending change is not yet approved.

import {
  dataUrl, flash, fontReader, leaveOutline, lineIcon, loadOnRefresh, make, motion, outline, outlineList, page, setOutline,
  setStops, showError, showLoading, showPage, showStale, status, SYSTEM_FONT,
} from './ui/chrome.js';
import { boxOf, drawSlide, LINE_HEIGHT } from './slide.js';

// The session main() is handed, which every read below goes through.
let gadget;

// How many slides are drawn, the rest being listed by title, and how many are read at once.
const MAX_DRAWN = 50;
const BATCH = 10;
const MAX_PICTURES = 75;
const MAX_FONTS = 24;
// How long the first drawing of a slide waits for its fonts before it is drawn without them.
const FONT_WAIT_MS = 2500;

const styleSheet = document.createElement('style');
styleSheet.textContent = `
  :root { --width: 960px; }
  /* The buttons that float at the top have the desk behind them, never a slide. */
  body::before { content: ''; position: fixed; z-index: 1; inset: 0 0 auto; height: 52px;
    background: linear-gradient(var(--desk) 80%, transparent); pointer-events: none; }
  #page { box-sizing: border-box; max-width: var(--width); margin: 0 auto 120px; padding: 46px 16px 0;
    overflow-x: clip; animation: arrive .25s ease-out; }
  #page > .ghost { max-width: 100%; }
  .limit, .empty { margin: 0 0 18px; font-size: 12px; color: var(--dim); }
  .empty { margin: 96px 0; text-align: center; font-size: 13px; }
  .card { margin: 0 0 30px; scroll-margin-top: 52px; }
  .card > header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-height: 28px;
    margin-bottom: 8px; font-size: 12px; color: var(--dim); }
  .no { display: grid; flex: none; place-items: center; box-sizing: border-box; min-width: 22px;
    height: 22px; padding: 0 6px; border-radius: 999px; background: var(--chip); color: var(--ink);
    font-weight: 700; font-variant-numeric: tabular-nums; }
  .title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--ink); font-size: 13px; font-weight: 700; }
  .tags { display: flex; flex: none; gap: 6px; }
  .tags:empty { display: none; }
  .tag { display: flex; align-items: center; gap: 4px; padding: 0 8px; border-radius: 999px;
    background: var(--chip); color: var(--dim); font-size: 11px; line-height: 1.8; white-space: nowrap; }
  .tag.added, .tag.changed { background: var(--mark); color: var(--mark-ink); }
  .tag.gone { background: var(--gone); color: var(--gone-ink); }
  /* The slide as it will be, or as it is saved: one control of two halves. */
  .views { display: flex; flex: none; margin-left: auto; padding: 2px; border-radius: 999px;
    background: var(--chip); }
  .views button { padding: 2px 10px; border: 0; border-radius: 999px; background: none;
    color: var(--dim); font-size: 11px; line-height: 1.6; transition: background .15s, color .15s, box-shadow .15s; }
  .views button:hover { color: var(--ink); }
  .views button[aria-pressed="true"] { background: var(--page); color: var(--ink);
    box-shadow: 0 1px 2px rgb(0 0 0 / .22); }

  /* A slide lies on the desk as a page does, and keeps its own colors on either desk. */
  .frame { position: relative; aspect-ratio: var(--ratio); --ring: var(--mark-ink); --halo: var(--mark); }
  .card.gone .frame { --ring: var(--gone-ink); --halo: var(--gone); }
  .sheet { position: absolute; inset: 0; overflow: hidden; border-radius: 2px; background-color: #fff;
    box-shadow: var(--paper); transition: box-shadow .2s ease-out; }
  .card:is(.added, .gone) .sheet { box-shadow: 0 0 0 2px var(--ring), 0 0 0 6px var(--halo), var(--paper); }
  .card.gone .stage, .film.gone .stage { opacity: .45; filter: grayscale(1); }
  .card.here .sheet { box-shadow: 0 0 0 3px var(--ring), 0 0 0 9px var(--halo), var(--float); }
  .stage.first { animation: arrive .3s ease-out; }
  /* One view of the slide fades in over the other. */
  .stage.over { animation: over .18s ease-out; }
  @keyframes over { from { opacity: 0; } }

  /* What a pending change touches: ringed where it is and numbered, and named under the slide,
     where a name covers nothing. The rings are on the slide, so they keep one color on either
     desk, with a pale edge that shows on a dark slide. */
  .marks { position: absolute; inset: 0; pointer-events: none; --spot: #188038; --lost: #d93025; }
  .spot { position: absolute; box-sizing: content-box; margin: -5px; padding: 3.5px; min-width: 4px;
    min-height: 4px; border: 1.5px solid var(--spot); border-radius: 6px; color: var(--spot);
    box-shadow: 0 0 0 1px rgb(255 255 255 / .75), 0 0 0 4px color-mix(in srgb, currentColor 16%, transparent);
    transition: left .2s ease-out, top .2s ease-out, width .2s ease-out, height .2s ease-out, box-shadow .2s ease-out;
    animation: arrive .3s ease-out .1s backwards; }
  .spot.gone { border-style: dashed; border-color: var(--lost); color: var(--lost);
    background: color-mix(in srgb, currentColor 6%, transparent); }
  .spot.off { visibility: hidden; }
  .spot > i, .change > i { display: grid; flex: none; place-items: center; box-sizing: border-box;
    min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px; color: #fff; font-size: 9.5px;
    font-style: normal; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
  /* The number rides the ring's corner, outside what it rings. */
  .spot > i { position: absolute; top: -9px; left: -9px; background: var(--spot);
    box-shadow: 0 0 0 1.5px rgb(255 255 255 / .9); }
  .spot.gone > i { background: var(--lost); }
  .spot:is(.here, .lit) { box-shadow: 0 0 0 1px rgb(255 255 255 / .75), 0 0 0 7px color-mix(in srgb, currentColor 32%, transparent); }
  .changes { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; padding: 0; list-style: none; }
  .change { display: flex; align-items: center; gap: 6px; padding: 3px 9px 3px 4px; border: 0;
    border-radius: 999px; background: var(--mark); color: var(--mark-ink); font-size: 11px;
    line-height: 1.4; white-space: nowrap; transition: box-shadow .15s ease-out; }
  .change > i { background: var(--mark-ink); color: var(--page); }
  .change.gone { background: var(--gone); color: var(--gone-ink); }
  .change.gone > i { background: var(--gone-ink); }
  .change.off { opacity: .55; }
  .change:is(:hover, .here) { box-shadow: 0 0 0 1.5px currentColor; }

  .notes { margin-top: 10px; padding: 8px 12px 10px; border-radius: 8px; background: var(--page);
    box-shadow: var(--paper); font-size: 12px; line-height: 1.5; white-space: pre-wrap;
    overflow-wrap: anywhere; transition: box-shadow .2s ease-out; }
  .notes > b { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; color: var(--dim);
    font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
  .notes.same > div { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical;
    -webkit-line-clamp: 3; color: var(--dim); }
  .notes > .ghost { width: 60%; margin: 8px 0 4px !important; }
  .notes.here { box-shadow: 0 0 0 2px var(--mark-ink), 0 0 0 6px var(--mark), var(--paper); }
  ins { background: var(--mark); color: var(--mark-ink); text-decoration: none; }
  del { background: var(--gone); color: var(--gone-ink);
    text-decoration: line-through color-mix(in srgb, currentColor 55%, transparent); }
  ins, del { border-radius: 2px; padding: 1px 0; }
  del + ins { margin-left: 3px; }

  /* The slides past the ones drawn are a list of their titles, each run of them one sheet. */
  .card.listed { margin: 0; padding: 5px 10px; background: var(--page); box-shadow: var(--paper);
    clip-path: inset(0 -20px); }
  .card.listed > header { margin: 0; }
  .card.listed .title { font-weight: 400; }
  .card.listed + .card.listed { border-top: 1px solid var(--line); }
  :not(.listed) + .card.listed, .card.listed:first-child { padding-top: 8px; border-radius: 8px 8px 0 0;
    clip-path: inset(-20px -20px 0); }
  .card.listed:not(:has(+ .listed)) { margin-bottom: 30px; padding-bottom: 8px; border-radius: 0 0 8px 8px;
    clip-path: inset(0 -20px -20px); }
  :not(.listed) + .card.listed:not(:has(+ .listed)) { border-radius: 8px; clip-path: none; }

  /* The filmstrip: every slide in order, small, with what is to happen to it. */
  #outline .film { display: flex; align-items: flex-start; gap: 8px; box-sizing: border-box;
    width: 100%; margin: 0 0 2px; padding: 6px 6px 6px 0; border: 0; border-radius: 8px;
    background: none; color: var(--dim); text-align: left; scroll-margin: 46px 0 8px;
    transition: background .12s; }
  #outline .film:hover { background: var(--chip); }
  .film:focus-visible { outline-offset: -2px; }
  .film > i { display: flex; flex: none; flex-direction: column; align-items: flex-end; gap: 9px;
    width: 22px; padding-top: 1px; font-size: 11px; font-style: normal; font-variant-numeric: tabular-nums; }
  .film[aria-current="true"] > i { color: var(--link); font-weight: 700; }
  .mini { position: relative; display: block; flex: 1; min-width: 0; aspect-ratio: var(--ratio);
    overflow: hidden; border-radius: 4px; background-color: #fff; box-shadow: 0 0 0 1px var(--line);
    pointer-events: none; transition: box-shadow .15s ease-out; }
  .film.listed > .mini { display: flex; align-items: center; gap: 6px; padding: 0 8px; aspect-ratio: auto;
    min-height: 28px; background: var(--chip); box-shadow: none; color: var(--ink); font-size: 11px; }
  .film.added > .mini { box-shadow: 0 0 0 2px var(--mark-ink); }
  .film.gone > .mini { box-shadow: 0 0 0 2px var(--gone-ink); }
  #outline .film[aria-current="true"] > .mini { box-shadow: 0 0 0 2px var(--link), 0 0 0 5px color-mix(in srgb, var(--link) 22%, transparent); }
  .mini > .tags { position: absolute; top: 4px; right: 4px; gap: 3px; }
  .mini .tag { padding: 0 6px; font-size: 9.5px; font-weight: 700; box-shadow: 0 0 0 1.5px #fff; }
  .film.listed .tags { position: static; margin-left: auto; }
  .film.listed .tag { box-shadow: none; }
  .film.listed .mini > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
document.head.append(styleSheet);

const pause = time => new Promise(resolve => setTimeout(resolve, time));

// ---------------------------------------------------------------------------------------------
// The deck: every slide of either copy in order, and what the pending changes do to each

const SKIPPED = 'M3 3l14 14M10 5c4.5 0 7 5 7 5a12 12 0 01-2.2 2.8M12.8 14.3A7 7 0 0110 15c-4.5 0-7-5-7-5a12 12 0 013-3.4';
const NOTES = 'M4 5h12M4 9h12M4 13h7';

const tag = (text, kind, short = text) => ({ text, kind, short });

// One row for each slide: `slide` as it will be and `was` as it is saved, either of which a
// pending change can leave out. A deleted slide stays where it was.
function listSlides({ changes, savedPresentation, presentation }) {
  const before = new Map(savedPresentation.slides.map(slide => [slide.id, slide]));
  const after = new Map(presentation.slides.map(slide => [slide.id, slide]));
  const live = changes.filter(change => !change.stale);
  const moved = new Set(live.filter(change => change.type === 'moveSlides').flatMap(change => change.slideIds));
  const touched = new Set(live.flatMap(change => change.slideIds));
  // A change to a layout or a master counts on every slide made from it.
  const edits = new Map();
  for (const change of live) {
    for (const part of change.type === 'updateSlides' ? change.changes : []) {
      const on = before.has(part.slideId) || after.has(part.slideId) ? [part.slideId] : change.slideIds;
      for (const id of on) edits.set(id, (edits.get(id) ?? 0) + 1);
    }
  }
  const row = (slide, was) => {
    const { id, title } = slide ?? was;
    const count = edits.get(id);
    const tags = [
      !was && tag('New', 'added'),
      !slide && tag('Deleted', 'gone'),
      slide && was && moved.has(id) && slide.index !== was.index && tag(`Moved from ${was.index + 1}`, 'changed', 'Moved'),
      slide && was && slide.skipped !== was.skipped && tag(slide.skipped ? 'Skipped' : 'No longer skipped', 'changed', slide.skipped ? 'Skipped' : 'Shown'),
      slide && was && count && tag(count === 1 ? '1 change' : `${count} changes`, 'changed', 'Changed'),
      slide?.skipped && was?.skipped && tag('Skipped', 'plain'),
    ].filter(Boolean);
    return {
      id, slide, was, tags, title: title || 'Untitled slide',
      touched: touched.has(id) || tags.some(({ kind }) => kind !== 'plain'),
      // What the listing says of the slide, which an edit made elsewhere changes.
      seen: JSON.stringify([slide, was]),
    };
  };
  const rows = presentation.slides.map(slide => row(slide, before.get(slide.id)));
  savedPresentation.slides.forEach((was, n) => {
    if (after.has(was.id)) return;
    const previous = rows.findIndex(({ id }) => id === savedPresentation.slides[n - 1]?.id);
    rows.splice(previous + 1, 0, row(undefined, was));
  });
  return rows;
}

// The slides to draw: the ones the changes touch, then the ones beside those, then the rest.
function pick(rows) {
  const changed = rows.flatMap((row, n) => row.touched ? [n] : []);
  const order = [...changed, ...changed.flatMap(n => [n - 1, n + 1]), ...rows.keys()];
  return new Set([...new Set(order)].filter(n => rows[n]).slice(0, MAX_DRAWN).map(n => rows[n].id));
}

// ---------------------------------------------------------------------------------------------
// What a pending change did to a slide: element by element, then word by word in its notes

const OPS = {
  editText: 'Text edited', formatText: 'Text formatted', formatParagraphs: 'Paragraphs formatted',
  createShape: 'Added', updateShape: 'Restyled', setAltText: 'Description', arrange: 'Reordered',
  insertImage: 'Image added', replaceImage: 'Image replaced', createTable: 'Table added',
  insertTableRows: 'Rows added', insertTableColumns: 'Columns added', deleteTableRows: 'Rows deleted',
  deleteTableColumns: 'Columns deleted', formatTableCells: 'Cells formatted',
};

const plain = ({ changes: _, ...element }) => JSON.stringify(element);

function moveOf(element, was) {
  const [now, then] = [element.bounds, was.bounds];
  const resized = Math.abs(now.width - then.width) > .01 || Math.abs(now.height - then.height) > .01;
  const moved = Math.abs(now.x - then.x) > .01 || Math.abs(now.y - then.y) > .01;
  return element.rotation !== was.rotation && !resized ? 'Rotated'
    : resized ? (moved ? 'Moved and resized' : 'Resized') : 'Moved';
}

function nameOf(element, was) {
  if (!was) return element.kind === 'picture' ? 'Image added' : element.kind === 'table' ? 'Table added' : 'Added';
  const names = (element.changes ?? []).map(({ op }) => op === 'setBounds' && element.bounds && was.bounds
    ? moveOf(element, was) : OPS[op] ?? 'Changed');
  const unique = [...new Set(names)];
  return unique.length > 2 ? `${unique[0]} +${unique.length - 1}` : unique.join(' · ') || 'Changed';
}

// Each element the changes touch: where it is in each copy, and what to call the change.
function spotsOf(after, before) {
  const was = new Map(before.elements.map(element => [element.id, element]));
  const spots = [];
  for (const element of after.elements) {
    const old = was.get(element.id);
    was.delete(element.id);
    // What a slide takes from its layout is marked only when the change was made to it there.
    const differs = !element.from && (!old || plain(old) !== plain(element));
    if (!element.changes && !differs) continue;
    spots.push({ id: element.id, name: nameOf(element, old), after: boxOf(element), before: old && boxOf(old) });
  }
  for (const gone of was.values()) spots.push({ id: gone.id, name: 'Deleted', gone: true, before: boxOf(gone) });
  return spots;
}

// Past this many comparisons the notes are shown as replaced whole.
const DIFF_LIMIT = 400_000;

// The words of `after`, each marked 'added' when `before` lacks it, with the words that are gone
// marked 'removed' where they were.
function wordChanges(before, after) {
  const [a, b] = [before, after].map(text => text.match(/\s+|\S+/g) ?? []);
  if (a.length * b.length > DIFF_LIMIT) return [{ text: before, mark: 'removed' }, { text: after, mark: 'added' }];
  const width = b.length + 1;
  // The longest run both share, counted from each position to the end.
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? common[(i + 1) * width + j + 1] + 1
        : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const words = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) words.push({ text: b[(i++, j++)] });
    else if (j === b.length || (i < a.length && common[(i + 1) * width + j] >= common[i * width + j + 1])) words.push({ text: a[i++], mark: 'removed' });
    else words.push({ text: b[j++], mark: 'added' });
  }
  return words;
}

// ---------------------------------------------------------------------------------------------
// Fonts: the presentation's own, which the session reads from Google Fonts for this frame

// The families listFonts() named, which are the ones readFont() reads, and the ones it did not.
let listed = new Set();
const unlisted = new Set();
// The listing, asked for at most once each time the presentation is loaded.
let listing;

function* looksOf(slide) {
  for (const element of slide?.elements ?? []) {
    const texts = element.kind === 'table' ? element.cells.flat().map(cell => cell?.text) : [element.text];
    for (const paragraph of texts.flatMap(text => text ?? [])) {
      yield* paragraph.runs;
      if (paragraph.bullet) yield paragraph.bullet;
    }
  }
}

// Where Slides puts the baseline in a line, which is not where a browser left to itself would: as
// far down as the font's typographic ascender says, or as far up from the line's foot as its
// descender says where the font is taller than the line. A file that does not say is drawn by the
// measures the browser finds in it.
function measuresOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map();
  const count = bytes.byteLength >= 12 ? view.getUint16(4) : 0;
  for (let n = 0, at = 12; n < count && at + 16 <= bytes.byteLength; n++, at += 16) {
    tables.set(String.fromCharCode(...bytes.subarray(at, at + 4)), view.getUint32(at + 8));
  }
  const [head, metrics] = [tables.get('head'), tables.get('OS/2')];
  if (head === undefined || metrics === undefined || head + 20 > bytes.byteLength || metrics + 72 > bytes.byteLength) return {};
  const size = view.getUint16(head + 18);
  const [ascender, descender] = [68, 70].map(at => view.getInt16(metrics + at) / size);
  const ascent = Math.min(ascender, LINE_HEIGHT + descender);
  if (!(ascent > .5 && ascent < LINE_HEIGHT)) return {};
  return { ascentOverride: `${ascent * 100}%`, descentOverride: `${(LINE_HEIGHT - ascent) * 100}%`, lineGapOverride: '0%' };
}

const faces = fontReader((...font) => gadget.readFont(...font), MAX_FONTS, measuresOf);

// Reads the fonts these slides are set in that have not been asked for, and says whether any
// arrived, which changes how every slide already drawn is laid out.
async function readFonts(slides) {
  const wanted = slides.flatMap(slide => [...looksOf(slide)].map(({ fontFamily, fontWeight, italic = false }) => [fontFamily, fontWeight, italic]))
    .filter(font => !SYSTEM_FONT.test(font[0]) && !faces.asked(...font));
  if (!wanted.length) return false;
  const families = [...new Set(wanted.map(([family]) => family))];
  if (families.some(family => !listed.has(family) && !unlisted.has(family))) {
    listing ??= gadget.listFonts().then(fonts => {
      listed = new Set(fonts.map(font => font.family));
      return true;
    }, () => false);
    // A family the listing leaves out is not asked about again.
    if (await listing) for (const family of families) if (!listed.has(family)) unlisted.add(family);
  }
  return faces.read(wanted.filter(([family]) => listed.has(family)));
}

// ---------------------------------------------------------------------------------------------
// Pictures: each is an <img> naming its picture, filled once its bytes are read

// Each picture asked for, by its ID, and its data: URL once read. A picture's ID is its own across
// the presentation, so one a master puts on every slide is read once.
const pictures = new Map();
let reading = Promise.resolve();

function showPictures() {
  for (const image of document.querySelectorAll('img[data-picture]:not([src])')) {
    const id = image.dataset.picture;
    const slideId = image.closest('[data-slide]')?.dataset.slide;
    let picture = pictures.get(id);
    if (!picture && slideId && pictures.size < MAX_PICTURES) {
      pictures.set(id, picture = {});
      // One at a time, so no more than one picture is in flight.
      reading = reading.then(async () => {
        if (pictures.get(id) !== picture) return;
        const { mimeType, bytes } = await gadget.readPicture(id, slideId);
        picture.url = await dataUrl(bytes, mimeType);
      }).catch(() => {}).then(() => {
        picture.read = true;
        showPictures();
      });
    }
    // A picture past the limit, or one that could not be read, is a plain box.
    const box = image.closest('.pic');
    box?.classList.toggle('wait', !!picture && !picture.read);
    box?.classList.toggle('none', !picture || (picture.read && !picture.url));
    if (picture?.url) image.src = picture.url;
  }
}

// Forgets the pictures that are a slide's own, which a change to the slide may have changed.
function forgetPictures(slideId) {
  const { drawing, saved } = drawings.get(slideId) ?? {};
  for (const slide of [drawing, saved]) {
    if (slide?.background?.pictureId === slideId) pictures.delete(slideId);
    for (const element of slide?.elements ?? []) if (!element.from && element.pictureId) pictures.delete(element.pictureId);
  }
}

// ---------------------------------------------------------------------------------------------
// The cards: one for each slide, holding it drawn, what changes on it, and its speaker notes

// The slide's size in points.
let size = { width: 720, height: 405 };
let rows = [];
const cards = new Map();
// What readSlideDrawings() returned for each slide, or `large` for one whose drawing is more than
// a read returns, and what the listing said of the slide then.
const drawings = new Map();
const TOO_LARGE = /too large to read at once/;
// A slide too large to read is not asked for again until the listing says it has changed.
const tooLarge = ({ id, seen }) => drawings.get(id)?.large === true && drawings.get(id).seen === seen;
// How long after a read that said shapes' outlines were still on their way each further read of
// those slides waits: three, after which the shapes are drawn as ones with no outline.
const OUTLINE_WAITS_MS = [2000, 4000, 8000];

// A stage is drawn at the slide's own size and scaled to the box it is in.
const scale = box => box.style.setProperty('--k', box.clientWidth / size.width || 1);
const boxes = new ResizeObserver(entries => entries.forEach(({ target }) => scale(target)));
function makeCard(id) {
  const node = make('section', 'card');
  node.dataset.slide = id;
  const header = node.appendChild(make('header'));
  // The header's parts stay as they are made, so that what has the focus keeps it.
  header.append(make('span', 'no'), make('span', 'title'), make('span', 'tags'));
  const frame = node.appendChild(make('div', 'frame'));
  const sheet = frame.appendChild(make('div', 'sheet wait'));
  const mini = make('span', 'mini wait');
  const card = { id, node, header, frame, sheet, marks: frame.appendChild(make('div', 'marks')), mini,
    changes: node.appendChild(make('ul', 'changes')), view: 'after', stages: [], spots: [], stops: [] };
  card.changes.hidden = true;
  boxes.observe(sheet);
  boxes.observe(mini);
  return card;
}

function tagNode({ text, kind, short }, brief) {
  const node = make('span', `tag ${kind}`, brief ? short : text);
  if (text.startsWith('Skipped') && !brief) node.prepend(lineIcon(SKIPPED, 12));
  return node;
}

function showHeader(card, row, number) {
  const [place, title, tags] = card.header.children;
  place.textContent = number;
  title.textContent = title.title = row.title;
  tags.replaceChildren(...row.tags.map(found => tagNode(found)));
  card.node.classList.toggle('added', !row.was);
  card.node.classList.toggle('gone', !row.slide);
}

// The slide as it will be, and the slide as saved, between which a card that has both chooses.
// The two buttons are made once, so the one pressed keeps the focus.
function showViews(card) {
  if (!card.differs || !card.after || !card.before) {
    card.views?.remove();
    card.views = undefined;
    return;
  }
  if (!card.views?.isConnected) {
    card.views = card.header.appendChild(make('div', 'views'));
    card.views.setAttribute('role', 'group');
    card.views.setAttribute('aria-label', 'Which slide to show');
    for (const [view, label] of [['after', 'With changes'], ['before', 'As saved']]) {
      const button = card.views.appendChild(make('button', '', label));
      button.dataset.view = view;
      button.addEventListener('click', () => {
        if (card.view === view) return;
        card.view = view;
        showViews(card);
        paint(card, true);
        showPictures();
      });
    }
  }
  for (const button of card.views.children) button.setAttribute('aria-pressed', String(card.view === button.dataset.view));
}

// Where the element `id` shows on `stage`, in the slide's points: `frame`, its box, reaching as far
// as its text is drawn, which a box too small for it lets spill, and only the text where nothing
// of the box is drawn. `frame` itself for an element with no text, or on a stage not laid out.
function inked(stage, id, frame) {
  const node = stage.querySelector(`.el[data-id="${CSS.escape(id)}"]`);
  const words = node?.querySelector(':scope > .words');
  const sheet = stage.getBoundingClientRect();
  // Each run's lines, a paragraph's own box being as wide as the element's whatever it holds.
  const lines = [...words?.querySelectorAll('p > *') ?? []].flatMap(run => [...run.getClientRects()]);
  if (!words?.textContent.trim() || !sheet.width || !lines.length) return frame;
  const scale = size.width / sheet.width;
  const edges = lines.map(line => [line.left, line.top, line.right, line.bottom].map((edge, n) => (edge - (n % 2 ? sheet.top : sheet.left)) * scale));
  if (node.querySelector(':scope > svg')) edges.push([frame.x, frame.y, frame.x + frame.width, frame.y + frame.height]);
  const [x, y, right, bottom] = [Math.min, Math.min, Math.max, Math.max].map((most, n) => most(...edges.map(edge => edge[n])));
  return { x, y, width: right - x, height: bottom - y };
}

// Draws the card's slide, large and in the filmstrip, as the view it is on has it: `over` what was
// drawn before, which it fades in above, when the view is what changed.
function paint(card, over) {
  const { after, before } = card;
  const slide = card.view === 'after' ? after : before;
  if (!slide) return;
  // Nothing on a slide that pending changes touch is approved yet, so none of its links are followed.
  const stage = drawSlide(slide, size, slide === before || !card.differs, card.pending);
  const small = drawSlide(after ?? before, size, false, card.pending);
  card.stages = [[stage, slide], [small, after ?? before]];
  if (card.sheet.classList.contains('wait')) stage.classList.add('first');
  card.sheet.classList.remove('wait');
  card.mini.classList.remove('wait');
  if (over && motion() === 'smooth') {
    const under = [...card.sheet.children];
    card.sheet.append(stage);
    stage.classList.add('over');
    stage.addEventListener('animationend', () => under.forEach(old => old.remove()), { once: true });
  } else {
    card.sheet.replaceChildren(stage);
  }
  card.mini.replaceChildren(small, ...card.mini.querySelectorAll('.tags'));
  for (const spot of card.spots) {
    const frame = spot.gone ? spot.before : spot[card.view];
    const box = frame && inked(stage, spot.id, frame);
    spot.node.classList.toggle('off', !box);
    spot.chip.classList.toggle('off', !box);
    spot.chip.title = box ? '' : 'Not on the slide as saved';
    if (!box) continue;
    // No further than the slide's edges, past which nothing of it shows.
    const [left, top] = [Math.max(box.x, 0), Math.max(box.y, 0)];
    const [right, bottom] = [Math.min(box.x + box.width, size.width), Math.min(box.y + box.height, size.height)];
    Object.assign(spot.node.style, {
      left: `${left / size.width * 100}%`, top: `${top / size.height * 100}%`,
      width: `${Math.max(right - left, 0) / size.width * 100}%`, height: `${Math.max(bottom - top, 0) / size.height * 100}%`,
    });
  }
}

function showNotes(card) {
  card.node.querySelector('.notes')?.remove();
  const [was, now] = [card.before, card.after].map(slide => slide?.speakerNotes ?? '');
  if (!was && !now) return;
  const changed = card.after && card.before && was !== now;
  const notes = card.node.appendChild(make('div', changed ? 'notes' : 'notes same'));
  const label = notes.appendChild(make('b', '', 'Speaker notes'));
  label.prepend(lineIcon(NOTES, 12));
  const text = notes.appendChild(make('div'));
  if (!changed) return void (text.textContent = now || was);
  for (const { text: word, mark } of wordChanges(was, now)) {
    if (mark) text.appendChild(make(mark === 'added' ? 'ins' : 'del', '', word));
    else text.append(word);
  }
  return notes;
}

// The slide as it will be and as it is saved, which are one where no change touches it.
function take(card, { drawing, saved }) {
  card.after = drawing ?? undefined;
  card.before = (saved === undefined ? drawing : saved) ?? undefined;
}

// Takes what was read for the card's slide: the marks on what changes, the notes, and the places
// the navigator stops at, which stay as they are however often the slide is drawn again.
function fill(card, slide) {
  take(card, slide);
  card.differs = slide.saved !== undefined;
  if (!card.after) card.view = 'before';
  if (!card.before || !card.differs) card.view = 'after';
  const both = card.differs && card.after && card.before;
  // Read from the top of the slide down, as the slide is.
  card.spots = (both ? spotsOf(card.after, card.before) : []).toSorted((a, b) => {
    const [first, second] = [a.after ?? a.before, b.after ?? b.before];
    return first.y - second.y || first.x - second.x;
  });
  // Each is a ring on the slide and a name under it, which share a number.
  for (const [n, spot] of card.spots.entries()) {
    spot.node = make('div', spot.gone ? 'spot gone' : 'spot');
    spot.node.append(make('i', '', String(n + 1)));
    spot.chip = make('button', spot.gone ? 'change gone' : 'change', spot.name);
    spot.chip.prepend(make('i', '', String(n + 1)));
    const light = on => () => spot.node.classList.toggle('lit', on);
    for (const [event, on] of [['pointerenter', true], ['focus', true], ['pointerleave', false], ['blur', false]]) spot.chip.addEventListener(event, light(on));
    spot.chip.addEventListener('click', () => {
      spot.node.scrollIntoView({ block: 'center', behavior: motion() });
      flash(spot.node);
    });
  }
  card.marks.replaceChildren(...card.spots.map(spot => spot.node));
  card.changes.replaceChildren(...card.spots.map(spot => {
    const item = make('li');
    item.append(spot.chip);
    return item;
  }));
  card.changes.hidden = card.spots.length === 0;
  showViews(card);
  const notes = showNotes(card);
  paint(card);
  card.stops = [...card.spots.map(spot => [spot.node, spot.chip]), ...notes ? [[notes]] : []];
}

// ---------------------------------------------------------------------------------------------
// The filmstrip: every slide in order, as it will be, with what is to happen to it

let films = [];
let current;

function renderFilmstrip() {
  let number = 0;
  films = rows.map(row => {
    const card = cards.get(row.id);
    const film = make('button', 'film');
    film.dataset.slide = row.id;
    film.title = [row.title, ...row.tags.map(({ text }) => text)].join(' · ');
    film.classList.add(...new Set(row.tags.map(({ kind }) => kind)));
    const tags = make('span', 'tags');
    tags.append(...row.tags.filter(({ short }) => short !== 'Changed').slice(0, 2).map(found => tagNode(found, true)));
    const mini = card.listed ? make('span', 'mini') : card.mini;
    if (card.listed) {
      film.classList.add('listed');
      mini.append(make('span', '', row.title));
    }
    mini.querySelector('.tags')?.remove();
    mini.append(tags);
    // The dot the Docs outline puts on a heading whose section holds a change.
    const place = make('i', row.tags.some(({ short }) => short === 'Changed') ? 'touched' : '', row.slide ? String(++number) : '–');
    film.append(place, mini);
    film.addEventListener('click', () => {
      card.node.scrollIntoView({ block: 'start', behavior: motion() });
      flash(card.node);
      leaveOutline();
    });
    return film;
  });
  outlineList.replaceChildren(...films);
  current = undefined;
  setOutline('Slides', rows.length > 1);
  markSlide();
}

/** Marks the slide the view is on, and keeps it in the filmstrip. */
function markSlide() {
  if (outline.hidden) return;
  let on = 0;
  rows.forEach(({ id }, n) => {
    if (cards.get(id).node.getBoundingClientRect().top <= innerHeight / 3) on = n;
  });
  films.forEach((film, n) => film.setAttribute('aria-current', String(n === on)));
  if (on === 0) outline.scrollTop = 0;
  else if (on !== current) films[on]?.scrollIntoView({ block: 'nearest' });
  current = on;
}

addEventListener('scroll', () => requestAnimationFrame(markSlide), { passive: true });
outline.addEventListener('outlinechange', markSlide);

// ---------------------------------------------------------------------------------------------
// Loading and refreshing

let loaded = false;
let generation = 0;
// What the last drawing showed as changed, so the next one can tell what is new.
let shown = new Set();
// The theme the last drawing was made over, which every slide and every shared picture hangs on.
let themeDrawn;

// Puts a card on the page for each slide, in order: drawn, or past the limit only named.
function layOut(drawn) {
  let number = 0;
  for (const id of cards.keys()) {
    if (rows.some(row => row.id === id)) continue;
    cards.delete(id);
    forgetPictures(id);
    drawings.delete(id);
  }
  const nodes = rows.map(row => {
    const card = cards.get(row.id) ?? makeCard(row.id);
    cards.set(row.id, card);
    card.listed = !drawn.has(row.id) || tooLarge(row);
    card.node.classList.toggle('listed', card.listed);
    card.frame.hidden = card.listed;
    const notes = card.node.querySelector('.notes');
    if (card.listed) notes?.remove();
    if (card.listed) card.changes.hidden = true;
    // Room for the notes the listing says the slide has, so the slides under it stay put.
    else if (!notes && (row.slide ?? row.was).hasSpeakerNotes) card.node.appendChild(make('div', 'notes same')).append(make('div', 'ghost'));
    showHeader(card, row, row.slide ? String(++number) : '–');
    if (tooLarge(row)) card.header.children[2].append(make('span', 'tag large', 'Too large to draw'));
    if (card.listed) card.views?.remove();
    else showViews(card);
    return card.node;
  });
  const limit = rows.length > drawn.size && make('p', 'limit',
    `${drawn.size} of ${rows.length} slides are drawn, starting with the ones that change. The others are listed by title.`);
  page.style.setProperty('--ratio', `${size.width} / ${size.height}`);
  outlineList.style.setProperty('--ratio', `${size.width} / ${size.height}`);
  const empty = rows.length === 0 && make('p', 'empty', 'This presentation has no slides.');
  page.replaceChildren(...[limit, empty].filter(Boolean), ...nodes);
}

// What a read returned, each slide with what its master and layout put behind it, which comes
// once for all the slides it is behind, back among its elements.
function wholeSlides({ slides, shared }) {
  const whole = slide => slide && (({ behind = [], ...own }) =>
    ({ ...own, elements: [...behind.flatMap(place => shared[place] ?? []), ...own.elements] }))(slide);
  return slides.map(({ slideId, drawing, saved }) =>
    ({ slideId, drawing: whole(drawing), ...(saved === undefined ? {} : { saved: whole(saved) }) }));
}

// Reads `ids` again, whose shapes' outlines were still being fetched, until they have come or it
// has asked as often as it will, when they are drawn as shapes with no outline. Only the slide is
// drawn again: its marks, the view it is on and the navigator's places are as they were. A load
// since `now` ends it.
async function awaitOutlines(now, ids) {
  for (const wait of OUTLINE_WAITS_MS) {
    if (ids.length === 0) return;
    await pause(wait);
    if (now !== generation) return;
    // A read that fails leaves them waiting for the next.
    const answer = await gadget.readSlideDrawings(ids).catch(() => undefined);
    if (now !== generation) return;
    if (!answer) continue;
    ids = answer.slides.filter(slide => slide.outlinesPending).map(slide => slide.slideId);
    for (const slide of wholeSlides(answer)) {
      const card = cards.get(slide.slideId);
      if (!card || card.listed || ids.includes(slide.slideId)) continue;
      drawings.set(slide.slideId, { ...slide, seen: drawings.get(slide.slideId)?.seen });
      card.pending = false;
      // What changes on it is what it was: were it not, the slide is taken as one read afresh.
      if ((slide.saved !== undefined) !== card.differs) fill(card, slide);
      else {
        take(card, slide);
        paint(card);
      }
    }
    showPictures();
  }
  for (const id of ids) {
    const card = cards.get(id);
    if (!card) continue;
    card.pending = false;
    if (!card.listed) paint(card);
  }
  showPictures();
}

// Reads the drawings of `stale`, rows of the listing, a few at a time, and fills their cards.
// Returns the slides whose shapes' outlines are still on their way, or nothing when a load since
// `now` has taken over.
async function readDrawings(now, stale, drawn) {
  const waiting = [];
  const batches = [];
  for (let at = 0; at < stale.length; at += BATCH) batches.push(stale.slice(at, at + BATCH));
  for (let batch = batches.shift(); batch; batch = batches.shift()) {
    let answer;
    try {
      answer = await gadget.readSlideDrawings(batch.map(row => row.id));
    } catch (error) {
      if (now !== generation) return;
      // More than one read returns: the slides are read again in halves, down to the one that
      // is too large by itself, which is then only named.
      if (!TOO_LARGE.test(error?.message)) throw error;
      if (batch.length > 1) batches.unshift(batch.slice(0, batch.length >> 1), batch.slice(batch.length >> 1));
      else {
        drawings.set(batch[0].id, { large: true, seen: batch[0].seen });
        layOut(drawn);
        renderFilmstrip();
      }
      continue;
    }
    if (now !== generation) return;
    const read = wholeSlides(answer);
    waiting.push(...answer.slides.filter(slide => slide.outlinesPending).map(slide => slide.slideId));
    const fonts = readFonts(read.flatMap(({ drawing, saved }) => [drawing, saved])).catch(() => false)
      .then(any => {
        if (!any) return;
        for (const card of cards.values()) if (card.stages.length) paint(card);
        showPictures();
      });
    await Promise.race([fonts, pause(FONT_WAIT_MS)]);
    if (now !== generation) return;
    for (const [n, slide] of read.entries()) {
      const before = drawings.get(slide.slideId);
      if (JSON.stringify([before?.drawing, before?.saved]) !== JSON.stringify([slide.drawing, slide.saved])) forgetPictures(slide.slideId);
      drawings.set(slide.slideId, { ...slide, seen: batch[n].seen });
      cards.get(slide.slideId).pending = waiting.includes(slide.slideId);
      fill(cards.get(slide.slideId), slide);
    }
    showPictures();
  }
  return waiting;
}

// Gives the navigator its places: each changed element, and each slide changed as a whole. A
// change the last drawing did not show is what to look at; on opening, so is the first there is.
function showStops() {
  const marked = new Set();
  let firstFresh;
  const stops = rows.flatMap(row => {
    const card = cards.get(row.id);
    const places = card.listed ? [] : card.stops;
    const key = `${row.id}\u0000${row.tags.map(({ text }) => text)}\u0000${card.spots.map(({ id, name }) => id + name)}`;
    if (row.touched) marked.add(key);
    if (loaded && row.touched && !shown.has(key)) {
      for (const [node] of places.length ? places : [[card.node]]) node.classList.add('fresh');
      firstFresh ??= places[0]?.[0] ?? card.node;
    }
    return places.length ? places : row.touched ? [[card.node]] : [];
  });
  shown = marked;
  setStops(stops);
  (firstFresh ?? (loaded ? undefined : stops[0]?.[0]))?.scrollIntoView({ block: 'center', behavior: motion() });
}

async function load() {
  const now = ++generation;
  listing = undefined;
  if (loaded) status('Updating…');
  else showLoading();
  try {
    // One read: the changes, and the deck's slides as saved and as the changes leave them.
    const pending = await gadget.getPendingChanges();
    if (now !== generation) return;
    const { savedPresentation, presentation } = pending;
    size = presentation.pageSize ?? size;
    // A theme color changed is every slide changed.
    const theme = JSON.stringify([savedPresentation.masters, presentation.masters]);
    if (theme !== themeDrawn) pictures.clear();
    themeDrawn = theme;
    rows = listSlides(pending);
    for (const row of rows) row.seen += theme;
    const drawn = pick(rows);
    const scrollTop = document.scrollingElement.scrollTop;
    layOut(drawn);
    showStale(pending.changes.filter(change => change.stale).length, 'presentation');
    showPage();
    renderFilmstrip();
    document.scrollingElement.scrollTop = scrollTop;

    // Read again, the touched first: what is touched now, what is drawn with changes on it, which
    // may be gone, and what the listing says has changed.
    const stale = rows.filter(row => drawn.has(row.id) && !tooLarge(row) &&
      (row.touched || cards.get(row.id).differs || cards.get(row.id).pending || drawings.get(row.id)?.seen !== row.seen));
    const waiting = await readDrawings(now, stale.toSorted((a, b) => b.touched - a.touched), drawn);
    if (!waiting) return;
    // A picture that could not be read is asked for again, on a slide drawn again or not.
    for (const [id, picture] of pictures) if (picture.read && !picture.url) pictures.delete(id);
    showPictures();
    showStops();
    status('');
    loaded = true;
    void awaitOutlines(now, waiting);
  } catch (error) {
    if (now !== generation) return;
    status('');
    showError(error, 'presentation', load);
  }
}

export default {
  main(session) {
    gadget = session;
    loadOnRefresh(load);
  },
};
