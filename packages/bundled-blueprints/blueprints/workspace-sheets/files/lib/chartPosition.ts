import type { Dims, SheetMeta } from "./protocol.ts";

/** Bounds for a chart's top-left in the sheet's existing pixel coordinate system. */
export interface ChartPositionBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// Dimensions have the same integer/size limits as server sanitizeDims. Only canonical keys
// within the sheet affect its rendered extent; retained sizes for deleted rows/columns do not.
function pixelExtent(count: number, dimensions: Dims, defaultSize: number): number {
  let extent = count * defaultSize;
  for (const key in dimensions) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= count || String(index) !== key) continue;
    const size = Math.round(Number(dimensions[key]));
    if (Number.isFinite(size) && size >= 8 && size <= 2000) extent += size - defaultSize;
  }
  return extent;
}

/**
 * Include existing header pixels and resized dimensions; only the chart's top-left must stay
 * over a legal cell. Compute once per structure snapshot or drag, not per pointer movement.
 */
export function chartPositionBounds(sheet: Pick<SheetMeta, "rows" | "cols" | "colWidths" | "rowHeights">): ChartPositionBounds {
  return {
    minX: 48,
    maxX: Math.max(48, 44 + pixelExtent(sheet.cols, sheet.colWidths, 92) - 1),
    minY: 28,
    maxY: Math.max(28, 22 + pixelExtent(sheet.rows, sheet.rowHeights, 24) - 1),
  };
}

/** Round and clamp a coordinate, including a nonfinite input's fallback, to accepted sheet bounds. */
export function clampChartCoordinate(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const rounded = Math.round(Number(value));
  return Math.max(minimum, Math.min(maximum, Number.isFinite(rounded) ? rounded : fallback));
}
