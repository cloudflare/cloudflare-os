// JSON values as they arrive from files, registries and APIs, with the narrowing the proofs need.

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
