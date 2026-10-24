// Chart geometry both sides share: where a new chart goes, and the value axis it draws.

/** A value axis: its ends and the step between its gridlines, each end a whole number of steps. */
export interface ValueAxis {
  min: number;
  max: number;
  step: number;
  /** Every gridline's value, from `min` to `max`. */
  ticks: number[];
}

// At most this many steps between gridlines, as Excel's automatic axis keeps it.
const MAX_STEPS = 8;
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/**
 * The value axis for data from `low` to `high`, picked the way Excel picks its automatic axis:
 * it starts at zero unless the data sits far from it (every value on one side of zero and the
 * spread under a sixth of the largest magnitude), and its step is the smallest of 1, 2, 2.5 or
 * 5 × 10^n that covers the range in at most eight steps, so the gridlines read 0, 500, 1,000
 * rather than 0, 737.5, 1,475.
 */
export function valueAxis(low: number, high: number): ValueAxis {
  let min = Math.min(low, high), max = Math.max(low, high);
  if (!Number.isFinite(min) || !Number.isFinite(max)) min = max = 0;
  // Values apart only by rounding (0.3 and 0.1 + 0.2) are one value: a step that small can't be counted in.
  if (max - min <= Math.max(Math.abs(min), Math.abs(max)) * 1e-9) min = max;
  if (min >= 0 && max - min >= max / 6) min = 0;
  else if (max <= 0 && max - min >= -min / 6) max = 0;
  if (min === max) {
    if (min > 0) min = 0;
    else if (max < 0) max = 0;
    else max = 1;
  }
  const rough = (max - min) / MAX_STEPS;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = NICE_STEPS.find((nice) => nice * magnitude >= rough * (1 - 1e-9))! * magnitude;
  // Rounded to the step's own precision, so 0.1 + 0.2 reads 0.3.
  const digits = Math.max(0, 1 - Math.floor(Math.log10(step)));
  const round = (value: number) => Number(value.toFixed(Math.min(20, digits))) || 0;
  const first = Math.floor(min / step + 1e-9), last = Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let n = first; n <= last && ticks.length <= MAX_STEPS + 2; n++) ticks.push(round(n * step));
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

/** A rectangle of cells, zero-based and inclusive. */
interface CellArea { r1: number; c1: number; r2: number; c2: number }
/** Where a sheet's columns and rows begin, in the chart layer's pixels. */
export interface SheetGeometry {
  /** The left edge of column `c`; `colLeft(cols)` is the right edge of the last column. */
  colLeft(c: number): number;
  /** The top edge of row `r`. */
  rowTop(r: number): number;
  cols: number;
  /** Whether column `c` holds a value in the chart's rows, so the chart must not cover it. */
  occupied?: (c: number) => boolean;
}

/** The bounds of a chart's position on the sheet, in pixels: it can't cover the row or column headers. */
export const CHART_BOUNDS = { minX: 48, minY: 28, max: 5000 } as const;
/** The most charts one sheet holds. */
export const MAX_CHARTS = 50;

// The gap between a new chart and its data.
const CHART_GAP = 24;
// How many filled columns beside the data a new chart steps past before it goes under the data.
const MAX_SKIPPED_COLUMNS = 26;
/** How many of the chart's rows `occupied` needs to look at. */
export const PLACEMENT_ROWS = 200;

/**
 * Where a new `width`-wide chart of `area` goes, as Excel and Google Sheets place one: beside the
 * data, past any filled columns next to it, level with its top row; or under it, level with its
 * first column, when the sheet's columns leave no room to the right.
 */
export function chartPlacement(area: CellArea, sheet: SheetGeometry, width: number): { x: number; y: number } {
  let c = area.c2 + 1;
  while (c < sheet.cols && c - area.c2 <= MAX_SKIPPED_COLUMNS && sheet.occupied?.(c)) c++;
  const right = sheet.colLeft(c) + CHART_GAP;
  if (c - area.c2 <= MAX_SKIPPED_COLUMNS && right + width <= sheet.colLeft(sheet.cols)) return { x: right, y: sheet.rowTop(area.r1) };
  return { x: sheet.colLeft(area.c1), y: sheet.rowTop(area.r2 + 1) + CHART_GAP };
}
