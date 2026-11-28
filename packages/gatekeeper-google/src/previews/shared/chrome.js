// What every preview of this gatekeeper shares: its colors, and the parts around the resource it
// draws. Those are the page the resource is drawn on, the status, the note on changes that no
// longer fit, the change navigator and the part navigator, the outline sheet and the dot it puts
// on what holds a change, and the loading and error states. A preview imports this as
// ./ui/chrome.js and draws its resource into `page`.
//
// Importing it builds those parts into the frame's document, which holds one preview.

const styleSheet = document.createElement('style');
styleSheet.textContent = `
  :root { color-scheme: light dark; --page: #fff; --desk: #f1f3f4; --ink: #1f1f1f; --dim: #5f6368;
    --line: #dadce0; --mark: #e6f4ea; --mark-ink: #137333; --gone: #fce8e6; --gone-ink: #a50e0e;
    --edit: #f3e8fd; --edit-ink: #8430ce; --link: #1a73e8; --chip: #f1f3f4; --shine: #e8eaed; --width: 816px;
    --paper: 0 1px 2px rgb(60 64 67 / .2), 0 4px 14px rgb(60 64 67 / .1);
    --float: 0 1px 3px rgb(60 64 67 / .24), 0 6px 20px rgb(60 64 67 / .14); }
  @media (prefers-color-scheme: dark) {
    :root { --page: #1f1f1f; --desk: #131314; --ink: #e3e3e3; --dim: #9aa0a6; --line: #3c4043;
      --mark: #1e3a2a; --mark-ink: #81c995; --gone: #3b1f1d; --gone-ink: #f28b82;
      --edit: #2f2440; --edit-ink: #c58af9; --link: #8ab4f8; --chip: #2d2f31; --shine: #3c4043;
      --paper: 0 0 0 1px var(--line);
      --float: 0 0 0 1px var(--line), 0 8px 24px rgb(0 0 0 / .5); }
  }
  html, body { margin: 0; height: 100%; background: var(--desk); color: var(--ink);
    font: 11pt/1.5 Arial, Helvetica, sans-serif; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
  :is(.nav button, #outline-toggle, .fold):active { transform: scale(.9); }
  [hidden] { display: none !important; }

  /* What has just arrived, what is being pointed out, and what is still being read. */
  .fresh { animation: arrive .35s ease-out, glow 1.4s ease-out; }
  .flash { animation: glow 1.4s ease-out; }
  @keyframes arrive { from { opacity: 0; transform: translateY(4px); } }
  /* A ring round it, in the color of what it does where it says one: what it rings keeps its own colors. */
  @keyframes glow {
    from, 35% { outline: 2px solid var(--glow, var(--link)); outline-offset: 3px; }
    to { outline: 2px solid transparent; outline-offset: 3px; }
  }
  /* The frame round what the reader picked with a click, which each preview draws, fades in as one. */
  @keyframes choose { from { opacity: 0; } }
  .ghost, .wait { background: linear-gradient(90deg, var(--chip) 25%, var(--shine) 50%, var(--chip) 75%) 0 0 / 200% 100%;
    animation: shimmer 1.4s linear infinite; }
  .ghost { height: 12px; margin: 14px 0 !important; min-height: 0 !important; border-radius: 6px; }
  @keyframes shimmer { to { background-position: -200% 0; } }

  /* In a pane too narrow for them in one row, they take another. */
  #bar { position: fixed; z-index: 1; top: 10px; right: 14px; max-width: calc(100% - 28px); display: flex;
    flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; font-size: 12px; color: var(--dim); }
  /* Held back a moment, so a refresh that is quick does not blink. */
  #bar > span:not(:empty) { display: flex; align-items: center; gap: 7px; padding: 5px 12px 5px 10px;
    border-radius: 999px; background: var(--page); box-shadow: var(--float);
    animation: arrive .2s ease-out .15s backwards; }
  #bar > span:not(:empty)::before { content: ''; box-sizing: border-box; width: 12px; height: 12px;
    border: 1.5px solid var(--line); border-top-color: var(--link); border-radius: 50%;
    animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(1turn); } }
  /* Beside the navigator, which steps through the changes that are shown: these are the ones that are not. */
  #stale { display: flex; align-items: center; gap: 6px; padding: 5px 12px 5px 9px; border-radius: 999px;
    background: var(--gone); color: var(--gone-ink); box-shadow: var(--float); white-space: nowrap;
    cursor: help; animation: arrive .2s ease-out; }
  .nav { display: flex; align-items: center; gap: 2px; padding: 2px 3px 2px 12px;
    border-radius: 999px; background: var(--page); box-shadow: var(--float); color: var(--ink);
    font-size: 12px; white-space: nowrap; animation: arrive .2s ease-out; }
  .nav span { margin-right: 4px; color: var(--dim); }
  /* The word that says something holds a change, or is one: green where it adds, red where it
     removes, and purple where it edits or does both. */
  [data-touched]::after, .said { content: attr(data-says); flex: none; margin-left: 6px; padding: 0 6px;
    border-radius: 999px; background: var(--mark); color: var(--mark-ink); font-size: 10px;
    font-weight: 400; line-height: 16px; white-space: nowrap; }
  [data-touched="removed"]::after { background: var(--gone); color: var(--gone-ink); }
  [data-touched="changed"]::after, .said { background: var(--edit); color: var(--edit-ink); }
  /* Which copy is shown: one control of equal parts, and a thumb that slides to the one pressed. */
  .views { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; flex: none;
    padding: 2px; border-radius: 999px; background: var(--chip); }
  .views > i { position: absolute; top: 2px; bottom: 2px; left: 2px; width: calc((100% - 4px) / var(--parts));
    border-radius: 999px; background: var(--page); box-shadow: 0 1px 2px rgb(0 0 0 / .22);
    transform: translateX(calc(var(--on, 0) * 100%)); transition: transform .2s ease-out; }
  .views button { position: relative; padding: 2px 10px; border: 0; border-radius: 999px; background: none;
    color: var(--dim); font-size: 11px; line-height: 1.6; white-space: nowrap; transition: color .15s; }
  .views button:hover, .views button[aria-pressed="true"] { color: var(--ink); }
  /* Among the buttons that float over the desk it is a sheet as they are, and its thumb a tint on it. */
  #bar .views { background: var(--page); box-shadow: var(--float); animation: arrive .2s ease-out; }
  #bar .views > i { background: color-mix(in srgb, var(--link) 16%, transparent); box-shadow: none; }
  #bar .views button { padding: 3px 11px; font-size: 12px; line-height: 1.5; }
  .nav button { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0;
    border-radius: 50%; background: none; color: var(--dim); transition: background .12s, color .12s, opacity .12s; }
  .nav button:hover { background: var(--chip); color: var(--ink); }
  .nav button:disabled { opacity: .35; pointer-events: none; }
  /* In a narrow frame the Workshop's card for a change waiting lies across the foot, and what
     stands there stands above it. */
  @media (max-width: 900px) { .waiting { --foot: 120px; } }
  /* The part navigator, at the foot of the frame as the change navigator is at its head. */
  #pager { position: fixed; z-index: 1; right: 14px; bottom: calc(14px + var(--foot, 0px)); }
  #pager .count { color: var(--ink); font-variant-numeric: tabular-nums; }
  /* A read that failed with the page drawn, said at its foot without taking it away: beside the
     part navigator, and above it where the frame has not the room for both. */
  #missed { position: fixed; z-index: 9; inset: auto 16px calc(14px + var(--foot, 0px)); width: fit-content;
    margin: 0 auto; display: flex; align-items: center; gap: 7px; padding: 2px 3px 2px 10px; border-radius: 14px;
    background: var(--page); box-shadow: var(--float); color: var(--ink); font-size: 12px; line-height: 16px;
    animation: arrive .2s ease-out; }
  #missed[hidden] { display: none; }
  #missed svg { flex: none; color: var(--gone-ink); }
  #missed button { flex: none; margin-left: 3px; padding: 4px 10px; border: 0; border-radius: 999px; background: none;
    color: var(--link); font: inherit; font-weight: 500; transition: background .12s; }
  #missed button:hover { background: color-mix(in srgb, var(--link) 12%, transparent); }
  @media (max-width: 660px) { body:has(#pager:not([hidden])) #missed { bottom: calc(56px + var(--foot, 0px)); } }

  /* The outline stands beside the page where there is room, and over it where there is not. Its
     button keeps its place: closed it floats as the other buttons do, and open it is the corner
     of the sheet, which unfolds from it and folds back into it. */
  :root { --outline: 240px; --top: 16px; --swift: .2s cubic-bezier(.2, 0, 0, 1);
    --folded: inset(6px calc(100% - 38px) calc(100% - 34px) 10px round 14px); }
  #outline-toggle { position: fixed; z-index: 3; top: 6px; left: 10px; display: grid;
    place-items: center; width: 28px; height: 28px; border: 0; border-radius: 50%; background: var(--page);
    box-shadow: var(--float); color: var(--dim);
    transition: background var(--swift), box-shadow var(--swift), color .15s; }
  #outline-toggle:hover { color: var(--ink); }
  #outline-toggle[aria-expanded="true"] { background: none; box-shadow: none; }
  #outline-toggle[aria-expanded="true"]:hover { background: var(--chip); }
  #outline { position: fixed; z-index: 2; inset: 0 auto 0 0; display: flex; flex-direction: column;
    width: 240px; font-size: 12px; --round: 0 12px 12px 0;
    --cast: var(--float), 8px 0 32px rgb(0 0 0 / .18); }
  /* Hidden, it is still laid out, so that it folds away before it goes. */
  #outline[hidden] { display: flex !important; visibility: hidden; transition: visibility 0s .2s; }
  /* The shadow is a layer of its own, which what clips the sheet as it folds does not clip. */
  #outline::before { content: ''; position: absolute; z-index: -1; inset: 0; border-radius: var(--round);
    box-shadow: var(--cast); transition: opacity var(--swift); }
  #outline[hidden]::before { opacity: 0; }
  #outline > div { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden;
    border-radius: var(--round); background: var(--page); animation: unfold var(--swift); }
  #outline[hidden] > div { animation: fold var(--swift) forwards; }
  @keyframes unfold { from { clip-path: var(--folded); } to { clip-path: inset(0 round var(--round)); } }
  @keyframes fold { from { clip-path: inset(0 round var(--round)); } to { clip-path: var(--folded); } }
  #outline h2 { flex: none; margin: 0; padding: 0 0 0 48px; border-bottom: 1px solid transparent;
    font-size: 11px; font-weight: 700; line-height: 39px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--dim); transition: border-color .15s; }
  #outline.scrolled h2 { border-color: var(--line); }
  /* What is listed scrolls under its title, and its scrollbar stops short of the sheet's round corners. */
  #outline h2 + div { flex: 1 1 auto; min-height: 0; margin: 0 2px 8px 0; padding: 5px 8px 4px 14px;
    overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
  /* The parts a resource is divided into, such as a document's tabs: the one shown is marked. */
  #outline .tab { display: flex; align-items: center; margin: 2px 0; padding: 0 6px 0 4px;
    border-radius: 999px; color: var(--dim); transition: background .12s, color .12s;
    scroll-margin: 8px 0; }
  #outline .tab:hover { background: var(--chip); color: var(--ink); }
  #outline .tab.on { background: color-mix(in srgb, var(--link) 14%, transparent); color: var(--ink); }
  .tab .name { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; padding: 7px 4px;
    border: 0; border-radius: 999px; background: none; color: inherit; text-align: left; }
  .name:focus-visible { outline-offset: -2px; }
  .tab.on .name { font-weight: 700; }
  .tab.on .name > svg { color: var(--link); }
  .name > svg { flex: none; }
  .name > span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* The arrow that folds away what is under a name. Only it folds: the name beside it still goes
     where it names. */
  .fold, .gap { flex: none; width: 20px; height: 20px; }
  .fold { display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%;
    background: none; color: var(--dim); opacity: .6; transition: background .12s, opacity .12s; }
  .fold:hover { background: var(--shine); color: var(--ink); opacity: 1; }
  .fold > svg { transition: transform .15s ease-out; }
  .fold[aria-expanded="false"] > svg { transform: rotate(-90deg); }
  body { transition: padding-left var(--swift); }
  /* Where there is room the outline is a sheet of its own at the frame's edge: level with the
     page, and no longer than what it lists. */
  @media (min-width: 1400px) { :root { --outline: 296px; } }
  @media (min-width: 1000px) {
    /* The page keeps to the middle of the frame, and gives way only as far as the outline needs:
       as the outline unfolds, so the two are never over one another. */
    .outlined { padding-left: clamp(0px, 2 * (var(--outline) + 28px) - (100% - var(--width)), var(--outline) + 20px); }
    #outline { inset: var(--top) auto auto 8px; width: var(--outline);
      max-height: calc(100% - var(--top) - 16px); --round: 8px; --cast: var(--paper); }
    #outline-toggle { top: calc(var(--top) + 6px); left: 18px; }
  }

  #error { display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: 420px;
    margin: 96px auto; padding: 0 24px; text-align: center; font-size: 13px; color: var(--dim);
    overflow-wrap: anywhere; animation: arrive .25s ease-out; }
  #error > svg { margin-bottom: 6px; color: var(--gone-ink); }
  #error strong { font-size: 15px; color: var(--ink); }
  #error p { margin: 0; }
  #error p:empty { display: none; }
  #error button { margin-top: 14px; padding: 6px 16px; border: 1px solid var(--line);
    border-radius: 999px; background: var(--page); color: var(--ink); transition: background .12s; }
  #error button:hover { background: var(--chip); }
  @media (prefers-reduced-motion: reduce) {
    *, ::before, ::after { animation: none !important; transition: none !important; }
  }
`;
document.head.append(styleSheet);

export const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

/** A line icon drawn from one path. */
export function lineIcon(path, size = 18) {
  const SVG = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(SVG, 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 20 20', width: size, height: size,
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round',
    'stroke-linejoin': 'round' })) {
    icon.setAttribute(name, value);
  }
  icon.appendChild(document.createElementNS(SVG, 'path')).setAttribute('d', path);
  return icon;
}

/**
 * A data: URL of the bytes `content` streams, which is the only address the frame may draw a
 * picture from.
 */
export const dataUrl = async (content, type) => {
  const bytes = await new Response(content).arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(new Blob([bytes], { type }));
  });
};

/**
 * Families Google Fonts does not serve, which every browser has or has a match for. It does serve
 * the others an editor offers that are not its own, Cambria and Times New Roman among them, in
 * the files the editor draws with.
 */
export const SYSTEM_FONT = /^(arial|sans)$/i;

// How long a font that could not be read is left alone: the failure may be a busy server's. And
// how long a read may take, past which it has failed: one that never settles would keep its place.
const FONT_RETRY_MS = 60_000;
const FONT_READ_MS = 30_000;

/**
 * Brings fonts into this frame through `read(family, weight, italic)`, a session's readFont(),
 * which streams each: at most `most` of them, each asked for once. One that could not be read,
 * or took too long, counts for nothing, and is asked for again by the first `read()` to name
 * it after a while.
 * `measures(bytes, family)` gives what a face sets over its file's own measures. `asked(...font)`
 * says whether a font was asked for, and `read(fonts)` reads those of `[family, weight, italic]`
 * that were not, and says whether any arrived.
 */
export function fontReader(read, most, measures = () => ({})) {
  // Each font asked for: whether it arrived. Only one that does, or may yet, counts against the limit.
  const faces = new Map();
  let held = 0;
  const key = font => font.join('\u0000');
  const face = (family, weight, italic) => {
    const font = key([family, weight, italic]);
    if (faces.has(font)) return faces.get(font);
    if (held >= most) return Promise.resolve(false);
    held++;
    // A read that takes too long is given up: its stream is cancelled, so no more of it arrives.
    const late = new AbortController();
    const timer = setTimeout(() => late.abort(), FONT_READ_MS);
    const lapsed = new Promise((_resolve, reject) => late.signal.addEventListener('abort', reject));
    const sent = Promise.resolve().then(() => read(family, weight, italic))
      .then(content => new Response(content.pipeThrough(new TransformStream(), { signal: late.signal })).arrayBuffer());
    const arrived = Promise.race([sent, lapsed]).finally(() => clearTimeout(timer)).then(async content => {
      const bytes = new Uint8Array(content);
      const loaded = new FontFace(family, bytes, { weight: String(weight), style: italic ? 'italic' : 'normal', ...measures(bytes, family) });
      await loaded.load();
      document.fonts.add(loaded);
      return true;
    }).catch(() => {
      held--;
      setTimeout(() => faces.delete(font), FONT_RETRY_MS);
      // Without the weight the browser makes one from the family's regular, when that is there.
      return (weight !== 400 || italic) && face(family, 400, false);
    });
    faces.set(font, arrived);
    return arrived;
  };
  return {
    asked: (...font) => faces.has(key(font)),
    read: async fonts => {
      const fresh = new Map(fonts.filter(font => font[0] && !SYSTEM_FONT.test(font[0]) && !faces.has(key(font))).map(font => [key(font), font]));
      return (await Promise.all([...fresh.values()].map(font => face(...font)))).some(Boolean);
    },
  };
}

export const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

/** Restarts an element's glow, which an animation already run would not play again. */
export function flash(element) {
  element.classList.remove('fresh', 'flash');
  void element.offsetWidth;
  element.classList.add('flash');
}

/** Where a preview draws its resource. */
export const page = document.body.appendChild(make('div'));
page.id = 'page';

// ---------------------------------------------------------------------------------------------
// The outline: a sheet beside the page for what the resource is divided into. A preview fills
// `outlineList` and says with setOutline() whether there is anything in it.

const outlineToggle = document.body.appendChild(make('button'));
outlineToggle.id = 'outline-toggle';
outlineToggle.append(lineIcon('M4 5h.5M8 5h8M4 10h.5M8 10h8M4 15h.5M8 15h8'));
outlineToggle.hidden = true;
export const outline = document.body.appendChild(make('nav'));
outline.id = 'outline';
outline.hidden = true;
// The sheet itself, which folds into the button and out of it over the outline's shadow.
const outlineSheet = outline.appendChild(make('div'));
const outlineTitle = outlineSheet.appendChild(make('h2'));
/** What the outline lists, which scrolls under its title. */
export const outlineList = outlineSheet.appendChild(make('div'));
// A line under the title while what is listed is scrolled under it.
outlineList.addEventListener('scroll', () => outline.classList.toggle('scrolled', outlineList.scrollTop > 0), { passive: true });

const wide = matchMedia('(min-width: 1000px)');
const roomForOutline = () => wide.matches;
// Whether the person opened or closed the outline; until they do it is open where there is room.
let outlineChosen;

// Tells the preview, with an `outlinechange` event, so it can mark where the reading is.
function showOutline(open) {
  // Out of reach at once: it stays drawn while it folds away.
  outline.hidden = outline.inert = !open;
  outlineToggle.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('outlined', open);
  outline.dispatchEvent(new Event('outlinechange'));
}
outlineToggle.addEventListener('click', () => showOutline(outlineChosen = outline.hidden));
// An outline nobody opened or closed follows the room there is as the frame is resized.
wide.addEventListener('change', () => outlineToggle.hidden || showOutline(outlineChosen ?? wide.matches));

/** Titles the outline, and shows it if it holds anything and the person has not closed it. */
export function setOutline(title, any) {
  outlineTitle.textContent = title;
  for (const part of [outlineToggle, outline]) part.setAttribute('aria-label', title);
  // Level with the page, which a note above it moves, and clear of the frame's own edge.
  document.documentElement.style.setProperty('--top', `${Math.max(page.offsetTop, 12)}px`);
  outlineToggle.hidden = !any;
  showOutline(any && (outlineChosen ?? roomForOutline()));
}

/** Closes an outline that lies over the page, once something in it was picked. */
export function leaveOutline() {
  if (roomForOutline()) return;
  // The keyboard goes back to what opens it, as nothing in a closed outline can keep it.
  const held = outline.contains(document.activeElement);
  showOutline(outlineChosen = false);
  if (held) outlineToggle.focus();
}

/**
 * The arrow that folds away what `key` names, or the gap one would fill when there is nothing to
 * fold. `folded` holds the keys folded away, and `redraw` draws the outline again.
 */
export function foldArrow(key, label, folded, redraw) {
  if (!key) return make('span', 'gap');
  const arrow = make('button', 'fold');
  arrow.append(lineIcon('M6 8l4 4.5L14 8', 14));
  arrow.setAttribute('aria-label', label);
  arrow.setAttribute('aria-expanded', String(!folded.has(key)));
  arrow.dataset.fold = key;
  arrow.addEventListener('click', () => {
    if (!folded.delete(key)) folded.add(key);
    redraw();
    // The redraw made this arrow anew: the one in its place keeps the keyboard where it was.
    [...outlineList.querySelectorAll('.fold')].find(found => found.dataset.fold === key)?.focus();
  });
  return arrow;
}

// What the word says in full of each kind of change, for the element's title.
const HOLDS = { added: 'has pending additions', removed: 'has pending deletions', changed: 'has pending edits' };
const WORDS = { added: 'Added', removed: 'Removed', changed: 'Edited' };
/** The words for what is itself added or removed, rather than holding what is. */
export const ITSELF = { added: 'New', removed: 'Deleted' };

/**
 * Puts the word on `element` for `kinds`, what each change it holds does: 'added', 'removed' or
 * 'changed'. It is the kind they share, or 'changed' when they differ, and none when there are
 * none. `words` are said in place of the usual ones. Returns what the word says in full, for the
 * element's title.
 */
export function touch(element, kinds, words) {
  const found = new Set(kinds);
  const kind = found.size > 1 ? 'changed' : [...found][0];
  if (kind) Object.assign(element.dataset, { touched: kind, says: { ...WORDS, ...words }[kind] });
  else for (const name of ['touched', 'says']) delete element.dataset[name];
  return HOLDS[kind];
}

/**
 * A control of several parts, one of them pressed: `options` are each `[name, label, hint]`, and
 * `pick(name)` is called with the one clicked. press() says which is pressed.
 */
export function segmented(label, options, pick) {
  const group = make('div', 'views');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  group.style.setProperty('--parts', options.length);
  group.append(make('i'));
  for (const [name, text, hint] of options) {
    const button = group.appendChild(make('button', '', text));
    button.dataset.view = name;
    if (hint) button.title = hint;
    button.addEventListener('click', () => pick(name));
  }
  return group;
}

/** Presses the part of a segmented() control that `name` names. */
export function press(group, name) {
  [...group.querySelectorAll('button')].forEach((button, at) => {
    const on = button.dataset.view === name;
    button.setAttribute('aria-pressed', String(on));
    if (on) group.style.setProperty('--on', at);
  });
}

// ---------------------------------------------------------------------------------------------
// The status and the change navigator, which steps through the places the changes touch, and the
// part navigator, which steps through the parts the resource is read in

// The controls that float over the page's corner.
const bar = document.body.appendChild(make('div'));
bar.id = 'bar';
const statusLine = bar.appendChild(make('span'));
statusLine.setAttribute('role', 'status');
const staleNote = bar.appendChild(make('div'));
staleNote.id = 'stale';
staleNote.hidden = true;
staleNote.setAttribute('role', 'status');
staleNote.append(lineIcon('M10 7v4M10 14h.01M8.7 3.3L2.4 14a1.5 1.5 0 001.3 2.2h12.6a1.5 1.5 0 001.3-2.2L11.3 3.3a1.5 1.5 0 00-2.6 0z', 14));
const staleLabel = staleNote.appendChild(make('span'));

/**
 * A navigator: `label` and an arrow each way, which call `step(-1)` and `step(1)` and are named
 * by `names`. What it steps through is for the group's own label to say, with how many there are.
 */
export function stepper(label, names, step) {
  const group = make('div', 'nav');
  group.setAttribute('role', 'group');
  group.appendChild(make('span', '', label)).ariaHidden = 'true';
  for (const [next, path] of ['M6 12l4-4.5 4 4.5', 'M6 8l4 4.5L14 8'].entries()) {
    const button = group.appendChild(make('button'));
    button.append(lineIcon(path, 16));
    button.setAttribute('aria-label', names[next]);
    button.addEventListener('click', () => step(next ? 1 : -1));
  }
  return group;
}

const nav = bar.appendChild(stepper('Changes', ['Previous change', 'Next change'], step => showChange(step)));
nav.id = 'nav';
nav.hidden = true;
/** Puts a control of a preview's own among those that float over the page, before the navigator. */
export const addControl = control => bar.insertBefore(control, nav);
// Each place a change touches, as the elements drawn there, and the one the navigator is on.
let stops = [];
let stop = -1;

function showChange(step) {
  for (const element of stops[stop] ?? []) element.classList.remove('here');
  // From before the first, a step back is to the last.
  stop = stop < 0 && step < 0 ? stops.length - 1 : (stop + step + stops.length) % stops.length;
  stops[stop][0].scrollIntoView({ block: 'center', behavior: motion() });
  for (const element of stops[stop]) {
    element.classList.add('here');
    flash(element);
  }
}

// The part navigator, where a preview has one.
let pager;

/**
 * The navigator at the foot of the frame for the parts a resource is read in, each called `noun`,
 * such as 'page'. Its `show(parts, at)` gives it the parts' elements and the one being read, with
 * the number that one goes by and how many are numbered, which are its place and the parts' count
 * unless said otherwise, and what to call it then. Fewer than two parts need no navigator.
 */
export function partNavigator(noun) {
  const Noun = noun[0].toUpperCase() + noun.slice(1);
  let parts = [];
  // The part being read, and the one being stepped to until it is reached.
  let on = 0;
  let aimed;
  // Whether a part is above where a step puts it. At the foot the one before the last may not be:
  // the view goes no further, so a step back from there is to the last part that is.
  const above = part => part.getBoundingClientRect().top < parseFloat(getComputedStyle(part).scrollMarginTop) - 1;
  pager = document.body.appendChild(stepper(Noun, [`Previous ${noun}`, `Next ${noun}`], step => {
    const to = aimed !== undefined || step > 0 ? (aimed ?? on) + step
      : parts.findLastIndex((part, at) => at < on && above(part));
    if (!parts[to]) return;
    aimed = to;
    parts[aimed].scrollIntoView({ block: 'start', behavior: motion() });
  }));
  pager.id = 'pager';
  pager.hidden = true;
  // What the group's label says in words.
  const count = pager.insertBefore(make('span', 'count'), pager.querySelector('button'));
  count.ariaHidden = 'true';
  addEventListener('scrollend', () => { aimed = undefined; });
  return {
    show(found, at, number = at + 1, total = found.length, label = `${Noun} ${number} of ${total}`) {
      parts = found;
      pager.hidden = parts.length < 2 || page.hidden;
      if (pager.hidden) return;
      on = at;
      if (on === aimed) aimed = undefined;
      const { scrollTop, clientHeight, scrollHeight } = document.scrollingElement;
      const [previous, next] = pager.querySelectorAll('button');
      previous.disabled = on === 0;
      next.disabled = on === parts.length - 1 || scrollTop + clientHeight >= scrollHeight - 1;
      count.textContent = `${number} / ${total}`;
      pager.setAttribute('aria-label', label);
    },
  };
}

/** Stands what is at the foot of the frame above the Workshop's card for a change `waiting`. */
export const lift = waiting => document.body.classList.toggle('waiting', waiting);

/**
 * Says how many changes the resource no longer fits: they are in neither copy, so not drawn. Said
 * with its reason beside the navigator, and in full to whoever points at it or hears it read.
 */
export function showStale(count, resource) {
  staleNote.hidden = count === 0;
  staleLabel.textContent = count === 1 ? '1 change no longer applies' : `${count} changes no longer apply`;
  staleNote.title = count === 1
    ? `1 change no longer fits this ${resource} and is not shown.`
    : `${count} changes no longer fit this ${resource} and are not shown.`;
  staleNote.setAttribute('aria-label', staleNote.title);
}

/** What the status says is going on, or nothing. */
export const status = text => { statusLine.textContent = text; };

/** Gives the navigator the places to step through: for each, the elements drawn there. */
export function setStops(places) {
  stops = places;
  stop = -1;
  nav.hidden = stops.length === 0;
  // Places, not requests: changes side by side are one place, and the Workshop counts the requests.
  nav.setAttribute('aria-label', stops.length === 1 ? '1 changed place' : `${stops.length} changed places`);
}

// ---------------------------------------------------------------------------------------------
// Loading, failing and refreshing

/** The outline of text still to come: lines of a paragraph, a gap, and another. */
export const ghostLines = () => [38, 92, 100, 96, 71, 0, 100, 88, 94, 52].map(width => {
  const line = make('div', width ? 'ghost' : '');
  line.style.width = `${width}%`;
  return line;
});

/** Fills the page with the outline of text still to come. */
export function showLoading() {
  page.hidden = false;
  page.setAttribute('aria-busy', 'true');
  page.replaceChildren(...ghostLines());
}

// The sign that something went wrong.
const ALERT = 'M10 6.5v4M10 13.5h.01M10 2.5a7.5 7.5 0 100 15 7.5 7.5 0 000-15z';
const missed = document.body.appendChild(Object.assign(make('div'), { id: 'missed', hidden: true, role: 'status' }));
missed.append(lineIcon(ALERT, 16));
const missedText = missed.appendChild(make('span'));
let missedAgain;
missed.appendChild(make('button', '', 'Try again')).addEventListener('click', () => {
  missed.hidden = true;
  missedAgain();
});

/**
 * Says in `text`, at the foot of a page that stays as it is drawn, that a read of it failed, and
 * offers to `retry`. With no text, takes away what was said.
 */
export function miss(text = '', retry) {
  missedText.textContent = text;
  missedAgain = retry;
  missed.hidden = !text;
}

/** Shows the page as drawn, after showLoading() or showError(). */
export function showPage() {
  page.hidden = false;
  page.removeAttribute('aria-busy');
  document.getElementById('error')?.remove();
  miss();
}

/** Says the `resource` could not be loaded, in place of the page, and offers to `retry`. */
export function showError(error, resource, retry) {
  page.hidden = true;
  nav.hidden = true;
  if (pager) pager.hidden = true;
  document.getElementById('error')?.remove();
  const box = document.body.appendChild(make('div'));
  box.id = 'error';
  box.setAttribute('role', 'alert');
  box.append(lineIcon(ALERT, 28), make('strong', '', `This ${resource} could not be loaded`), make('p', '', error?.message));
  box.appendChild(make('button', '', 'Try again')).addEventListener('click', () => {
    box.remove();
    retry();
  });
}

/**
 * Calls `load` whenever the Workshop says an action on this connection was queued, applied or
 * discarded. A gadget cannot see the action log, so nothing inside the frame could tell.
 */
export function loadOnRefresh(load) {
  addEventListener('message', event => {
    if (event.source === parent && event.data?.type === 'refresh') void load();
  });
}

// ---------------------------------------------------------------------------------------------
// Where the reader is

// The longest anchor, label and context a host takes (MAX_FOCUS_ANCHOR_LENGTH and the like).
const LONGEST_ANCHOR = 256;
const LONGEST_LABEL = 120;
const LONGEST_CONTEXT = 2000;
// What a context starts with where it takes in what a pending change wrote, which the file does
// not hold yet: the agent is told what the reader saw, not that it is saved.
const UNSAVED_NOTE = '(shown with changes not yet approved)\n';
// How long a selection is left to settle: one being dragged out changes at every move.
const SELECTION_SETTLE_MS = 200;

// `text` in no more than `most` characters, one cut short saying so, and at no half of a character.
const cut = (text, most) => text.length > most ? `${text.slice(0, most - 1).replace(/[\ud800-\udbff]$/, '')}…` : text;

/** `label` cut to what a host takes. */
export const fitLabel = label => cut(label, LONGEST_LABEL);

// What is not seen and can change how the text beside it reads: control characters but a tab and
// a line's end, and the marks that turn the direction text runs in.
const UNSEEN = /(?![\t\n])[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** `text` as a host is told it: with nothing in it that is not seen. */
export const seen = text => text.replace(UNSEEN, '');

/** The start of `text`, as short as a label has room for. */
export function quote(text) {
  const line = seen(text).replace(/\s+/g, ' ').trim();
  return `“${cut(line, 40)}”`;
}

/** Whether `node` is in, or holds, what `unsaved` matches: what a preview draws of a pending change's own. */
export const takesIn = (node, unsaved) => !!(node.closest(unsaved) ?? node.querySelector(unsaved));

/**
 * Tells the frame's `host` where the reader is and what is there (GadgetHost.reportFocus()), so
 * that the preview can be sent back there and the agent told what "this" is. `spot(range)` gives
 * the place as `{ anchor, label, context, pending }`: with no label where it is nowhere more
 * particular than the resource, which is said only with text selected, nothing where there is
 * no place yet, and false where what was last said still stands. It is given the range of the
 * text selected that is told, if any, which may lie where the view is not.
 * The text selected is told in place of the spot's own `context`, where all of it is in what
 * `content`, a selector, matches: the document as drawn. What a preview writes around that (a
 * title, an outline, a cell's value in a bar) it writes unmarked, so text selected there is none
 * to tell. What is told is told as not yet approved where either takes in what a pending change
 * wrote: `pending` says so of the context, and of text selected in what `picked`, a selector,
 * matches, which is the thing picked; `unsaved`, a selector, matches what the preview draws of
 * one, which is how a spot tells its own `pending` too (takesIn()). A label is the preview's to
 * keep free of such text. Returns what to call when the place may have moved: the host hears
 * only of what has changed.
 */
export function reportSpot(host, spot, unsaved, content, picked = '.chosen') {
  // A frame that has said nothing is nowhere in particular, which is what null says.
  let said = 'null';
  // The text selected, read as the selection settles and not as the place moves: it can be all
  // there is on the page.
  const NONE = { text: '', noted: false };
  let selected = NONE;
  const say = () => {
    // Behind an error nothing is drawn to be anywhere in: what was last said stands.
    if (page.hidden) return;
    // What a selection held is gone with it, as when the page is drawn again under it.
    if (document.getSelection().isCollapsed) selected = NONE;
    const place = spot(selected.range);
    if (place === false) return;
    const { anchor, label = selected.text && 'Selected text', context = '', pending } = place ?? {};
    // Without the word joiners a document's paragraphs end in.
    const text = seen(selected.text || context).replaceAll('\u2060', '');
    // Text selected in what is picked is no more saved than the pick is, and text selected
    // anywhere else is as saved as it is itself.
    const noted = selected.noted || pending && (!selected.text || liesIn(selected.range, picked));
    const there = cut(text && `${noted ? UNSAVED_NOTE : ''}${text}`, LONGEST_CONTEXT);
    const focus = anchor === undefined || !label || anchor.length > LONGEST_ANCHOR
      ? null : { anchor, label: fitLabel(seen(label)), ...there && { context: there } };
    const saying = JSON.stringify(focus);
    if (saying === said) return;
    said = saying;
    // Over RPC the call answers with a stub of nothing, which is held until it is let go.
    host.reportFocus(focus)?.[Symbol.dispose]?.();
  };
  let settling;
  document.addEventListener('selectionchange', () => {
    clearTimeout(settling);
    settling = setTimeout(() => {
      const selection = document.getSelection();
      const range = selection.rangeCount ? selection.getRangeAt(0) : undefined;
      const text = range && liesIn(range, content) ? selection.toString().trim() : '';
      selected = !text ? NONE
        : { text, range, noted: [...document.querySelectorAll(unsaved)].some(node => selection.containsNode(node, true)) };
      say();
    }, SELECTION_SETTLE_MS);
  });
  return say;
}

// Whether `range` lies in something `within` matches: it starts there and takes no text from
// past it, though it may end past it, as a triple click ends at the start of the next block.
function liesIn(range, within) {
  const { startContainer: start } = range;
  const root = (start.closest ? start : start.parentElement)?.closest(within);
  if (!root) return false;
  const rest = range.cloneRange();
  rest.setStartAfter(root);
  return !rest.toString().trim();
}

// Whether `node` is wholly above or below what is in view.
function outOfView(node) {
  const { top, bottom } = node.getBoundingClientRect();
  return bottom < 0 || top > innerHeight;
}

/**
 * Lets the reader pick one thing drawn on the page with a click, which says what "this" is more
 * finely than the place. `pickable(target)` gives what a click on `target` picks, if anything:
 * the node drawn of it, or the nodes, where it is drawn in parts. It is framed until another is
 * picked, a click picks none, or the reader scrolls it from in view to out of view: they have
 * then moved on. `changed()` is called when the pick changes. Returns `set(parts)`, which picks
 * as a click does, `parts()`, the nodes of what is picked that are still drawn, `node()`, the
 * first of them, and `keep()`, to call before the preview scrolls the page itself, which moves
 * no reader on.
 */
export function picking(pickable, changed) {
  let picked = [];
  // Whether any of it was in view when last looked at: the reader moves on from what they saw.
  let inView = false;
  const shows = () => picked.some(node => !outOfView(node));
  // Whether the scrolling is the preview's own, which it is until the reader next moves. Not
  // until it ends: one scroll cut short by the next ends after that one has begun.
  let kept = false;
  for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
    addEventListener(type, () => { kept = false; }, { capture: true, passive: true });
  }
  const set = nodes => {
    const next = [nodes].flat().filter(Boolean);
    if (next.length === picked.length && next.every((node, at) => node === picked[at])) return;
    for (const node of picked) node.classList.remove('chosen');
    picked = next;
    for (const node of picked) node.classList.add('chosen');
    inView = shows();
    changed();
  };
  page.addEventListener('click', event => set(pickable(event.target)));
  addEventListener('scroll', () => {
    const was = inView;
    inView = shows();
    if (was && !inView && !kept) set();
  }, { passive: true });
  const parts = () => picked.filter(node => node.isConnected);
  return { set, parts, node: () => parts()[0], keep: () => { kept = true; } };
}
