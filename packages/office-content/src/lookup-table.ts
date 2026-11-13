/**
 * A table looked up by text from a file. It has no prototype, so a key such as "constructor"
 * finds nothing, where a plain object would answer with what every object inherits.
 */
export function lookupTable<Value>(entries: Record<string, Value>): Readonly<Record<string, Value>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, Value>, entries));
}
