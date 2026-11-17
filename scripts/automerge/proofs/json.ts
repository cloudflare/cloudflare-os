// JSON values as they arrive from files, registries and APIs, with the narrowing the proofs need.
// The judge scripts take no dependencies (see import-policy.test.ts), so JSONC is parsed here too.

/** Any value `JSON.parse` can return. */
export type Json = null | boolean | number | string | Json[] | JsonObject;

/** A JSON object. */
export interface JsonObject {
  [key: string]: Json;
}

/** Parses JSON text into a `Json` value. */
export function parseJson(text: string): Json {
  const value: Json = JSON.parse(text);
  return value;
}

/** Whether `value` is a JSON object (not an array or null). */
export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` as an object, or an error naming `what`. */
export function asObject(value: Json | undefined, what: string): JsonObject {
  if (!isObject(value)) throw new Error(`${what} is not a JSON object`);
  return value;
}

/** `value` as an array, or an error naming `what`. */
export function asArray(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a JSON array`);
  return value;
}

/** `value` as a string, or an error naming `what`. */
export function asString(value: Json | undefined, what: string): string {
  if (typeof value !== "string") throw new Error(`${what} is not a string`);
  return value;
}

/** `value` as a number, or an error naming `what`. */
export function asNumber(value: Json | undefined, what: string): number {
  if (typeof value !== "number") throw new Error(`${what} is not a number`);
  return value;
}

/** Deep equality of two JSON values; object key order does not matter. */
export function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/**
 * Parses JSONC: JSON plus `//` and `/* *\/` comments and trailing commas, which is what Wrangler
 * accepts in `wrangler.jsonc`. Comment markers inside strings are left alone.
 */
export function parseJsonc(text: string): Json {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated block comment in JSONC");
      i = end + 2;
    } else {
      out += char;
      i++;
    }
  }
  return parseJson(withoutTrailingCommas(out));
}

function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  throw new Error("unterminated string in JSONC");
}

function withoutTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += char;
    i++;
  }
  return out;
}
