// What its pending changes make of a Google Doc tab: the blocks of its drawing
// (GoogleDocRenderingReads.readDrawing()) with the edits of its pending drawing
// (readPendingDrawing()) laid over them, as rows that each view of the tab is drawn from. A block
// of an edit states only the looks the gatekeeper's copy of the document keeps, so it takes the
// rest from the saved block it stands for, or beside. Nothing in this file touches the page.

import { newList } from './draw.js';

// Google Docs' own styles, which a paragraph is set in where the drawing names none for its style.
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

/**
 * `drawing` as it is drawn. One that names no style is the blank page the gatekeeper draws for a
 * document or a tab still to be made, and the one empty paragraph on it is set in a look made up
 * for it. It is set as Google Docs sets a new document instead, and so is what is written there.
 */
export const plain = drawing => Object.keys(drawing.named).length ? drawing : {
  ...drawing,
  paragraphLooks: drawing.paragraphLooks.map(() => PLAIN.NORMAL_TEXT.paragraph),
  textLooks: drawing.textLooks.map(() => PLAIN.NORMAL_TEXT.text),
};

// ---------------------------------------------------------------------------------------------
// Looks. These two are all that reads what a pending look states (GoogleDocPendingTextLook and
// GoogleDocPendingParagraphLook): what it states, over what its named style sets, and in all it
// cannot state as `beside`, the saved text or paragraph it stands for or beside.

function textLook(stated, named, beside = named) {
  const bold = stated.bold ?? named.weight >= 700;
  const color = stated.color ?? named.color;
  return {
    fontFamily: beside.fontFamily,
    fontSize: stated.fontSize ?? named.fontSize,
    // The weight its family is set at beside it, and bold of it as Google Docs draws that: a
    // step up from a weight lighter than regular.
    weight: !bold ? beside.weight < 700 ? beside.weight : 400 : beside.weight < 400 ? 400 : Math.max(beside.weight, 700),
    ...(stated.italic ?? named.italic) && { italic: true },
    ...(stated.underline ?? named.underline) && { underline: true },
    ...(stated.strikethrough ?? named.strikethrough) && { strikethrough: true },
    ...beside.smallCaps && { smallCaps: true },
    ...beside.baseline && { baseline: beside.baseline },
    ...color && { color },
    ...beside.highlight && { highlight: beside.highlight },
  };
}

/** `level` is the paragraph's level of its list, which indents an item that states no indent. */
const paragraphLook = (stated, named, beside = named, level) => ({
  ...beside,
  alignment: stated.alignment === 'start' ? undefined : stated.alignment ?? named.alignment,
  indentStart: stated.indentStart ?? named.indentStart ?? level?.indentStart,
  indentFirstLine: stated.indentFirstLine ?? named.indentFirstLine ?? level?.indentFirstLine,
});

// Whether two looks are one in all a pending look states.
const sameText = (a, b) => a.fontSize === b.fontSize && a.color === b.color && a.weight >= 700 === b.weight >= 700 &&
  ['italic', 'underline', 'strikethrough'].every(name => !a[name] === !b[name]);
const sameSetting = (a, b) => a.alignment === b.alignment &&
  ['indentStart', 'indentFirstLine'].every(name => (a[name] ?? 0) === (b[name] ?? 0));

// ---------------------------------------------------------------------------------------------
// Lining up what was with what is

/** What `block` says: a paragraph's text, and a table's cell by cell. */
export const said = block => block.type === 'paragraph' ? block.runs.map(run => run.text ?? '').join('')
  : block.type === 'table' ? block.rows.flatMap(row => row.cells.map(cell => cell.blocks.map(said).join('\n'))).join('\t')
  : '';

// What `words` say, kept with the set of them, for telling what is akin.
const heard = words => ({ words, held: new Set(words) });
// What `make` makes of a block or a row, made once however often it is compared.
const once = (make, made = new WeakMap()) => item => made.get(item) ?? made.set(item, make(item)).get(item);

// Whether two things said share half of what the one that says less says.
function akin(a, b) {
  const [few, many] = a.words.length <= b.words.length ? [a, b] : [b, a];
  return few.words.length ? few.words.filter(word => many.held.has(word)).length * 2 >= few.words.length : !many.words.length;
}

// Past this many comparisons, what two lists hold between the ends they share is replaced whole.
const MOST_COMPARISONS = 1_000_000;

/** Where `a` and `b` stop being one from the start, and where each starts being one with the other to its end, as `same` tells it. */
function shared(a, b, same) {
  let head = 0;
  let [aEnd, bEnd] = [a.length, b.length];
  while (head < aEnd && head < bEnd && same(a[head], b[head])) head++;
  while (aEnd > head && bEnd > head && same(a[aEnd - 1], b[bEnd - 1])) {
    aEnd--;
    bEnd--;
  }
  return [head, aEnd, bEnd];
}

/**
 * `was` and `now` in order, as pairs of what `alike` says is one thing in both: `[saved, pending]`,
 * with `[saved]` for what is gone and `[, pending]` for what came. The two share the ends where
 * each says what the other does, as `same` tells it: being alike is too little there, where it
 * would pair two of several that are alike but not the same. Between them each of `now` is paired
 * with the first of `was` like it that is past the last one paired, so what moved is gone and
 * came; too many to compare are all gone and come.
 */
function lineUp(was, now, alike, same) {
  const [head, wasEnd, nowEnd] = shared(was, now, same);
  const lined = was.slice(0, head).map((saved, at) => [saved, now[at]]);
  let from = head;
  let came = [];
  const pass = to => {
    lined.push(...was.slice(from, to).map(saved => [saved]), ...came);
    came = [];
    from = to + 1;
  };
  const compared = (wasEnd - head) * (nowEnd - head) <= MOST_COMPARISONS;
  for (const item of now.slice(head, nowEnd)) {
    const at = compared ? was.findIndex((saved, place) => place >= from && place < wasEnd && alike(saved, item)) : -1;
    if (at < 0) {
      came.push([undefined, item]);
      continue;
    }
    pass(at);
    lined.push([was[at], item]);
  }
  pass(wasEnd);
  return [...lined, ...was.slice(wasEnd).map((saved, at) => [saved, now[nowEnd + at]])];
}

/**
 * How the list `a` becomes `b`: each place as `[i, j]` of the two, with `i` alone for what is gone
 * and `j` alone for what came, along a longest run of what both hold in order.
 */
function steps(a, b) {
  const [head, aEnd, bEnd] = shared(a, b, Object.is);
  const found = Array.from({ length: head }, (_, place) => [place, place]);
  let [i, j] = [head, head];
  const width = bEnd - head + 1;
  if ((aEnd - head) * (bEnd - head) <= MOST_COMPARISONS) {
    // The longest run both share, counted from each pair of places to the end.
    const common = new Uint32Array((aEnd - head + 1) * width);
    const cell = (row, column) => (row - head) * width + column - head;
    for (let row = aEnd - 1; row >= head; row--) {
      for (let column = bEnd - 1; column >= head; column--) {
        common[cell(row, column)] = a[row] === b[column] ? common[cell(row + 1, column + 1)] + 1
          : Math.max(common[cell(row + 1, column)], common[cell(row, column + 1)]);
      }
    }
    while (i < aEnd && j < bEnd) {
      if (a[i] === b[j]) found.push([i++, j++]);
      else if (common[cell(i + 1, j)] >= common[cell(i, j + 1)]) found.push([i++, undefined]);
      else found.push([undefined, j++]);
    }
  }
  while (i < aEnd) found.push([i++, undefined]);
  while (j < bEnd) found.push([undefined, j++]);
  while (i < a.length) found.push([i++, j++]);
  return found;
}

// What stands in a paragraph's line for a run that is no text, and what each such run is called,
// by the name that says what it is.
const OBJECT = '￼';
const KINDS = { object: 'an image', footnote: 'a footnote mark', chip: 'a chip', equation: 'an equation', rule: 'a line', break: 'a break', field: 'a page number' };
const LIST = new Intl.ListFormat('en');
const nameOf = run => run.break ? `a ${run.break} break` : KINDS[Object.keys(KINDS).find(name => name in run)];
// The mark of `named`, which came or went where a view shows no more of it than this.
const tick = (came, named) => ({ tick: came ? 'came' : 'gone', note: `${came ? 'Added' : 'Removed'} here: ${named}` });
// What tells one run that is no text from another, in whatever order it holds it.
const kindOf = run => JSON.stringify([...Object.keys(KINDS), 'link'].map(name => run[name]));
const WORDS = /\s+|[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*|￼|[^\s\p{L}\p{N}_￼]+/gu;

/** A paragraph's runs as one line of text, where each run is in it, and its words. */
function lineOf(runs) {
  let line = '';
  const spans = runs.map(run => ({ run, from: line.length, to: (line += run.text ?? OBJECT).length }));
  const runAt = at => spans.find(({ from, to }) => from <= at && at < to).run;
  const words = [...line.matchAll(WORDS)].map(({ 0: text, index: at }) => {
    const run = runAt(at);
    // A word is its letters and where it leads, and a run that is no text is all it holds.
    return { text, at, key: run.text === undefined ? kindOf(run) : `${text}\u0000${run.link ?? ''}` };
  });
  return { spans, runAt, words };
}

/**
 * The words of a saved paragraph and of the one pending in its place, in order, each cut where a
 * run of either starts: as `was`, the saved run it is of, and `now`, the pending one, where it
 * has both.
 */
function piecesOf(was, now) {
  return steps(was.words.map(word => word.key), now.words.map(word => word.key)).flatMap(([i, j]) => {
    const { text } = was.words[i] ?? now.words[j];
    const starts = [was.words[i]?.at, now.words[j]?.at];
    const cuts = [was, now].flatMap(({ spans }, side) => starts[side] === undefined ? []
      : spans.flatMap(({ from, to }) => [from - starts[side], to - starts[side]]).filter(cut => cut > 0 && cut < text.length));
    const ends = [...new Set([...cuts, text.length])].toSorted((one, other) => one - other);
    return ends.flatMap((end, part) => {
      const from = ends[part - 1] ?? 0;
      const piece = { text: text.slice(from, end) };
      const [saved, pending] = [was, now].map(({ runAt }, side) => starts[side] === undefined ? undefined : runAt(starts[side] + from));
      // A link that changed inside a word that did not is the word gone, and come with the new one.
      return saved && pending && saved.link !== pending.link ? [{ ...piece, was: saved }, { ...piece, now: pending }]
        : [{ ...piece, was: saved, now: pending }];
    });
  });
}

export const excerpt = text => text.length > 120 ? `${text.slice(0, 119)}…` : text;

/**
 * The runs of a paragraph whose words changed, as a view shows them. What the view leaves out,
 * `hidden`, is a mark where it is left out: `{ tick, note }`.
 */
function runsOf(pieces, hidden) {
  const runs = [];
  let left = [];
  const leave = () => {
    const text = left.map(run => run.text ?? '').join('').trim();
    // Its words, and what is no text among it by what that is.
    const named = [...text ? [`“${excerpt(text)}”`] : [], ...new Set(left.flatMap(run => nameOf(run) ?? []))];
    if (named.length) runs.push(tick(hidden === 'added', LIST.format(named)));
    left = [];
  };
  for (const { mark, saved, pending } of pieces) {
    if (mark && mark === hidden) {
      left.push(saved ?? pending);
      continue;
    }
    leave();
    const run = hidden === 'added' ? saved : pending ?? saved;
    // On its pages, a break that comes or goes shows only as where a page ends: it is marked there.
    if (mark && hidden && run.break) runs.push(tick(mark === 'added', nameOf(run)));
    runs.push({ ...run, change: mark });
  }
  leave();
  return runs;
}

/** What a view that leaves out `hidden`, what is 'added' or 'removed' or neither, draws for `row`: a block, or nothing. */
export function blockOf({ saved, pending, mark, pieces, grid }, hidden) {
  if (mark && mark === hidden) return;
  if (pieces) return { ...hidden === 'added' ? saved : pending, runs: runsOf(pieces, hidden), mark };
  if (grid) return { ...grid(hidden), mark };
  // Read beside what takes its place, an item that goes shows the number it would take and takes none.
  return mark === 'removed' && !hidden && saved.list ? { ...saved, list: { ...saved.list, uncounted: true }, mark } : { ...pending ?? saved, mark };
}

// ---------------------------------------------------------------------------------------------

const EMPTY = { padding: [0, 0, 0, 0], borders: {}, blocks: [] };
const cellAt = (row, column) => row?.cells.find(cell => cell.column === column);
const cellText = cell => cell ? cell.blocks.map(said).join('\n') : '';
const wordsOf = once(block => heard(said(block).match(/[\p{L}\p{N}_]+/gu) ?? []));
const wordsIn = once(row => heard(row.cells.flatMap(cell => cell.blocks.flatMap(block => wordsOf(block).words))));
const textIn = once(row => row.cells.map(cellText).join('\t'));
const places = table => table.columns.map((_, column) => column);
// How a cell and a row are set, apart from what they hold: all that a pending table states of
// either, which is not whether a row is kept whole on a page. A pending cell is drawn apart from
// its page, so it names a fill of the color `page` that a saved cell leaves out.
const cellLook = ({ rowSpan, columnSpan, background, verticalAlign, padding, borders }, page) =>
  JSON.stringify([rowSpan, columnSpan, background === page ? undefined : background, verticalAlign, padding,
    ['top', 'right', 'bottom', 'left'].map(side => borders[side])]);
const rowLook = ({ minHeight, header }) => `${minHeight} ${header}`;
// The cells of `table` that a merged cell reaches: it lists one only where it still holds text.
function coveredIn(table) {
  const reached = new Set();
  return table.rows.flatMap((row, at) => row.cells.filter(cell => {
    if (reached.has(`${at} ${cell.column}`)) return true;
    for (let down = 0; down < (cell.rowSpan ?? 1); down++) {
      for (let over = 0; over < (cell.columnSpan ?? 1); over++) reached.add(`${at + down} ${cell.column + over}`);
    }
    return false;
  }));
}
// The pair of `list` nearest `at` that has something saved: the last up to it, or else the first after.
const nearest = (list, at) => list.slice(0, at + 1).findLast(pair => pair[0] !== undefined) ?? list.slice(at).find(pair => pair[0] !== undefined);
// `block`, of an edit, with every run in it said to be `unsaved`: Google Docs does not have it yet,
// so wherever it is drawn, it leads nowhere.
const unsaved = block => block.type === 'paragraph' ? { ...block, runs: block.runs.map(run => ({ ...run, unsaved: true })) }
  : block.type !== 'table' ? block
  : { ...block, rows: block.rows.map(row => ({ ...row, cells: row.cells.map(cell => ({ ...cell, blocks: cell.blocks.map(unsaved) })) })) };
// A paragraph is one still where it keeps half its words, and anything else where it is of the same kind.
const alike = (saved, block) => saved.type === block.type && (saved.type !== 'paragraph' || akin(wordsOf(saved), wordsOf(block)));
// Two blocks are the same where they are of one kind and say one thing, however each is set.
const textOf = once(said);
const matching = (saved, block) => saved.type === block.type && textOf(saved) === textOf(block);

/**
 * What `pending`, a tab's GoogleDocPendingDrawing, makes of `drawing`, its GoogleDocDrawing: the
 * tab's blocks in order as `rows`, and as `lists` the levels of each list the changes make or
 * change.
 *
 * A row is `{ saved }` for a block left as it is, with `mark: 'removed'` for one that goes,
 * `{ pending, mark: 'added' }` for one that comes, and `{ saved, pending, mark: 'changed' }` for a
 * paragraph or a table that is edited; `does` is what its change does, for the color it is told
 * in. blockOf() gives the block a view draws for a row, as draw.js takes one: a block of the
 * drawing, or one like it that holds its looks themselves in place of their places.
 */
export function merge(drawing, pending) {
  const { textLooks, paragraphLooks } = drawing;
  // Each list the changes make or change: what is told of each of its levels, over the saved
  // level where that is of its kind, and else over the level Google Docs makes of that kind.
  const lists = Object.fromEntries(Object.entries(pending.lists).map(([id, levels]) => [id, levels.map((level, depth) => {
    const saved = drawing.lists[id]?.[depth];
    return { ...saved && !saved.numbering === !level.numbering ? saved : newList(!!level.numbering)[depth], ...level };
  })]));
  const namedOf = style => {
    const found = drawing.named[style];
    return found ? { paragraph: paragraphLooks[found.paragraph], text: textLooks[found.text] } : PLAIN[style] ?? PLAIN.NORMAL_TEXT;
  };

  // The saved paragraphs passed so far, the last of which one that comes is written into.
  const seen = [];
  const pass = block => {
    if (block.type === 'paragraph') seen.push(block);
    return block;
  };
  // Runs `read` with the paragraphs of `blocks` passed, and none of them after it.
  const within = (blocks, read) => {
    const before = seen.length;
    blocks.forEach(pass);
    try {
      return read();
    } finally {
      seen.length = before;
    }
  };

  /**
   * `block`, a paragraph of an edit, set in full: as `saved`, the paragraph it stands for, where
   * that is of its named style, or else as the last paragraph of that style before it.
   */
  function setting(block, saved) {
    const named = namedOf(block.style);
    const own = saved?.style === block.style ? saved : undefined;
    const base = own ?? seen.findLast(found => found.style === block.style);
    const end = base && textLooks[base.end];
    const text = (look, beside = end) => textLook(pending.textLooks[look], named.text, beside);
    const look = paragraphLook(pending.paragraphLooks[block.look], named.paragraph, base && paragraphLooks[base.look],
      block.list && (lists[block.list.id] ?? drawing.lists[block.list.id])?.[block.list.level]);
    return {
      own,
      text,
      paragraph: {
        ...block,
        headingId: block.headingId ?? saved?.headingId,
        look: own && sameSetting(paragraphLooks[own.look], look) ? paragraphLooks[own.look] : look,
        end: text(block.end),
        list: block.list && { ...block.list, look: text(block.list.look, base?.list ? textLooks[base.list.look] : end) },
        runs: block.runs.map(run => ({ ...run, look: text(run.look) })),
      },
    };
  }

  /** A block of an edit that stands for no saved one, as it is drawn: nothing for one of which only the place is told. */
  function added(block) {
    if (block.type === 'paragraph') return setting(block).paragraph;
    if (block.type !== 'table') return;
    return { ...block, rows: block.rows.map(row => ({ ...row, cells: row.cells.map(cell => ({ ...cell, blocks: cell.blocks.flatMap(inner => added(inner) ?? []) })) })) };
  }

  /** The row of `saved`, a paragraph, and `block`, the one an edit puts in its place. */
  function edited(saved, block) {
    const { own, text, paragraph } = setting(block, saved);
    const pieces = piecesOf(lineOf(saved.runs), lineOf(block.runs));
    // Google Docs draws text written into a paragraph as the text before it, or at its start as
    // the text after it, and what the edit removes is gone by then.
    const kept = pieces.find(piece => piece.was && piece.now) ?? pieces.find(piece => piece.was);
    let near = own && textLooks[kept?.was.look ?? own.end];
    for (const piece of pieces) {
      const { was, now } = piece;
      const look = was && textLooks[was.look];
      if (look && now && own) near = look;
      piece.mark = !now ? 'removed' : !was ? 'added' : undefined;
      if (was) piece.saved = { ...was, ...was.text !== undefined && { text: piece.text }, look };
      if (!now) continue;
      const drawn = text(now.look, near);
      // A word both have is the saved one, which alone leads where it says.
      piece.pending = { ...was ?? now, ...now.text !== undefined && { text: piece.text }, look: look && own && sameText(look, drawn) ? look : drawn };
    }
    const marks = new Set(pieces.flatMap(piece => piece.mark ?? []));
    const same = own && !marks.size && paragraph.look === paragraphLooks[saved.look] && pieces.every(piece => piece.pending.look === piece.saved.look) &&
      saved.list?.id === block.list?.id && saved.list?.level === block.list?.level;
    return same ? { saved } : { saved, pending: paragraph, mark: 'changed', pieces, does: marks.size === 1 ? [...marks][0] : 'changed' };
  }

  /**
   * The row of `saved`, a table, and `block`, the one an edit puts in its place: its rows lined
   * up by the words in them, and its columns, where one came or went, by what their cells say
   * down the rows both have. Each view is one table: a cell left alone as it was, a cell edited
   * with its blocks lined up in turn, and, where every change is read in place, the rows and
   * columns that go among those that come. A cell is laid out as the pending table has it, so
   * one that takes in others is edited and those it covers are not drawn. A covered cell that
   * still holds text is no cell of its table: where the other table shows it, its text comes
   * into view or goes out of it, and is marked as that.
   */
  function tabled(saved, block) {
    const tables = [saved, block];
    const page = drawing.page.background ?? '#ffffff';
    const covered = new Set(tables.flatMap(coveredIn));
    const shown = (row, column) => row?.cells.find(cell => cell.column === column && !covered.has(cell));
    const rows = lineUp(saved.rows, block.rows, (was, now) => akin(wordsIn(was), wordsIn(now)), (was, now) => textIn(was) === textIn(now));
    const both = rows.filter(([was, now]) => was && now);
    const down = (column, side) => both.map(pair => cellText(cellAt(pair[side], column)));
    const steady = saved.columns.length === block.columns.length;
    const columns = steady ? places(saved).map(column => [column, column])
      : lineUp(places(saved), places(block), (was, now) => {
        const [gone, come] = [down(was, 0), down(now, 1)];
        const texts = gone.map((text, row) => [text, come[row]]).filter(([a, b]) => a || b);
        return texts.filter(([a, b]) => a === b).length * 2 >= texts.length;
      }, (was, now) => down(was, 0).join('\t') === down(now, 1).join('\t'));

    // What each pair of cells holds, lined up once for every view.
    const inner = new Map();
    // The saved cell nearest one that came with its row or its column, whose text it is set as.
    const beside = (row, column) => cellAt(nearest(rows, row)?.[0], nearest(columns, column)?.[0]);
    const linedCell = (was, now, row, column) => inner.get(now ?? was) ?? inner.set(now ?? was,
      within(was ? [] : beside(row, column)?.blocks ?? [], () => lined(was?.blocks ?? [], now?.blocks ?? []))).get(now ?? was);

    function grid(hidden) {
      // Whose cells are drawn: the first is the one a cell both have is laid out as.
      const sides = hidden === 'added' ? [0] : hidden === 'removed' ? [1] : [1, 0];
      const first = pair => sides.find(side => pair[side] !== undefined);
      const [across, along] = [columns, rows].map(list => list.filter(pair => first(pair) !== undefined));
      const taken = new Set();
      // What the view leaves out, rows or columns: what to say of it, by how many are drawn before it.
      const out = hidden === 'removed' ? 0 : 1;
      const left = (list, kind, text) => {
        const found = new Map();
        let drawn = 0;
        for (const pair of list) {
          if (first(pair) === undefined) found.set(drawn, [...found.get(drawn) ?? [], text(pair[out]).replace(/\s+/g, ' ').trim()]);
          else drawn++;
        }
        return new Map([...found].map(([at, [told, ...more]]) => {
          const named = told ? `${kind} “${excerpt(told)}”` : `an empty ${kind}`;
          return [at, more.length ? `${more.length + 1} ${kind}s ${hidden} here, from ${named}` : `${out ? 'Added' : 'Removed'} here: ${named}`];
        }));
      };
      const gaps = left(rows, 'row', row => row.cells.map(cellText).join(' '));
      const breaks = left(columns, 'column', column => tables[out].rows.map(row => cellText(cellAt(row, column))).join(' '));
      return {
        type: 'table',
        columns: across.map(pair => tables[first(pair)].columns[pair[first(pair)]]),
        rows: along.map((pair, row) => ({
          ...pair[first(pair)],
          // A pending row never says it is kept whole on a page: the saved row it is paired with does.
          unbroken: pair[0]?.unbroken,
          cells: across.flatMap((column, at) => {
            // One a merged cell reaches is not drawn, even where it still holds text.
            if (taken.has(`${row} ${at}`)) return [];
            const [was, now] = [0, 1].map(side => shown(pair[side], column[side]));
            const side = sides.find(found => [was, now][found]);
            // Covered by a cell of the other table, or in a row and a column that never met.
            if (side === undefined) return [{ ...EMPTY, column: at }];
            const cell = [was, now][side];
            // How far the cell reaches among the rows and columns drawn.
            const reach = (list, from, to) => Math.max(1, list.findIndex(found => found[side] === to) - from + 1);
            const rowSpan = reach(along, row, tables[side].rows[tables[side].rows.indexOf(pair[side]) + (cell.rowSpan ?? 1) - 1]);
            const columnSpan = reach(across, at, cell.column + (cell.columnSpan ?? 1) - 1);
            for (let below = 0; below < rowSpan; below++) for (let over = 0; over < columnSpan; over++) taken.add(`${row + below} ${at + over}`);
            const blocks = linedCell(was, now, rows.indexOf(pair), columns.indexOf(column));
            // One that came or went with its row or column is that, and one cells were merged into or split from is edited:
            // as is one set another way, in itself, in its row, or in the width of its column where none came or went.
            const alone = !pair[1 - side] || column[1 - side] === undefined;
            const reset = was && now && (cellLook(was, page) !== cellLook(now, page) || rowLook(pair[0]) !== rowLook(pair[1]) ||
              (steady && saved.columns[column[0]] !== block.columns[column[1]]));
            const mark = was && now ? (reset || blocks.some(found => found.mark)) && 'changed'
              : alone ? ['removed', 'added'][side] : 'changed';
            return [{
              ...cell,
              column: at,
              rowSpan: rowSpan > 1 ? rowSpan : undefined,
              columnSpan: columnSpan > 1 ? columnSpan : undefined,
              mark: mark || undefined,
              // A seam on each edge of it where rows or columns are left out.
              seams: Object.entries({
                above: gaps.get(row),
                below: row + rowSpan === along.length && gaps.get(along.length),
                before: breaks.get(at),
                after: at + columnSpan === across.length && breaks.get(across.length),
              }).flatMap(([edge, note]) => note ? { tick: `${out ? 'came' : 'gone'} seam ${edge}`, note } : []),
              // The cell says what a block of one that came or went with its row or column is.
              blocks: blocks.flatMap(found => alone ? { ...found.pending ?? found.saved } : blockOf(found, hidden) ?? []),
            }];
          }),
        })),
      };
    }
    const changed = grid().rows.some(row => row.cells.some(cell => cell.mark));
    return changed ? { saved, pending: block, mark: 'changed', grid, does: 'changed' } : { saved };
  }

  /** The rows `now`, the blocks of an edit or of a cell, make of `was`, the saved blocks they stand in place of. */
  function lined(was, now) {
    return lineUp(was, now, alike, matching).flatMap(([saved, block]) => {
      if (saved) pass(saved);
      if (!block) return { saved, mark: 'removed', does: 'removed' };
      if (saved) return saved.type === 'paragraph' ? edited(saved, block) : saved.type === 'table' ? tabled(saved, block) : { saved };
      const made = added(block);
      return made ? { pending: made, mark: 'added', does: 'added' } : [];
    });
  }

  // A tab that is itself pending has no saved body: its one edit, at 0, is all it holds, and its
  // drawing is of the page it will be set on.
  const blocks = pending.edits.some(edit => edit.end === 0) ? [] : drawing.blocks;
  let at = 0;
  const upTo = index => {
    const from = at;
    while (at < blocks.length && blocks[at].range.start < index) at++;
    return blocks.slice(from, at);
  };
  const kept = index => upTo(index).map(saved => ({ saved: pass(saved) }));
  const rows = pending.edits.flatMap(({ start, end, blocks: now }) => [...kept(start), ...lined(upTo(Math.max(start, end)), now.map(unsaved))]);
  return { rows: [...rows, ...kept(Infinity)], lists };
}
