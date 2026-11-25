// JSON read from outside the process: files, GitHub's API, event payloads, registries, opencode's
// event stream. Two families narrow it, and a caller picks by what malformed input must do:
//
// - `parseJson` and the `as*` functions throw, naming what was malformed and quoting none of it:
//   a producer's error becomes an `error` artifact and a line of its job log, both public, and the
//   text may be a server's answer. The gate counts that artifact as absent.
// - `maybeJson`, `maybeObject`, `field` and `list` return `undefined`, `null` or an empty list.
//   The gate and the verdict readers use them, and treat that value as a missing input.

/** Any value `JSON.parse` can return. */
export type Json = null | boolean | number | string | Json[] | JsonObject;

/** A JSON object. */
export interface JsonObject {
  [key: string]: Json;
}

/** Parses JSON text, or throws an error naming `what` when it is not JSON. */
export function parseJson(text: string, what: string): Json {
  const value = maybeJson(text);
  if (value === undefined) throw new Error(`${what} is not JSON`);
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

/** Parses JSON text, or returns `undefined` when it is not JSON. */
export function maybeJson(text: string): Json | undefined {
  try {
    const value: Json = JSON.parse(text);
    return value;
  } catch (error) {
    // Malformed JSON is a named domain case: every caller treats it as a missing input.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** `value` as an object, or `undefined` when it is not one. */
export function maybeObject(value: Json | undefined): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

/** The value under `key`, or `null` when `value` is not an object or has no such key. */
export function field(value: Json, key: string): Json {
  return isObject(value) ? (value[key] ?? null) : null;
}

/** `value` as an array, or an empty one when it is not an array. */
export function list(value: Json): Json[] {
  return Array.isArray(value) ? value : [];
}
