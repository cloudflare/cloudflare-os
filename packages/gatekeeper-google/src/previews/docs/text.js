// The Markdown of a Google Doc tab, read block by block and word by word, and what its pending
// changes did to it. The preview draws a block the changes left alone as Google Docs has it, from
// the tab's drawing, and one they wrote from the words here. Nothing in this file touches the page.

// ---------------------------------------------------------------------------------------------
// Markdown, read the way the gatekeeper's own converter reads it (markdown-converter.ts): a
// blank line between blocks except inside a list, a pair of blank lines for an empty paragraph,
// `\u000b` for a line break, two-space list nesting, a heading allowed inside a list item, and
// native tables as raw HTML. Document text is not escaped, so a backslash escapes only
// punctuation and a `*` or `~~` is formatting only where the rest of the line can close it.

const STRUCTURES = new Set(['[Table of contents]', '[Section break]']);
export const tablesOf = blocks => new Set(blocks.filter(block => block.type === 'table').map(block => block.text));

// The lines of the table that opens on line `i`.
function tableFrom(lines, i) {
  for (let end = i, depth = 0; end < lines.length; end++) {
    if (lines[end].trim() === '<table>') depth++;
    if (lines[end].trim() === '</table>' && --depth === 0) return lines.slice(i, end + 1);
  }
  return lines.slice(i);
}

/**
 * The blocks of `markdown`. Only the tables Google holds are tables, which `isTable` says of the
 * lines that read as one and the line they start on: the same lines in a paragraph's text, or in
 * text a pending change writes, are what they say. A line in `plain` is one Google holds that is
 * no heading, though its text starts as one is written.
 */
export function parseBlocks(markdown, isTable, plain) {
  const lines = markdown.split('\n');
  const blocks = [];
  let blank = 0;
  // Blocks are a blank line apart, so of the blank lines before `end` every other one is an
  // empty paragraph: the first of them when they open the document, the second otherwise.
  const pushEmpty = end => {
    const first = end - blank + (end > blank ? 1 : 0);
    for (let nth = 0; nth < blank >> 1; nth++) blocks.push({ type: 'p', level: 0, text: '', line: first + 2 * nth });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      blank++;
      continue;
    }
    pushEmpty(i);
    blank = 0;
    const table = line.trim() === '<table>' && tableFrom(lines, i);
    if (table && isTable(table.join('\n'), i)) {
      blocks.push({ type: 'table', level: 0, text: table.join('\n'), line: i });
      i += table.length - 1;
    } else if (STRUCTURES.has(line)) {
      blocks.push({ type: 'structure', level: 0, text: line.slice(1, -1), line: i });
    } else {
      const list = /^( *)(?:-|(\d+)\.) (.*)$/.exec(line);
      const content = list ? list[3] : line;
      const heading = plain?.has(line) ? undefined : /^(#{1,6}) (.*)$/.exec(content);
      const text = heading ? heading[2] : content;
      blocks.push({
        type: list ? (list[2] ? 'number' : 'bullet') : 'p',
        level: list ? list[1].length >> 1 : 0,
        heading: heading?.[1].length,
        text,
        line: i,
        offset: line.length - text.length,
      });
    }
  }
  pushEmpty(lines.length);
  return blocks;
}

export const BOLD = 1;
export const ITALIC = 2;
export const STRIKE = 4;
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
export const wordsOf = text => inlineRuns(text).flatMap(run =>
  run.kind ? [run] : [...run.text.matchAll(WORDS)].map(word => ({ ...run, text: word[0], at: run.at + word.index })));
const wordKey = ({ kind, text, style, href }) => `${kind ?? ''}\u0000${style}\u0000${href ?? ''}\u0000${text}`;

// ---------------------------------------------------------------------------------------------
// What the pending changes did: block by block, then word by word inside a block that was edited

export const blockKey = block => `${block.type}\u0000${block.level}\u0000${block.heading ?? ''}\u0000${block.text}`;

// Past this many comparisons, the stretch between the unchanged ends is shown as replaced whole.
const DIFF_LIMIT = 1_000_000;

/**
 * `current` in order, each item marked 'added' when `saved` lacks it, with the items of `saved`
 * that are gone marked 'removed' where they were.
 */
export function diff(saved, current, keyOf) {
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

/**
 * Where blocks went and others came in their place, show each pair that is one block edited as
 * that block with its changed words marked.
 */
export function pairEdits(rows) {
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
      // A block written over one of its kind is that paragraph still, with new words throughout:
      // `over` on both says the one that went needs no mark of its own where it is left out.
      const over = !!added[n]?.text && removed[n]?.type === added[n].type;
      if (removed[n]) paired.push({ item: removed[n], mark: 'removed', was: removed[n], over });
      if (added[n]) paired.push({ item: added[n], mark: added[n].text ? 'added' : undefined, ...over && { was: removed[n], over } });
    }
  }
  return paired;
}
