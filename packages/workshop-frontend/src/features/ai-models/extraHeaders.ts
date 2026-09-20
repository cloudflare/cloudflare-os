/** One row of the extra-headers editor. `id` keeps React keys stable while rows are removed. */
export type HeaderRow = { id: number; name: string; value: string }

let nextRowId = 0

export const newHeaderRow = (): HeaderRow => ({ id: nextRowId++, name: '', value: '' })

// An HTTP field-name token (RFC 9110 section 5.1).
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Returns an error message for each invalid row, keyed by row id. Blank rows are ignored. */
export const validateHeaderRows = (rows: readonly HeaderRow[]): Record<number, string> => {
  const errors: Record<number, string> = {}
  const seen = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) {
      if (row.value.trim()) errors[row.id] = 'Please enter a header name'
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

/** Converts validated rows to the `AiModelConfig.extraHeaders` shape, or undefined if none. */
export const headerRowsToRecord = (rows: readonly HeaderRow[]): Record<string, string> | undefined => {
  const entries = rows
    .filter(row => row.name.trim())
    .map(row => [row.name.trim(), row.value.trim()] as const)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
