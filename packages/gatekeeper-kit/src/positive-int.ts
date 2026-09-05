/** Shared validation for finite positive integer bounds. */

/**
 * Requires a finite positive integer so invalid bounds cannot silently disable their cap. Values
 * past `Number.MAX_SAFE_INTEGER` are refused too: comparisons and increments stop being exact
 * there, so such a cap no longer bounds anything.
 * @param label Value name used in errors.
 * @param value Number to validate.
 * @returns The validated number.
 *
 * @example
 * ```ts
 * this.#pageSize = requirePositiveInt("pageSize", options.pageSize ?? 100);
 * ```
 */
export function requirePositiveInt(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer, got ${value}.`);
  }
  return value;
}
