// The rows and columns of a sheet as the Sheets preview learns their sizes, which of them are in
// view, which it reads to draw them, which of the sheet's frozen lines it keeps in view, and what
// it reads next as the view moves and its lines turn out other sizes. Touches nothing of the page.

/** The most cells one drawing holds, as the session draws it. */
export const MAX_CELLS = 10_000;

// A sheet this small is read whole.
const WHOLE = { rows: 200, columns: 26 };
// The window a drawing of the most cells must have room for beside the frozen lines it comes with.
const SPARE = { rows: 100, columns: 26 };
// The fewest cells a read refused as too large is asked for again with.
const LEAST = 300;
const AXES = ['rows', 'columns'];
// Where a window or a view starts along each axis, and its four sides.
const FIRST = { rows: 'r0', columns: 'c0' };
const SIDES = ['r0', 'r1', 'c0', 'c1'];
// A window is of a line at least, and of no more than the sheet has.
const within = (length, all) => Math.max(1, Math.min(all, length));

/** The lines of an axis: how many, and the size of each a drawing has held. One not held yet is taken to be `size`. */
export const lines = (count, size) => ({ count, size, known: new Map(), starts: undefined });

/** Where each line of `axis` starts, in pixels from the first, and where the last ends. */
export function starts(axis) {
  if (!axis.starts) {
    axis.starts = new Float64Array(axis.count + 1);
    for (let n = 0; n < axis.count; n++) axis.starts[n + 1] = axis.starts[n] + (axis.known.get(n) ?? axis.size);
  }
  return axis.starts;
}

/** The line of `axis` that `offset` pixels from the first falls in. */
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

// How many pixels the first `frozen` lines of `axis` are known to take. A size not read yet is
// taken for none, since a guess must let go of no frozen line.
function known(axis, frozen) {
  let size = 0;
  for (let n = 0; n < frozen; n++) size += axis.known.get(n) ?? 0;
  return size;
}

/**
 * A sheet as the rules below take it: its lines `axes`, of which it freezes `frozen` rows and
 * columns, in a view of `pane` pixels each way past the headers. Its `band` is how many pixels
 * the frozen lines are known to take.
 */
export const laidOut = (axes, frozen, pane) => ({
  axes, frozen, pane,
  count: { rows: axes.rows.count, columns: axes.columns.count },
  band: { rows: known(axes.rows, frozen.rows), columns: known(axes.columns, frozen.columns) },
});

/**
 * The axes whose frozen lines are not kept in view, of a sheet of `count` rows and columns that
 * freezes `frozen` of them, in a view of `pane` pixels each way past the headers. `band` is how
 * many pixels the frozen lines are known to take: more than half the view leaves too little of
 * what scrolls to read by. Those too many for a drawing of `room` cells to hold beside a window
 * go too: the more numerous first, and the others only if they alone are too many. A view with
 * no size yet says nothing.
 */
export function unfrozen({ count, frozen, band, pane }, room = MAX_CELLS) {
  const kept = Object.fromEntries(AXES.map(axis => [axis, pane[axis] > 0 && band[axis] > pane[axis] / 2 ? 0 : frozen[axis]]));
  // The window is as much smaller each way as the drawing is, and no more than the sheet has.
  const spare = axis => Math.max(1, Math.min(count[axis] - kept[axis], Math.ceil(SPARE[axis] * Math.sqrt(room / MAX_CELLS))));
  const over = () => (kept.rows + spare('rows')) * (kept.columns + spare('columns')) > room;
  const [more, fewer] = kept.rows >= kept.columns ? AXES : AXES.toReversed();
  if (over()) kept[more] = 0;
  if (over()) kept[fewer] = 0;
  return AXES.filter(axis => frozen[axis] > kept[axis]);
}

/**
 * The rows and columns in view of `sheet` (laidOut()) scrolled `from` pixels each way, each end
 * exclusive: from the first past the frozen lines kept in view, which lie over what scrolls, to
 * the last that shows, which hidden lines after it are not. `ends` names the axes along which
 * nothing shows after the view: it is scrolled to where the sheet ends.
 */
export function inView(sheet, room, from) {
  const cut = unfrozen(sheet, room);
  const [[r0, r1], [c0, c1]] = AXES.map(axis => {
    const last = lineAt(sheet.axes[axis], from[axis] + sheet.pane[axis] - 1);
    return [Math.min(last, lineAt(sheet.axes[axis], from[axis] + (cut.includes(axis) ? 0 : sheet.band[axis]))), last + 1];
  });
  const ends = AXES.filter(axis => from[axis] + sheet.pane[axis] >= starts(sheet.axes[axis])[sheet.count[axis]]);
  return { r0, r1, c0, c1, ends };
}

/**
 * What to read of `sheet` (as unfrozen() takes it) so that `view` is drawn, in a drawing of at
 * most `room` cells: the window `{ r0, r1, c0, c1 }`, each end exclusive as the view's are, the
 * axes whose frozen lines are `cut`, and those of them the drawing is asked for `without`. The
 * frozen lines before a window come with it, as the session draws it, and count among its
 * cells; those cut would too, were it not asked for without them.
 *
 * The window is the view and lines around it: up to three times its columns and five times its
 * rows, the columns first. Where no drawing holds the view, it is the view's lines the shorter
 * way and all there is room for the longer way, from where the view starts. So is a window read
 * after one that left the view short, along the axes `lacks` names: all the room goes the way
 * it was left short, and across where that is both ways. Where nothing shows after the view
 * (inView()), such a window is read back from where the view ends instead: there a view grows
 * backwards as its lines turn out hidden or small.
 */
export function windowOf(sheet, view, room = MAX_CELLS, lacks = []) {
  const { count, frozen } = sheet;
  const cut = unfrozen(sheet, room);
  const window = at => ({ ...at, cut, without: cut.filter(axis => at[FIRST[axis]] > 0) });
  if (room === MAX_CELLS && count.rows <= WHOLE.rows && count.columns <= WHOLE.columns) {
    return window({ r0: 0, r1: count.rows, c0: 0, c1: count.columns });
  }
  // A view may be asked for past the sheet's end, as around a change at its edge.
  const [tall, wide] = [Math.min(view.r1, count.rows) - view.r0, Math.min(view.c1, count.columns) - view.c0];
  // The frozen lines that come with a window are those before it: at most those before the view.
  const kept = axis => cut.includes(axis) ? 0 : frozen[axis];
  const lead = Object.fromEntries(AXES.map(axis => [axis, Math.min(kept(axis), view[FIRST[axis]])]));
  // How many columns a window of so many rows has room for, and how many rows one of so many columns.
  const columnsBy = rows => Math.floor(room / (lead.rows + rows)) - lead.columns;
  const rowsBy = columns => Math.floor(room / (lead.columns + columns)) - lead.rows;
  // The way all the room goes, if either.
  const long = columnsBy(tall) < wide ? (tall < wide ? 'columns' : 'rows') : lacks.includes('columns') ? 'columns' : lacks[0];
  // Else some goes to columns around the view: a few, in a window made smaller.
  const wish = long ? Infinity : Math.max(wide, room === MAX_CELLS ? Math.min(3 * wide, 160) : wide + 8);
  const across = within(long === 'rows' ? Math.min(wide, columnsBy(1)) : Math.min(wish, columnsBy(tall)), count.columns);
  const down = within(Math.min(long ? Infinity : 5 * tall, rowsBy(across)), count.rows);
  // What a window has to spare goes around the view. One that has none starts where the view
  // does, or ends where it does when nothing shows after it: but for a view among the frozen
  // lines, where a window that starts later would come with more of them.
  const start = (axis, length, seen) => {
    const [from, all] = [view[FIRST[axis]], count[axis]];
    const back = (view.ends?.includes(axis) || from + seen >= all) && from >= kept(axis);
    return Math.max(0, Math.min(!long ? from - Math.floor((length - seen) / 2) : back ? from + seen - length : from, all - length));
  };
  const [r0, c0] = [start('rows', down, tall), start('columns', across, wide)];
  return window({ r0, r1: r0 + down, c0, c1: c0 + across });
}

/**
 * The axes along which `window`, drawn of a sheet of `count` rows and columns with `frozen` of
 * them kept in view, falls short of `view` and a few lines around it, as far as the sheet goes:
 * of the view alone, when `exact`.
 */
export function short(window, view, count, frozen, exact = false) {
  const margin = exact ? 0 : 4;
  const reaches = (from, to, start, end, all, lead) => start <= Math.max(lead, from - margin) && end >= Math.min(all, to + margin);
  return [
    reaches(view.r0, view.r1, window.r0, window.r1, count.rows, frozen.rows) ? [] : 'rows',
    reaches(view.c0, view.c1, window.c0, window.c1, count.columns, frozen.columns) ? [] : 'columns',
  ].flat();
}

/**
 * The most reads made on end of a view its reader has not moved: a view grows as the lines read
 * of it turn out hidden, or smaller than they were taken for, and is not read after without end.
 */
export const READS = 4;

/**
 * What to read next of `sheet` (laidOut()), scrolled `from` pixels each way, where the window
 * `shown` is drawn and reads hold `room` cells: `{ view, lacks, room, chain }`, to ask
 * windowOf() for and to draw as the `chain`th read on end, or `{ short }` where nothing is
 * read: `short` says that what is drawn is not all of the view.
 *
 * Nothing is read while what is drawn holds the view and a few lines around it, with the frozen
 * lines kept in view that are to be. A view left short is read again the way it was, as far as
 * a read holds, until a read brings nothing new or READS were made on end. `moved` says that
 * its reader has moved the view since the last of them was asked for, which starts them over:
 * and the first is asked for with twice the room, where a read refused as too large left less.
 * So does a window drawn of no read on, as a refresh draws, but with the room as it is.
 */
export function readOn(sheet, from, shown, room, moved) {
  const chain = moved ? 0 : shown.chain ?? 0;
  const kept = Object.fromEntries(AXES.map(axis => [axis, shown.cut.includes(axis) ? 0 : sheet.frozen[axis]]));
  const lacking = (view, exact) => short(shown, view, sheet.count, kept, exact);
  // The read of so much room, where what is drawn is not what it would bring.
  const due = cells => {
    const view = inView(sheet, cells, from);
    const left = lacking(view, chain > 0);
    const lacks = chain ? left : [];
    const at = windowOf(sheet, view, cells, lacks);
    const drawn = `${at.cut}` === `${shown.cut}` && (!left.length || SIDES.every(side => at[side] === shown[side]));
    return drawn ? undefined : { view, lacks, room: cells, chain: chain + 1 };
  };
  const read = chain < READS && due(room);
  return (read && moved && due(Math.min(MAX_CELLS, 2 * room))) || read || { short: lacking(inView(sheet, room, from), true).length > 0 };
}

/**
 * The room to ask again with for `view`, whose window of `room` cells was refused as too large:
 * the most, by halves, that asks for another window, and none where the least does not.
 */
export function smaller(sheet, view, room, lacks) {
  const asked = cells => {
    const at = windowOf(sheet, view, cells, lacks);
    return `${[...SIDES.map(side => at[side]), ...at.without]}`;
  };
  for (let less = room >> 1; less >= LEAST; less >>= 1) if (asked(less) !== asked(room)) return less;
}

/**
 * Takes the sizes of the lines `drawing` holds, and gives where the view of `sheet`, scrolled
 * `from` pixels each way, is to be scrolled to for its first lines to stay where they are:
 * those before them may turn out other sizes than they were taken to be.
 */
export function learnt(sheet, room, from, drawing) {
  const view = inView(sheet, room, from);
  const place = axis => starts(sheet.axes[axis])[view[FIRST[axis]]];
  const past = AXES.map(axis => from[axis] - place(axis));
  for (const axis of AXES) learn(sheet.axes[axis], drawing[axis]);
  return Object.fromEntries(AXES.map((axis, n) => [axis, place(axis) + past[n]]));
}
