// Whether a cut across a page would part the columns of a page set in columns. It reads pixels
// and nothing else, so that whoever is handed a page's bands can ask it of a cut of their own,
// as the renderer asks it of its cuts.

/** How far from the ground a pixel has to be to be writing and not the ground's own grain. */
const WRITING_LEVELS = 64;
/** The narrowest strip of ground taken for the space between two columns, as a share of the page's width. */
const GUTTER_WIDTH = 0.015;
/**
 * How far above a cut, and as far below it, that strip has to run, as a share of the page's
 * height: some three lines of ordinary type each way.
 */
const GUTTER_RUN = 0.05;
/**
 * The share of the page's width at either side in which no such strip is looked for: a margin is
 * not the space between two columns, whatever lies in it.
 */
const GUTTER_MARGIN = 0.2;
/**
 * The least of the page's width that writing beside such a strip is spread over when it is a
 * column: the labels of a chart's axis, line numbers and a punched hole are narrower.
 */
const COLUMN_WIDTH = 0.1;

/**
 * Whether a cut above row `row` of a page, `height` rows of `width` grey bytes in `pixels`, would
 * part its columns. Bands are read one after another, each across the whole of the page's
 * width, so what is right of the space between two columns above a cut would be read before
 * what is left of it below: a page set in columns would come back with its columns in pieces,
 * turn about. The space between two columns is a strip of the page's ground, 1.5% of its width
 * across and nowhere in the fifth of the page at either side, that runs at least 5% of its
 * height above the cut and as far below it. A cut parts columns when such a strip has writing
 * to its right above the cut and to its left below it, in the rows it runs through and no
 * nearer its ends than half that 5%, each over at least a tenth of the page's width: a line
 * across the page ends a strip and lies beside none, and a narrow mark is no column. What stands
 * beside a paragraph a tenth of the page across with such a strip between them, as a stamp may,
 * is a column by this: the page is cut into fewer bands for it, and nothing of it is left out.
 *
 * The ground is the level half of the pixels of `row` are at or under, and writing is a pixel
 * more than a quarter of the range from it, so a rule across the strip ends it as a line of
 * writing does: the columns of a table drawn with rules are not these, and those of one drawn
 * without them are.
 *
 * `pixels` may be some of a page's rows only, a band of it: `pageHeight` is then the height of
 * the page they are of, which is what the 5% is taken of.
 */
export function partsColumns(
  pixels: Uint8Array, width: number, height: number, row: number, pageHeight = height,
): boolean {
  let gutter = Math.max(1, Math.round(width * GUTTER_WIDTH));
  let column = Math.max(1, Math.round(width * COLUMN_WIDTH));
  let run = Math.max(1, Math.round(pageHeight * GUTTER_RUN));
  if (row < run || height - row < run) return false;
  let levels = new Uint32Array(256);
  for (let at = row * width, end = at + width; at < end; at++) levels[pixels[at]!]!++;
  let ground = 0, under = levels[0]!;
  while (under * 2 < width) under += levels[++ground]!;

  // How many rows each column is clear of writing for, up from the cut and down from it.
  let above = new Uint16Array(width), below = new Uint16Array(width);
  let clear = (rows: Uint16Array, first: number, step: number, most: number) => {
    rows.fill(most);
    for (let reached = 0, open = width; reached < most && open > 0; reached++) {
      for (let x = 0, at = (first + reached * step) * width; x < width; x++, at++) {
        if (rows[x] === most && Math.abs(pixels[at]! - ground) > WRITING_LEVELS) {
          rows[x] = reached;
          open--;
        }
      }
    }
  };
  clear(above, row - 1, -1, row);
  clear(below, row, 1, height - row);

  let inside = run >> 1;
  let last = Math.floor(width * (1 - GUTTER_MARGIN)) - gutter;
  for (let left = Math.ceil(width * GUTTER_MARGIN); left <= last; left++) {
    let up = row, down = height - row;
    for (let x = left; x < left + gutter; x++) {
      up = Math.min(up, above[x]!);
      down = Math.min(down, below[x]!);
    }
    if (up < run || down < run) continue;
    let rightAbove = 0, leftBelow = 0;
    for (let x = left + gutter; x < width; x++) if (above[x]! + inside < up) rightAbove++;
    for (let x = 0; x < left; x++) if (below[x]! + inside < down) leftBelow++;
    if (rightAbove >= column && leftBelow >= column) return true;
  }
  return false;
}
