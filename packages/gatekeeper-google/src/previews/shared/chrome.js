// What every preview of this gatekeeper shares: its colors, and the parts around the resource it
// draws. Those are the page the resource is drawn on, the status, the note on changes that no
// longer fit and the change navigator, the outline sheet, and the loading and error states. A preview
// imports this as ./ui/chrome.js and draws its resource into `page`.
//
// Importing it builds those parts into the frame's document, which holds one preview.

const styleSheet = document.createElement('style');
styleSheet.textContent = `
  :root { color-scheme: light dark; --page: #fff; --desk: #f1f3f4; --ink: #1f1f1f; --dim: #5f6368;
    --line: #dadce0; --mark: #e6f4ea; --mark-ink: #137333; --gone: #fce8e6; --gone-ink: #a50e0e;
    --link: #1a73e8; --chip: #f1f3f4; --shine: #e8eaed; --width: 816px;
    --paper: 0 1px 2px rgb(60 64 67 / .2), 0 4px 14px rgb(60 64 67 / .1);
    --float: 0 1px 3px rgb(60 64 67 / .24), 0 6px 20px rgb(60 64 67 / .14); }
  @media (prefers-color-scheme: dark) {
    :root { --page: #1f1f1f; --desk: #131314; --ink: #e3e3e3; --dim: #9aa0a6; --line: #3c4043;
      --mark: #1e3a2a; --mark-ink: #81c995; --gone: #3b1f1d; --gone-ink: #f28b82;
      --link: #8ab4f8; --chip: #2d2f31; --shine: #3c4043; --paper: 0 0 0 1px var(--line);
      --float: 0 0 0 1px var(--line), 0 8px 24px rgb(0 0 0 / .5); }
  }
  html, body { margin: 0; height: 100%; background: var(--desk); color: var(--ink);
    font: 11pt/1.5 Arial, Helvetica, sans-serif; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
  :is(#nav button, #outline-toggle, .fold):active { transform: scale(.9); }
  [hidden] { display: none !important; }

  /* What has just arrived, what is being pointed out, and what is still being read. */
  .fresh { animation: arrive .35s ease-out, glow 1.4s ease-out; }
  .flash { animation: glow 1.4s ease-out; }
  @keyframes arrive { from { opacity: 0; transform: translateY(4px); } }
  @keyframes glow { 0%, 35% { filter: brightness(.9) saturate(2.2); } }
  .ghost, .wait { background: linear-gradient(90deg, var(--chip) 25%, var(--shine) 50%, var(--chip) 75%) 0 0 / 200% 100%;
    animation: shimmer 1.4s linear infinite; }
  .ghost { height: 12px; margin: 14px 0 !important; min-height: 0 !important; border-radius: 6px; }
  @keyframes shimmer { to { background-position: -200% 0; } }

  #bar { position: fixed; z-index: 1; top: 10px; right: 14px; display: flex; align-items: center;
    gap: 8px; font-size: 12px; color: var(--dim); }
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
  #nav { display: flex; align-items: center; gap: 2px; padding: 2px 3px 2px 12px;
    border-radius: 999px; background: var(--page); box-shadow: var(--float); color: var(--ink);
    font-size: 12px; white-space: nowrap; animation: arrive .2s ease-out; }
  #nav span { margin-right: 4px; color: var(--dim); }
  /* The dot that says something holds a change, or is one. */
  .touched::after, .tab.new .name::after { content: ''; flex: none; width: 6px;
    height: 6px; border-radius: 50%; background: var(--mark-ink); box-shadow: 0 0 0 3px var(--mark); }
  .touched::after, .tab.new .name::after { margin-right: 3px; }
  #nav button { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0;
    border-radius: 50%; background: none; color: var(--dim); transition: background .12s, color .12s; }
  #nav button:hover { background: var(--chip); color: var(--ink); }

  /* The outline stands beside the page where there is room, and over it where there is not. */
  #outline-toggle { position: fixed; z-index: 3; top: 6px; left: 10px; display: grid;
    place-items: center; width: 28px; height: 28px; border: 0; border-radius: 50%; background: none;
    color: var(--dim); transition: background .15s, color .15s; }
  #outline-toggle:hover, #outline-toggle[aria-expanded="true"] { background: var(--chip); color: var(--ink); }
  #outline { position: fixed; z-index: 2; inset: 0 auto 0 0; box-sizing: border-box; width: 240px;
    padding: 0 10px 24px 14px; overflow-y: auto; scrollbar-width: thin;
    scrollbar-color: var(--line) transparent; background: var(--desk);
    font-size: 12px; animation: slide .2s ease-out; }
  #outline h2 { position: sticky; z-index: 1; top: 0; margin: 0 -10px 6px -14px; padding: 0 0 0 48px;
    background: inherit; font-size: 11px; font-weight: 700; line-height: 40px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--dim); }
  /* The parts a resource is divided into, such as a document's tabs: the one shown is marked. */
  #outline .tab { display: flex; align-items: center; margin: 2px 0; padding: 0 6px 0 4px;
    border-radius: 999px; color: var(--dim); transition: background .12s, color .12s;
    scroll-margin: 46px 0 8px; }
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
  @keyframes slide { from { opacity: 0; transform: translateX(-12px); } }
  body { transition: padding-left .2s ease-out; }
  /* Where there is room the outline is a sheet of its own beside the page: level with it, and
     kept to its edge rather than the frame's. Its button stays where that sheet's corner is. */
  :root { --outline: 240px; --top: 16px; }
  @media (min-width: 1400px) { :root { --outline: 296px; } }
  @media (min-width: 1000px) {
    body { --dock: calc(8px + max(0px, (100% - var(--outline) - 20px - var(--width)) / 2)); }
    .outlined { padding-left: calc(var(--outline) + 20px); }
    #outline { inset: var(--top) auto 16px var(--dock); width: var(--outline); border-radius: 8px;
      background: var(--page); box-shadow: var(--paper); }
    #outline-toggle { top: calc(var(--top) + 6px); left: calc(var(--dock) + 10px); }
  }
  @media (max-width: 999px) {
    #outline { background: var(--page); border-radius: 0 12px 12px 0;
      box-shadow: var(--float), 8px 0 32px rgb(0 0 0 / .18); }
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

/** A data: URL of `bytes`, which is the only address the frame may draw a picture from. */
export const dataUrl = (bytes, type) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener('load', () => resolve(reader.result));
  reader.addEventListener('error', () => reject(reader.error));
  reader.readAsDataURL(new Blob([bytes], { type }));
});

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
const outlineTitle = outline.appendChild(make('h2'));
export const outlineList = outline.appendChild(make('div'));

const wide = matchMedia('(min-width: 1000px)');
const roomForOutline = () => wide.matches;
// Whether the person opened or closed the outline; until they do it is open where there is room.
let outlineChosen;

// Tells the preview, with an `outlinechange` event, so it can mark where the reading is.
function showOutline(open) {
  outline.hidden = !open;
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
  // Level with the page, which a note above it moves.
  document.documentElement.style.setProperty('--top', `${page.offsetTop}px`);
  outlineToggle.hidden = !any;
  showOutline(any && (outlineChosen ?? roomForOutline()));
}

/** Closes an outline that lies over the page, once something in it was picked. */
export function leaveOutline() {
  if (!roomForOutline()) showOutline(outlineChosen = false);
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

// ---------------------------------------------------------------------------------------------
// The status and the change navigator, which steps through the places the changes touch

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
const nav = bar.appendChild(make('div'));
nav.id = 'nav';
nav.hidden = true;
nav.setAttribute('role', 'group');
// What the arrows step through. The group's own label says it, with how many there are.
nav.appendChild(make('span', '', 'Changes')).ariaHidden = 'true';
// Each place a change touches, as the elements drawn there, and the one the navigator is on.
let stops = [];
let stop = -1;

function showChange(step) {
  for (const element of stops[stop] ?? []) element.classList.remove('here');
  stop = (stop + step + stops.length) % stops.length;
  stops[stop][0].scrollIntoView({ block: 'center', behavior: motion() });
  for (const element of stops[stop]) {
    element.classList.add('here');
    flash(element);
  }
}

for (const [label, path, step] of [
  ['Previous change', 'M6 12l4-4.5 4 4.5', -1], ['Next change', 'M6 8l4 4.5L14 8', 1],
]) {
  const button = nav.appendChild(make('button'));
  button.append(lineIcon(path, 16));
  button.setAttribute('aria-label', label);
  button.addEventListener('click', () => showChange(step));
}

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

/** Fills the page with the outline of text still to come. */
export function showLoading() {
  page.hidden = false;
  page.setAttribute('aria-busy', 'true');
  page.replaceChildren(...[38, 92, 100, 96, 71, 0, 100, 88, 94, 52].map(width => {
    const line = make('div', width ? 'ghost' : '');
    line.style.width = `${width}%`;
    return line;
  }));
}

/** Shows the page as drawn, after showLoading() or showError(). */
export function showPage() {
  page.hidden = false;
  page.removeAttribute('aria-busy');
  document.getElementById('error')?.remove();
}

/** Says the `resource` could not be loaded, in place of the page, and offers to `retry`. */
export function showError(error, resource, retry) {
  page.hidden = true;
  nav.hidden = true;
  document.getElementById('error')?.remove();
  const box = document.body.appendChild(make('div'));
  box.id = 'error';
  box.setAttribute('role', 'alert');
  box.append(lineIcon('M10 6.5v4M10 13.5h.01M10 2.5a7.5 7.5 0 100 15 7.5 7.5 0 000-15z', 28),
    make('strong', '', `This ${resource} could not be loaded`), make('p', '', error?.message));
  box.appendChild(make('button', '', 'Try again')).addEventListener('click', () => {
    box.remove();
    retry();
  });
}

/**
 * Calls `load` now and whenever the Workshop says an action on this connection was queued,
 * applied or discarded. A gadget cannot see the action log, so nothing inside the frame could tell.
 */
export function loadOnRefresh(load) {
  addEventListener('message', event => {
    if (event.source === parent && event.data?.type === 'refresh') void load();
  });
  void load();
}
