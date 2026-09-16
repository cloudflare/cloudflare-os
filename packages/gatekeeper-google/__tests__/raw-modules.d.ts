/**
 * Vite's `?raw` suffix, used by the type-parity test to read a `.d.ts` as a string.
 *
 * Scoped to `__tests__` deliberately: worker code has no business reading its own sources.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
