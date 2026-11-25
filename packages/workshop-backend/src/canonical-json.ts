/**
 * Canonical JSON: object keys sorted at every level and undefined members left out, written out
 * as text, so that two values equal as JSON give the same text whatever order their keys were set
 * in. A value with `toJSON()` (a Date) is written as that gives it, as JSON.stringify() would.
 * Building a sorted copy by assignment instead would turn a "__proto__" key into a prototype
 * change and drop it.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => item === undefined ? "null" : canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    if ("toJSON" in value && typeof value.toJSON === "function") return canonicalJson(value.toJSON());
    let entries: string[] = [];
    for (let [key, item] of Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (item === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
