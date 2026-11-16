/**
 * The size of a value's JSON, for a limit stated in the length of that text: counted by walking
 * the value, so that a value measured against a limit is never held a second time as a string.
 */

/**
 * The length, in UTF-16 units, of the text `JSON.stringify(value)` returns, counted without
 * building it: for the values a queued change, a read's result and a provider's parsed answer
 * are made of. Null, booleans, numbers (a non-finite one counts as `null`), strings with their
 * escapes (a quote, a backslash, a control character, a lone surrogate), arrays (a hole,
 * `undefined`, a function or a symbol counts as `null`) and objects by their own enumerable
 * string keys (a property holding `undefined`, a function or a symbol is left out). As
 * `JSON.stringify` does, it first calls the `toJSON` method of an object that has one, once, and
 * counts what that returns by these same rules in the place the object stood (so `undefined`
 * returned inside an array counts as `null`, and inside an object drops the property), and it
 * counts a boxed number, string or boolean as its primitive. Throws `TypeError` for a value
 * `JSON.stringify` gives no text for or refuses (`undefined` itself, a bigint). A value that
 * holds itself is not detected: none measured here can.
 */
export function jsonLength(value: unknown): number {
  let length = lengthOf(value);
  if (length === undefined) throw new TypeError("The value has no JSON text to measure.");
  return length;
}

/** A character `JSON.stringify` may write as more than itself: an escape, or a surrogate. */
// oxlint-disable-next-line no-control-regex -- JSON escapes every control character below U+0020
const ESCAPED = /["\\\u0000-\u001f\ud800-\udfff]/;

/**
 * The length of `value`'s JSON wherever it stands (the top, an array's element, a property's
 * value), or `undefined` for a value with no text of its own: its holder decides what that costs.
 */
function lengthOf(value: unknown): number | undefined {
  // `JSON.stringify` passes `toJSON` the key the value stands under. It gets none here: no value
  // measured has a `toJSON` that reads it, and a `Date`'s does not.
  if (value !== null && (typeof value === "object" || typeof value === "function") &&
    typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON(): unknown }).toJSON();
  }
  value = unboxed(value);
  switch (typeof value) {
    case "string": return stringLength(value);
    case "number": return Number.isFinite(value) ? String(value).length : 4;
    case "boolean": return value ? 4 : 5;
    case "bigint": throw new TypeError("A BigInt has no JSON text to measure.");
    case "object": break;
    // `undefined`, a function or a symbol.
    default: return undefined;
  }
  if (value === null) return 4;
  if (Array.isArray(value)) {
    // The brackets, and a comma between elements.
    let length = 2 + Math.max(0, value.length - 1);
    for (let at = 0; at < value.length; at++) length += lengthOf(value[at]) ?? 4;
    return length;
  }
  // The braces; then each property written is its key, a colon and its value, after a comma
  // unless it is the first.
  let length = 2;
  let written = 0;
  for (let key of Object.keys(value)) {
    let part = lengthOf((value as Record<string, unknown>)[key]);
    if (part === undefined) continue;
    length += stringLength(key) + 1 + part + (written++ > 0 ? 1 : 0);
  }
  return length;
}

/**
 * The primitive a boxed number, string, boolean or bigint holds, or `value` itself. A boxed one
 * says "object" to `typeof`, and would be counted by its keys.
 */
function unboxed(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  switch (Object.prototype.toString.call(value)) {
    case "[object Number]": return Number(value);
    case "[object String]": return String(value);
    case "[object Boolean]": return Boolean.prototype.valueOf.call(value);
    case "[object BigInt]": return BigInt.prototype.valueOf.call(value);
    default: return value;
  }
}

/** The length of `text` as a JSON string: its quotes, its units and what its escapes add. */
function stringLength(text: string): number {
  let length = text.length + 2;
  if (!ESCAPED.test(text)) return length;
  for (let at = 0; at < text.length; at++) {
    let unit = text.charCodeAt(at);
    if (unit === 0x22 || unit === 0x5c) {
      length++;
    } else if (unit < 0x20) {
      // `\b`, `\t`, `\n`, `\f` and `\r` are two units; any other control character is `\u` and
      // four digits.
      length += unit >= 0x08 && unit <= 0x0d && unit !== 0x0b ? 1 : 5;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      // A high surrogate and the low one after it are written as they are; alone, it is `\u` and
      // four digits, as a low one with no high one before it is.
      let next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) at++;
      else length += 5;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      length += 5;
    }
  }
  return length;
}
