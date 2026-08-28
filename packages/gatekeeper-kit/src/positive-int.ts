/** Rejects a bound that would silently disable itself: `NaN` and `Infinity` fail every comparison
 *  they appear in, and a zero or negative cap refuses the first allocation instead of the last. */
export function requirePositiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${value}.`);
  }
  return value;
}
