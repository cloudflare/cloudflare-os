/** Shared validation for finite positive integer bounds. */

/**
 * Requires a finite positive integer so invalid bounds cannot silently disable their cap.
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
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${value}.`);
  }
  return value;
}
