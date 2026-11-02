// Narrowing for JSON read from outside the process: GitHub's API, the event payload, opencode's
// event stream. A missing or mistyped field reads as null, which callers treat as absent.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function parseJson(text: string): Json {
  const value: Json = JSON.parse(text);
  return value;
}

export function field(value: Json, key: string): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value[key] ?? null) : null;
}

export function list(value: Json): Json[] {
  return Array.isArray(value) ? value : [];
}
