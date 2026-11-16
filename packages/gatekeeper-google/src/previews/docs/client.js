// The Google Doc preview (GoogleDocGatekeeperImpl.getPreviewUi()): gadget-format client code that
// runs in the gadget UI frame, whose page starts it with main(gadget), at the end of this file.
// There `gadget` is a GoogleDocSession rather than a gadget server.
// The gatekeeper imports it as text through client.txt, a symlink to this file, and returns it
// with ui/chrome.js, which the previews of this gatekeeper share.
//
// Everything the document says is set as text or built node by node. Nothing from it is parsed
// as HTML into this document. A link is followed only by a click: inside the document to a tab
// or a heading, and out to the web, in a new browser tab, from text Google Docs has saved.

import {
  dataUrl, flash, foldArrow, leaveOutline, lineIcon, loadOnRefresh, make, motion, outline, outlineList, page,
  setOutline, setStops, showError, showLoading, showPage, showStale, status,
} from './ui/chrome.js';

// The session main() is handed, which every read below goes through.
let gadget;

const styleSheet = document.createElement('style');
styleSheet.textContent = `
  :root { --pad: 72px; }
  #page { box-sizing: border-box; max-width: var(--width); min-height: calc(100% - 32px);
    margin: 16px auto 120px; padding: var(--pad); background: var(--page); border-radius: 2px;
    box-shadow: var(--paper); overflow-wrap: anywhere; overflow-x: clip; animation: arrive .25s ease-out; }
  /* Clear of the buttons that float over the page's top corners. */
  @media (max-width: 700px) { #page { padding: 52px 24px 24px; margin: 0 0 120px; box-shadow: none; } }
  #page > * { position: relative; margin: 0; min-height: 1.5em; }
  /* The document's own spaces are kept, as Docs keeps them: code is indented with them. */
  #page > p, #page > :is(h1, h2, h3, h4, h5, h6), .item > :last-child { white-space: pre-wrap; }
  h1, h2, h3, h4, h5, h6 { margin: 0; font-weight: 400; scroll-margin-top: 12px; }
  h1 { font-size: 20pt; padding: 20px 0 6px; }
  h2 { font-size: 16pt; padding: 18px 0 6px; }
  h3 { font-size: 14pt; padding: 16px 0 4px; }
  h4, h5, h6 { font-size: 12pt; color: var(--dim); padding: 14px 0 4px; }
  .break { display: block; height: 16px; margin: 56px -100vw; background: var(--desk); }
  hr { border: 0; border-top: 1px solid var(--line); margin: .7em 0; }
  .item { display: flex; gap: 8px; }
  .item > .marker { flex: none; min-width: 1.5em; text-align: right; }
  .item > :last-child { flex: 1; min-width: 0; padding: 0; }
  .b { font-weight: 700; } .i { font-style: italic; } .s { text-decoration: line-through; }
  .link { color: var(--link); text-decoration: underline; cursor: text; }
  .link.go { cursor: pointer; }
  .link.s { text-decoration: underline line-through; }
  .chip { display: inline-block; padding: 0 8px; border-radius: 999px; background: var(--chip);
    color: var(--dim); font-size: 9pt; line-height: 1.7; user-select: none; }
  .picture { display: inline-flex; align-items: center; justify-content: center; max-width: 100%;
    padding: 0; border-radius: 4px; vertical-align: bottom; overflow: hidden; }
  /* Drawn for a white page, so a transparent image keeps one in the dark. */
  .picture img { display: block; width: 100%; height: 100%; background: #fff;
    animation: arrive .25s ease-out; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  td, th { border: 1px solid var(--line); padding: 5px 7px; height: 1.5em; vertical-align: top; text-align: left; }
  td > *, th > * { margin: 0; padding: 0; }
  td ul, td ol { padding-left: 1.5em; }

  /* A changed block carries a bar in the margin; what changed inside it is tinted. */
  .added::before, .removed::before, .changed::before { content: ''; position: absolute;
    left: -18px; top: 2px; bottom: 2px; width: 3px; border-radius: 2px; background: var(--mark-ink);
    transition: box-shadow .2s ease-out; }
  .removed::before { background: var(--gone-ink); }
  /* The change the navigator is on. */
  .here::before { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent); }
  .here:is(.added, .changed)::before { color: var(--mark-ink); }
  .here.removed::before { color: var(--gone-ink); }
  .added, ins { background: var(--mark); color: var(--mark-ink); text-decoration: none; }
  .removed, del { background: var(--gone); color: var(--gone-ink);
    text-decoration: line-through color-mix(in srgb, currentColor 55%, transparent); }
  .added, .removed { border-radius: 2px; box-shadow: -6px 0 0 var(--mark), 6px 0 0 var(--mark); }
  .removed { box-shadow: -6px 0 0 var(--gone), 6px 0 0 var(--gone); }
  ins, del { border-radius: 2px; padding: 1px 0; }
  del + ins { margin-left: 3px; }

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

const rail = make('div');
rail.id = 'rail';
const thumb = make('div');
thumb.id = 'thumb';

// ---------------------------------------------------------------------------------------------
// Markdown, read the way the gatekeeper's own converter reads it (markdown-converter.ts): a
// blank line between blocks except inside a list, a pair of blank lines for an empty paragraph,
// `\u000b` for a line break, two-space list nesting, a heading allowed inside a list item, and
// native tables as raw HTML. Document text is not escaped, so a backslash escapes only
// punctuation and a `*` or `~~` is formatting only where the rest of the line can close it.

const STRUCTURES = new Set(['[Table of contents]', '[Section break]']);
const EMPTY = { type: 'p', level: 0, text: '' };
const tablesOf = blocks => new Set(blocks.filter(block => block.type === 'table').map(block => block.text));

// The lines of the table that opens on line `i`.
function tableFrom(lines, i) {
  for (let end = i, depth = 0; end < lines.length; end++) {
    if (lines[end].trim() === '<table>') depth++;
    if (lines[end].trim() === '</table>' && --depth === 0) return lines.slice(i, end + 1);
  }
  return lines.slice(i);
}

// The blocks of `markdown`. With `tables`, the tables Google holds, only those are tables: the
// same lines in text a pending change writes are inserted as they are written.
function parseBlocks(markdown, tables) {
  const lines = markdown.split('\n');
  const blocks = [];
  // An ordered item after the first is written `1.`, so its number is counted here.
  const counters = [];
  let blank = 0;
  const pushEmpty = count => {
    for (let n = 0; n < count; n++) blocks.push(EMPTY);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      blank++;
      continue;
    }
    pushEmpty(blank >> 1);
    if (blank) counters.length = 0;
    blank = 0;
    const table = line.trim() === '<table>' && tableFrom(lines, i);
    if (table && (tables?.has(table.join('\n')) ?? true)) {
      blocks.push({ type: 'table', level: 0, text: table.join('\n'), table: i });
      i += table.length - 1;
    } else if (STRUCTURES.has(line)) {
      blocks.push({ type: 'structure', level: 0, text: line.slice(1, -1) });
    } else {
      const list = /^( *)(?:-|(\d+)\.) (.*)$/.exec(line);
      const content = list ? list[3] : line;
      const heading = /^(#{1,6}) (.*)$/.exec(content);
      const text = heading ? heading[2] : content;
      const block = {
        type: list ? (list[2] ? 'number' : 'bullet') : 'p',
        level: list ? list[1].length >> 1 : 0,
        heading: heading?.[1].length,
        text,
        line: i,
        offset: line.length - text.length,
      };
      counters.length = list ? block.level + 1 : 0;
      if (list?.[2]) block.number = counters[block.level] = (counters[block.level] ?? list[2] - 1) + 1;
      blocks.push(block);
    }
  }
  pushEmpty(blank >> 1);
  return blocks;
}

const BOLD = 1;
const ITALIC = 2;
const STRIKE = 4;
const PUNCTUATION = /[!-/:-@[-`{-~]/;
const PLACEHOLDER = /\\?\[(Image|Equation|Page break)\\?\]/y;

function findUnescaped(text, target, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === target) return i;
  }
  return -1;
}

// The `)` that closes the link destination opening at `open`, or -1.
function closingParen(text, open) {
  for (let i = open + 1, depth = 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

// One line's inline pieces: literal text, `*`/`~~` runs that may be formatting, links, and the
// things that are not text.
function scanInline(text) {
  const pieces = [];
  // A literal piece is a stretch of `text` as written, starting at `at`.
  const literal = (value, at) => {
    const last = pieces.at(-1);
    if (last?.literal && last.at + last.text.length === at) last.text += value;
    else pieces.push({ literal: true, text: value, at });
  };
  for (let i = 0; i < text.length;) {
    const character = text[i];
    PLACEHOLDER.lastIndex = i;
    const placeholder = (character === '\\' || character === '[') && PLACEHOLDER.exec(text);
    if (placeholder) {
      pieces.push({ kind: 'chip', text: placeholder[1] });
      i = PLACEHOLDER.lastIndex;
    } else if (character === '\\' && PUNCTUATION.test(text[i + 1] ?? '')) {
      literal(text[i + 1], i + 1);
      i += 2;
    } else if (character === '\u000b') {
      pieces.push({ kind: 'br' });
      i++;
    } else if (text.startsWith('<hr>', i)) {
      pieces.push({ kind: 'hr' });
      i += 4;
    } else if (character === '[') {
      const close = findUnescaped(text, ']', i + 1);
      const end = close >= 0 && text[close + 1] === '(' ? closingParen(text, close + 1) : -1;
      if (end < 0 || close === i + 1) {
        literal(character, i);
        i++;
      } else {
        const href = text.slice(close + 2, end).replace(/\\([\\()])/g, '$1');
        pieces.push({ label: text.slice(i + 1, close), href, at: i + 1 });
        i = end + 1;
      }
    } else if (character === '*' || text.startsWith('~~', i)) {
      let end = i;
      while (text[end] === character) end++;
      const size = end - i;
      const raw = text.slice(i, end);
      // The converter writes the document's own asterisks as they are: one with space on both
      // sides is text, as in `2 * 3`, since formatting has text against it on one side.
      if (character === '*' && !(/\s/.test(text[i - 1]) && /\s/.test(text[end]))) pieces.push({ size, raw, at: i });
      else if (character === '~' && (size === 2 || size === 4)) for (let n = 0; n < size; n += 2) pieces.push({ strike: true, raw: '~~', at: i + n });
      else literal(raw, i);
      i = end;
    } else {
      literal(character, i);
      i++;
    }
  }
  return pieces;
}

const toggle = (state, { strike, size }) => strike ? state ^ STRIKE
  : size === 1 ? state ^ ITALIC
  : size === 2 ? state ^ BOLD
  : size === 3 ? state ^ BOLD ^ ITALIC
  : size === 4 && state & ITALIC ? state ^ BOLD
  : undefined;

// The line as runs of `{ text, style, href, at }`, plus `{ kind }` for what is not text. `at` is
// where the run's text starts in the line.
function inlineRuns(text, href, base = 0, runs = [], from = 0) {
  const pieces = scanInline(text);
  const markers = pieces.filter(piece => piece.raw);
  // Bit `state` of closable[n] is set when markers n onward can bring `state` back to plain.
  const closable = new Uint8Array(markers.length + 1);
  closable[markers.length] = 1;
  for (let n = markers.length - 1; n >= 0; n--) {
    closable[n] = closable[n + 1];
    for (let state = 0; state < 8; state++) {
      const next = toggle(state, markers[n]);
      if (next !== undefined && closable[n + 1] & (1 << next)) closable[n] |= 1 << state;
    }
  }
  let state = 0;
  let n = 0;
  for (const piece of pieces) {
    if (piece.raw) {
      const next = toggle(state, piece);
      if (next !== undefined && closable[++n] & (1 << next)) state = next;
      else runs.push({ text: piece.raw, style: base | state, href, at: from + piece.at });
    } else if (piece.label !== undefined) {
      inlineRuns(piece.label, piece.href, base | state, runs, from + piece.at);
    } else {
      runs.push({ kind: piece.kind, text: piece.text, style: base | state, href, at: from + piece.at });
    }
  }
  return runs;
}

// The line a word at a time, which is what a change inside it is told apart by. Punctuation is
// apart from the word it stands by, so a comma put after a word is not the word changed.
const WORDS = /\s+|[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*|[^\s\p{L}\p{N}_]+/gu;
const wordsOf = text => inlineRuns(text).flatMap(run =>
  run.kind ? [run] : [...run.text.matchAll(WORDS)].map(word => ({ ...run, text: word[0], at: run.at + word.index })));
const wordKey = ({ kind, text, style, href }) => `${kind ?? ''}\u0000${style}\u0000${href ?? ''}\u0000${text}`;

function renderInline(words, parent) {
  let into;
  let look;
  for (const { kind, text, style, href, mark, look: paint } of words) {
    if (kind === 'br' || kind === 'hr') {
      parent.append(make(kind));
      look = undefined;
      continue;
    }
    // A page break is the gap between two sheets, unless it is the change being shown.
    if (text === 'Page break' && kind && !mark) {
      parent.appendChild(make('span', 'break')).setAttribute('aria-label', 'Page break');
      look = undefined;
      continue;
    }
    const classes = [kind === 'chip' && 'chip', text === 'Image' && kind && 'slot', style & BOLD && 'b', style & ITALIC && 'i',
      style & STRIKE && 's', href && 'link'].filter(Boolean).join(' ');
    const next = `${mark ?? ''}\u0000${href ?? ''}\u0000${classes}\u0000${paint ?? ''}`;
    if (next !== look || kind) {
      const tag = mark === 'added' ? 'ins' : mark === 'removed' ? 'del' : href ? 'a' : 'span';
      into = classes || mark || paint !== undefined ? parent.appendChild(make(tag, classes)) : parent;
      if (paint !== undefined) paintRun(into, paint, mark);
      if (href) into.dataset.href = href;
      look = kind ? undefined : next;
    }
    into.append(text);
  }
}

const TABLE_TAGS = new Set([
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'HR',
  'STRONG', 'EM', 'S', 'UL', 'OL', 'LI',
]);
const TABLE_ATTRIBUTES = new Set(['colspan', 'rowspan', 'start', 'type']);
// How the converter writes a list whose markers are in its text, or are zero-padded.
const LIST_STYLE = /^list-style-type: ([a-z-]+);?$/;

// Rebuild a table from an inert parse, keeping only known tags and attributes. A link becomes
// the same unfollowed span the Markdown path draws. `look` is how getStyles() says the outermost
// table is drawn, when it says.
function copyTableNode(node, into, look, depth = 0) {
  if (node.nodeType === Node.TEXT_NODE) {
    for (const [n, text] of node.data.split('[Image]').entries()) {
      if (n) into.append(make('span', 'chip slot', 'Image'));
      into.append(text);
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  let copy = into;
  if (node.tagName === 'A') {
    copy = into.appendChild(make('a', 'link'));
    copy.dataset.href = node.getAttribute('href') ?? '';
  } else if (TABLE_TAGS.has(node.tagName)) {
    copy = into.appendChild(make(node.tagName));
    if (node.tagName === 'TABLE') depth++;
    if (look && depth === 1) paintTable(node, copy, look);
    for (const { name, value } of node.attributes) {
      if (TABLE_ATTRIBUTES.has(name)) copy.setAttribute(name, value);
      const listStyle = name === 'style' && LIST_STYLE.exec(value);
      if (listStyle) copy.style.listStyleType = listStyle[1];
    }
  }
  for (const child of node.childNodes) copyTableNode(child, copy, look, depth);
}

function renderBlock(block, words, look) {
  if (block.type === 'table') {
    const parsed = new DOMParser().parseFromString(block.text, 'text/html');
    const holder = make('div');
    // Styles are for the table as written: one row and one cell for each the Markdown has.
    const rows = [...parsed.querySelectorAll('body > table > tbody > tr')];
    const fits = look?.rows.length === rows.length && rows.every((row, n) => row.children.length === look.rows[n].length);
    for (const child of parsed.body.childNodes) copyTableNode(child, holder, fits ? look : undefined);
    return holder;
  }
  if (block.type === 'structure') {
    const holder = make('div');
    holder.append(make('span', 'chip', block.text));
    return holder;
  }
  const content = make(block.heading ? `h${block.heading}` : block.type === 'p' ? 'p' : 'span');
  renderInline(words ?? wordsOf(block.text), content);
  // A line break that ends the paragraph leaves an empty line under it, which a browser draws
  // only with something on it.
  if (block.text.endsWith('\u000b')) content.append('\u200b');
  if (block.type === 'p') return content;
  const item = make('div', 'item');
  item.style.paddingLeft = `${block.level * 24 + 12}px`;
  item.append(make('span', 'marker', block.type === 'bullet' ? '•' : `${block.number}.`), content);
  return item;
}

// ---------------------------------------------------------------------------------------------
// What the pending changes did: block by block, then word by word inside a block that was edited

const blockKey = block => `${block.type}\u0000${block.level}\u0000${block.heading ?? ''}\u0000${block.text}`;

// Past this many comparisons, the stretch between the unchanged ends is shown as replaced whole.
const DIFF_LIMIT = 1_000_000;

// `current` in order, each item marked 'added' when `saved` lacks it, with the items of `saved`
// that are gone marked 'removed' where they were.
function diff(saved, current, keyOf) {
  const before = saved.map(keyOf);
  const after = current.map(keyOf);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }

  const rows = current.slice(0, start).map((item, n) => ({ item, was: saved[n] }));
  let i = start;
  let j = start;
  const width = afterEnd - start + 1;
  if ((beforeEnd - start) * (afterEnd - start) <= DIFF_LIMIT) {
    // The longest run both stretches share, counted from each position to the end.
    const common = new Uint32Array((beforeEnd - start + 1) * width);
    const cell = (row, column) => (row - start) * width + (column - start);
    for (let row = beforeEnd - 1; row >= start; row--) {
      for (let column = afterEnd - 1; column >= start; column--) {
        common[cell(row, column)] = before[row] === after[column]
          ? common[cell(row + 1, column + 1)] + 1
          : Math.max(common[cell(row + 1, column)], common[cell(row, column + 1)]);
      }
    }
    while (i < beforeEnd && j < afterEnd) {
      if (before[i] === after[j]) {
        rows.push({ item: current[j++], was: saved[i++] });
      } else if (common[cell(i + 1, j)] >= common[cell(i, j + 1)]) {
        rows.push({ item: saved[i++], mark: 'removed' });
      } else {
        rows.push({ item: current[j++], mark: 'added' });
      }
    }
  }
  while (i < beforeEnd) rows.push({ item: saved[i++], mark: 'removed' });
  while (j < afterEnd) rows.push({ item: current[j++], mark: 'added' });
  return rows.concat(current.slice(afterEnd).map((item, n) => ({ item, was: saved[beforeEnd + n] })));
}

// The words of `current` with what it gained and lost against `saved`, or undefined when the two
// share too little to be one block edited rather than one block replacing another.
function wordChanges(saved, current) {
  if (saved.type !== current.type || saved.type === 'table' || saved.type === 'structure') return;
  const rows = diff(wordsOf(saved.text), wordsOf(current.text), wordKey);
  const count = kind => rows.filter(({ item, mark }) => mark === kind && item.text?.trim()).length;
  if (count() < Math.max(count('added'), count('removed'))) return;
  // A word that stays is where it was in the saved line; one that came in is nowhere in it.
  return rows.map(({ item, mark, was }) => ({ ...item, mark, at: mark === 'added' ? undefined : (was ?? item).at }));
}

// Where blocks went and others came in their place, show each pair that is one block edited as
// that block with its changed words marked.
function pairEdits(rows) {
  const paired = [];
  for (let i = 0; i < rows.length;) {
    if (!rows[i].mark) {
      paired.push(rows[i++]);
      continue;
    }
    const removed = [];
    const added = [];
    // An empty paragraph has nothing to show as changed.
    for (; rows[i]?.mark; i++) {
      if (rows[i].mark === 'added') added.push(rows[i].item);
      else if (rows[i].item.text) removed.push(rows[i].item);
    }
    for (let n = 0; n < Math.max(removed.length, added.length); n++) {
      const words = removed[n] && added[n]?.text && wordChanges(removed[n], added[n]);
      if (words) {
        paired.push({ item: added[n], mark: 'changed', words, was: removed[n] });
        continue;
      }
      if (removed[n]) paired.push({ item: removed[n], mark: 'removed', was: removed[n] });
      // A block written over one of its kind is that paragraph still, with new words throughout.
      const over = removed[n]?.type === added[n]?.type && removed[n];
      if (added[n]) paired.push({ item: added[n], mark: added[n].text ? 'added' : undefined,
        ...(over && { was: over, words: wordsOf(added[n].text).map(word => ({ ...word, at: undefined })) }) });
    }
  }
  return paired;
}

// ---------------------------------------------------------------------------------------------
// Styles: the document's own type, colors and alignment, where getStyles() gives them

// Per tab: the saved Markdown the styles were read for, the named styles, and each paragraph's
// style by its line in that Markdown.
const looks = new Map();

const styleOf = block => block.heading ? `HEADING_${block.heading}` : 'NORMAL_TEXT';
// Without its styles the document is still drawn, in this page's own.
const NO_STYLES = { named: {}, runLooks: [], lines: new Map(), tables: new Map() };

async function readStyles(savedMarkdown, blocks) {
  // The tab asked about, which is no longer the one shown if another was chosen meanwhile.
  const id = tabId;
  let tab = looks.get(id);
  if (tab?.savedMarkdown === savedMarkdown) return tab;
  const styles = await gadget.getStyles(id);
  const { page: sheet, named, paragraphs, runLooks = [] } = styles;
  const lines = new Map(paragraphs.map(paragraph => [paragraph.line, paragraph]));
  // A paragraph whose style is not what its line reads as would put styles on the wrong blocks.
  const fits = blocks.every(block => {
    if (block.line === undefined) return true;
    const style = lines.get(block.line)?.style;
    return (style === 'TITLE' ? 'HEADING_1' : style?.startsWith('HEADING_') ? style : 'NORMAL_TEXT') === styleOf(block);
  });
  tab = { savedMarkdown, sheet, named, runLooks, lines: fits ? lines : new Map(),
    tables: new Map((styles.tables ?? []).map(table => [table.line, table])) };
  looks.set(id, tab);
  return tab;
}

const SERIF = /times|georgia|garamond|merriweather|playfair|lora|cambria|baskerville|slab|serif(?! ?pro)/i;
const MONO = /mono|courier|consolas|source code|menlo/i;
const COLOR = /^#[0-9a-f]{6}$/;

// The document's color as ink on this page. One chosen for a white page that would not read on
// a dark one keeps its hue and trades its lightness.
const dark = matchMedia('(prefers-color-scheme: dark)');
function ink(color) {
  if (!COLOR.test(color ?? '')) return;
  const [red, green, blue] = [1, 3, 5].map(at => {
    const channel = parseInt(color.slice(at, at + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const light = .2126 * red + .7152 * green + .0722 * blue;
  if (!dark.matches) return 1.05 / (light + .05) >= 1.5 ? color : undefined;
  // Contrast against the dark page, #1f1f1f.
  return (light + .05) / .064 >= 3.5 ? color : `hsl(from ${color} h s clamp(70, calc(100 - l), 89))`;
}

function paintFont(set, { fontFamily, fontSize }) {
  if (fontFamily) set.fontFamily = fontStack(fontFamily);
  if (fontSize) set.fontSize = `${fontSize}pt`;
}

// A fill was chosen with its text's color, so both are kept as the document has them. Without
// one the text's color is ink on this page.
function paintColors(set, fill, color) {
  if (COLOR.test(fill ?? '')) {
    set.background = fill;
    set.color = COLOR.test(color ?? '') ? color : '#1f1f1f';
  } else {
    const shade = ink(color);
    if (shade) set.color = shade;
  }
}

// Draw the copy of a table, row or cell of the outermost table as the document draws it.
function paintTable(node, copy, look) {
  if (node.tagName === 'TABLE' && look.columns) {
    const total = look.columns.reduce((sum, width) => sum + width, 0);
    copy.style.tableLayout = 'fixed';
    copy.style.width = `min(${total}pt, 100%)`;
    const columns = copy.appendChild(make('colgroup'));
    for (const width of look.columns) columns.appendChild(make('col')).style.width = `${width / total * 100}%`;
  }
  if (node.tagName !== 'TD') return;
  const cell = look.rows[node.parentNode.sectionRowIndex]?.[node.cellIndex];
  if (!cell) return;
  const set = copy.style;
  if (cell.verticalAlign) set.verticalAlign = cell.verticalAlign;
  for (const [side, { width, color }] of Object.entries(cell.borders ?? {})) {
    if (COLOR.test(color)) set.setProperty(`border-${side}`, width ? `${width}pt solid ${color}` : 'none');
  }
  const text = cell.look ?? {};
  paintFont(set, text);
  if (text.alignment) set.textAlign = text.alignment;
  paintColors(set, cell.background, text.color);
}

const fontStack = name => {
  const family = name.replace(/["\\]/g, '');
  return `"${family}", ${MONO.test(family) ? 'monospace' : SERIF.test(family) ? 'serif' : 'Arial, sans-serif'}`;
};

// The run looks of the tab being drawn.
let runLooks = [];

// Draw `element` as a run of the document's text is: its font, size, color and highlight. A
// marked word keeps the mark's own colors.
function paintRun(element, index, mark) {
  const look = runLooks[index];
  if (!look) return;
  paintFont(element.style, look);
  if (!mark) paintColors(element.style, look.highlight, look.color);
}

// Give each word of a saved paragraph the look of the run it is in, cut where a run starts or
// ends inside it: a run is of characters, and a word may be `(note)` with only `note` highlighted.
function lookUp(words, was, styles) {
  const runs = styles.lines.get(was?.line)?.runs;
  if (!runs) return words;
  const saved = words.flatMap(word => {
    if (word.at === undefined || word.kind) return [word];
    const from = was.offset + word.at;
    const inside = runs.flatMap(({ start, end }) => [start - from, end - from]).filter(cut => cut > 0 && cut < word.text.length);
    const cuts = [...new Set([0, ...inside, word.text.length])].toSorted((a, b) => a - b);
    return cuts.slice(1).map((end, n) => {
      const start = cuts[n];
      const run = runs.find(run => run.start <= from + start && from + start < run.end);
      return { ...word, text: word.text.slice(start, end), at: word.at + start, ...(run && { look: run.look }) };
    });
  });
  // Google draws text written into a paragraph as the text before it is, or as the text after
  // it at the paragraph's start, and what the edit removes is gone by then. A paragraph left
  // with none of its text draws the new as it began.
  const stays = word => word.at !== undefined && !word.kind && word.mark !== 'removed';
  let before = saved.find(stays) ?? { look: runs.find(run => run.start <= was.offset && was.offset < run.end)?.look };
  return saved.map(word => {
    if (stays(word)) before = word;
    return word.at === undefined && !word.kind && before.look !== undefined ? { ...word, look: before.look } : word;
  });
}

// Draw `element`, which shows `block`, as the saved paragraph `was` is styled, or as its kind of
// paragraph is when it is new.
function applyLook(element, block, was, mark, styles) {
  if (block.line === undefined) return;
  const paragraph = styles.lines.get(was?.line);
  if (paragraph?.headingId) element.dataset.heading = paragraph.headingId;
  const style = paragraph?.style ?? styleOf(block);
  const look = { ...styles.named[style], ...paragraph?.look };
  const text = block.type === 'p' ? element : element.lastChild;
  const set = text.style;
  paintFont(set, look);
  if (look.bold !== undefined) set.fontWeight = look.bold ? 700 : 400;
  if (look.italic !== undefined) set.fontStyle = look.italic ? 'italic' : 'normal';
  // The converter writes a subtitle as italic whatever its style says.
  if (style === 'SUBTITLE') for (const run of text.querySelectorAll('.i')) run.classList.remove('i');
  const shade = mark !== 'added' && mark !== 'removed' && ink(look.color);
  if (shade) set.color = shade;
  if (COLOR.test(look.shading ?? '') && !mark) {
    element.style.background = look.shading;
    if (!set.color) set.color = '#1f1f1f';
  }
  if (look.alignment) set.textAlign = look.alignment;
  if (look.lineSpacing) set.lineHeight = look.lineSpacing * 1.2;
  if (look.spaceAbove !== undefined) element.style.paddingTop = `${look.spaceAbove}pt`;
  if (look.spaceBelow !== undefined) element.style.paddingBottom = `${look.spaceBelow}pt`;
}

// ---------------------------------------------------------------------------------------------
// Images: each placeholder becomes a box of the image's size, filled once its bytes are read

// Per tab: what listImages() returned, and each image's data: URL as it is read.
const pictures = new Map();

async function readPicture(image, id) {
  const { mimeType, bytes } = await gadget.readImage(image.id, id);
  return dataUrl(bytes, mimeType);
}

async function showImages(slots, current) {
  const id = tabId;
  let tab = pictures.get(id);
  if (tab?.list.length !== slots.length) {
    tab = { list: await gadget.listImages(id), urls: new Map() };
    pictures.set(id, tab);
  }
  // Text that spells a placeholder would put every image after it in the wrong box.
  if (tab.list.length !== slots.length) return;
  for (const [n, image] of tab.list.entries()) {
    if (current !== generation) return;
    const slot = slots[n];
    if (!image.width || !image.height) continue;
    slot.classList.add('picture');
    slot.style.width = `${image.width}pt`;
    slot.style.aspectRatio = `${image.width} / ${image.height}`;
    if (image.description) slot.title = image.description;
    if (!image.readable) continue;
    // One at a time, so no more than one image is in flight.
    slot.classList.add('wait');
    if (!tab.urls.has(image.id)) tab.urls.set(image.id, readPicture(image, id));
    const url = await tab.urls.get(image.id).catch(() => tab.urls.delete(image.id) && undefined);
    slot.classList.remove('wait');
    if (!url) continue;
    const picture = make('img');
    picture.src = url;
    picture.alt = image.description ?? '';
    slot.replaceChildren(picture);
  }
}

// ---------------------------------------------------------------------------------------------
// Loading and refreshing

let tabs = [];
let tabId = null;
let loaded = false;
let generation = 0;
// What the last drawing showed as changed, so the next one can tell what is new.
let shown = new Set();

// ---------------------------------------------------------------------------------------------
// The outline: the document's tabs and, under the one shown, its headings, as Docs lists them
// beside the page, with a dot on each heading whose section holds a change.

const HEADINGS = 'h1, h2, h3, h4, h5, h6';
let headings = [];
let entries = [];
// What has been folded away: a tab by its ID, a heading by its tab, level and text.
const folded = new Set();
const fold = (key, label) => foldArrow(key, label, folded, renderOutline);
let reading = -1;

function renderOutline() {
  // As in Docs, a heading inside a table is not listed; one being removed is no longer there.
  headings = [...page.querySelectorAll(HEADINGS)]
    .filter(heading => !heading.closest('.removed, table') && heading.textContent.trim());
  const blocks = headings.map(heading => heading.closest('#page > *'));
  const top = Math.min(...headings.map(heading => Number(heading.tagName[1])));
  const levels = headings.map(heading => Number(heading.tagName[1]) - top);
  // The heading whose headings are folded away, while the ones under it are passed.
  let folder;
  entries = headings.map((heading, index) => {
    const copy = heading.cloneNode(true);
    for (const gone of copy.querySelectorAll('del')) gone.remove();
    const level = levels[index];
    const entry = make('button', level ? 'entry' : 'entry top');
    entry.appendChild(make('span', '', copy.textContent.trim()));
    entry.title = entry.textContent;
    // A heading that has just arrived arrives here as it does on the page.
    if (heading.closest('.fresh')) entry.classList.add('fresh');
    for (let block = blocks[index]; block; block = block.nextElementSibling) {
      if (block !== blocks[index] && blocks.includes(block)) break;
      if (block.matches('.added, .removed, .changed')) entry.classList.add('touched');
    }
    entry.addEventListener('click', () => {
      heading.scrollIntoView({ block: 'start', behavior: motion() });
      leaveOutline();
    });
    const key = `${tabId}\u0000${level}\u0000${entry.textContent}`;
    const row = make('div', 'row');
    row.style.paddingLeft = `${level * 12}px`;
    row.append(fold(levels[index + 1] > level && key, 'Headings under this one'), entry);
    if (folder && level <= folder.level) folder = undefined;
    row.hidden = !!folder;
    // A change in a section folded away still shows, on the heading it is folded under.
    if (folder && entry.matches('.touched')) folder.entry.classList.add('touched');
    else if (!folder && folded.has(key)) folder = { level, entry };
    return entry;
  });
  rail.replaceChildren(thumb, ...entries.map(entry => entry.parentElement));
  thumb.hidden = entries.length === 0;
  // A document of one tab lists only its headings.
  const several = tabs.length > 1;
  outlineList.replaceChildren(...!several ? [rail] : tabs.flatMap(tab => {
    const on = tab.id === tabId;
    const row = make('div', on ? 'tab on' : 'tab');
    const name = make('button', 'name');
    name.append(lineIcon('M6 3h5.5L15 6.5V17H6zM11.5 3v3.5H15M8.5 10.5h4M8.5 13.5h4'), make('span', '', tab.title));
    // A tab still to be added goes by an ID of this form until Google has it.
    const added = tab.id.startsWith('pending-tab-');
    row.classList.toggle('new', added);
    name.title = added ? `${tab.title} (new, not yet added)` : tab.title;
    name.setAttribute('aria-pressed', String(on));
    name.addEventListener('click', () => {
      if (on) return void document.scrollingElement.scrollTo({ top: 0, behavior: motion() });
      selectTab(tab.id);
      void load();
      renderOutline();
    });
    row.style.marginLeft = `${tab.nestingLevel * 12}px`;
    row.append(fold(on && entries.length > 0 && tab.id, 'Headings in this tab'), name);
    return on && !folded.has(tab.id) ? [row, rail] : [row];
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

addEventListener('scroll', () => requestAnimationFrame(markHeading), { passive: true });
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

function destination(link) {
  const address = link.dataset.href ?? '';
  const [, tab, kind, id] = /^(?:\?tab=([^#]*))?(?:#(heading|bookmark)=(.*))?$/.exec(address) ?? [];
  if (tab === undefined && kind === undefined) {
    if (!/^https?:\/\//i.test(address)) return { hint: address };
    return link.closest('ins, del, .added, .removed')
      ? { hint: `Not opened while its change is pending: ${address}` }
      : { web: address, hint: address };
  }
  const to = tabs.find(found => found.id === decoded(tab ?? ''));
  const elsewhere = to && to.id !== tabId ? to : undefined;
  if (kind === 'bookmark') {
    return elsewhere
      ? { tab: elsewhere.id, hint: `Go to a bookmark in “${elsewhere.title}”, shown from its top` }
      : { hint: 'A bookmark in this document, which the preview cannot find' };
  }
  const heading = kind && decoded(id);
  if (elsewhere) return { tab: elsewhere.id, heading, hint: `Go to “${elsewhere.title}”` };
  const target = [...page.querySelectorAll('[data-heading]')]
    .find(element => element.dataset.heading === heading);
  if (target) return { heading, hint: `Go to “${target.textContent.trim()}”` };
  return { hint: heading ? 'A heading the preview cannot find' : '' };
}

// Each link says where it leads, and looks followed only if it is.
function describeLinks() {
  for (const link of page.querySelectorAll('.link')) {
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
  const { tab, heading } = destination(link);
  if (tab) {
    selectTab(tab);
    await load();
  }
  const target = heading && [...page.querySelectorAll('[data-heading]')]
    .find(element => element.dataset.heading === heading);
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: motion() });
  flash(target);
});

function selectTab(id) {
  tabId = id;
  loaded = false;
  shown = new Set();
}

async function load() {
  const current = ++generation;
  if (loaded) status('Updating…');
  else showLoading();
  try {
    // Listed each time: a tab can be added, discarded or renamed between two drawings. An added
    // tab is listed under another ID once Google has it, so the one shown is found by its title,
    // where it was listed first: titles can repeat.
    const at = tabs.findIndex(tab => tab.id === tabId);
    const title = tabs[at]?.title;
    const listed = await gadget.listTabs();
    if (current !== generation) return;
    tabs = listed;
    if (!tabs.some(tab => tab.id === tabId)) {
      selectTab(([tabs[at], ...tabs].find(tab => tab?.title === title) ?? tabs[0])?.id);
      showLoading();
    }
    renderOutline();
    // One read: the tab as saved, the tab with its pending changes, and those changes.
    const { savedMarkdown, markdown, changes } = await gadget.getPendingChanges(tabId);
    if (current !== generation) return;

    const saved = parseBlocks(savedMarkdown);
    const styles = await readStyles(savedMarkdown, saved).catch(() => NO_STYLES);
    if (current !== generation) return;
    runLooks = styles.runLooks;
    const rows = pairEdits(diff(saved, markdown === savedMarkdown ? saved : parseBlocks(markdown, tablesOf(saved)), blockKey));
    const { width, marginTop, marginRight, marginLeft } = styles.sheet ?? {};
    if (width) {
      document.documentElement.style.setProperty('--width', `${width}pt`);
      page.style.setProperty('--pad', `${marginTop}pt ${marginRight}pt ${marginTop}pt ${marginLeft}pt`);
    }
    const scrollTop = document.scrollingElement.scrollTop;
    const drawn = new Set();
    let firstFresh;
    let marked = false;
    // Each stretch of changed blocks is one place for the navigator.
    const stops = [];
    page.replaceChildren(...rows.map(({ item, mark, words, was }) => {
      const text = item.line === undefined ? words : lookUp(words ?? wordsOf(item.text), was, styles);
      const element = renderBlock(item, text, styles.tables.get(was?.table));
      applyLook(element, item, was, mark, styles);
      if (mark) {
        const key = `${mark}\u0000${blockKey(item)}`;
        drawn.add(key);
        element.classList.add(mark);
        if (marked) stops.at(-1).push(element);
        else stops.push([element]);
        if (loaded && !shown.has(key)) {
          element.classList.add('fresh');
          firstFresh ??= element;
        }
      }
      marked = !!mark;
      return element;
    }));
    shown = drawn;
    setStops(stops);
    showStale(changes.filter(change => change.stale).length, 'document');
    showPage();
    renderOutline();
    describeLinks();
    document.scrollingElement.scrollTop = scrollTop;
    // A new change is what to look at; on opening, so is the first one there is.
    (firstFresh ?? (loaded ? undefined : stops[0]?.[0]))?.scrollIntoView({ block: 'nearest', behavior: motion() });
    status('');
    loaded = true;
    const slots = [...page.querySelectorAll('.slot')].filter(slot => !slot.closest('.removed'));
    if (slots.length) void showImages(slots, current).catch(() => {});
  } catch (error) {
    if (current !== generation) return;
    status('');
    showError(error, 'document', load);
  }
}

export default {
  main(session) {
    gadget = session;
    loadOnRefresh(load);
  },
};
