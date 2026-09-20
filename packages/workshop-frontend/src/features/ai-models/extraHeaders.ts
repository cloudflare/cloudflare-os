/**
 * One row of the extra-headers editor. `id` keeps React keys stable while rows are removed.
 *
 * A null `value` keeps the value the server holds for the header named `storedName`, which the
 * server withholds. The server matches that by name, so such a row can't be renamed.
 */
export type HeaderRow = { id: number; name: string; value: string | null; storedName?: string }

let nextRowId = 0

export const newHeaderRow = (): HeaderRow => ({ id: nextRowId++, name: '', value: '' })

/** Rows for the headers of a stored configuration, whose withheld values are null. */
export const headerRowsFromRecord = (headers: Record<string, string | null> | undefined): HeaderRow[] =>
  Object.entries(headers ?? {}).map(([name, value]) =>
    ({ id: nextRowId++, name, value, ...(value === null && { storedName: name }) }))

/** Whether the row's header has a withheld stored value that the row may keep. */
export const canKeepStoredValue = (row: HeaderRow) =>
  row.storedName !== undefined && row.name.trim() === row.storedName

// An HTTP field-name token (RFC 9110 section 5.1).
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Returns an error message for each invalid row, keyed by row id. Blank rows are ignored. */
export const validateHeaderRows = (rows: readonly HeaderRow[]): Record<number, string> => {
  const errors: Record<number, string> = {}
  const seen = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) {
      if (row.value?.trim()) errors[row.id] = 'Please enter a header name'
      continue
    }
    const key = name.toLowerCase()
    if (!HEADER_NAME.test(name)) {
      errors[row.id] = 'Header names may not contain spaces or special characters like ":"'
    } else if (seen.has(key)) {
      // Header names are case-insensitive, so both rows would collapse into one header.
      errors[row.id] = `Header "${name}" is already specified`
    }
    seen.add(key)
  }
  return errors
}

/** Converts validated rows to the `RedactedAiModelConfig.extraHeaders` shape, or undefined if none. */
export const headerRowsToRecord = (rows: readonly HeaderRow[]): Record<string, string | null> | undefined => {
  const entries = rows
    .filter(row => row.name.trim())
    .map(row => [row.name.trim(), row.value === null ? null : row.value.trim()] as const)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
