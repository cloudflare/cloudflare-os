import { useId, useState } from 'react'
import { Button } from '@cloudflare/kumo'

// Past this many characters or lines, a value may not fit the six lines it is clamped to.
const CLAMP_CHARACTERS = 480
const CLAMP_LINES = 6

const mayOverflow = (value: string) =>
  value.length > CLAMP_CHARACTERS || value.split('\n').length > CLAMP_LINES

// A value recorded as JSON (an object or a list) laid out one field per line. Anything else,
// excerpts and strings among them, is shown as recorded: a string such as "42" parses too.
const layOut = (value: string) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return value
  }
  return typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed, null, 2) : value
}

/**
 * One side of a setting change, verbatim but for JSON, which is laid out one field per line. A
 * value may be thousands of characters, so a long one is clamped to six lines, with a toggle that
 * shows it whole, named after `label` (which side of which change) so that one change's toggles
 * can be told apart. An absent side shows a dash, which
 * a screen reader would read as "em dash", so it is announced as "none". An empty value, which would
 * show nothing, says "empty".
 */
export const AuditValue = ({ value, label }: { value: string | undefined; label: string }) => {
  const [expanded, setExpanded] = useState(false)
  const valueId = useId()
  if (value === undefined) {
    return (
      <span className="min-w-0 font-mono text-xs text-kumo-default">
        <span aria-hidden="true">—</span>
        <span className="sr-only">none</span>
      </span>
    )
  }
  if (value === '') {
    return <span className="min-w-0 text-xs italic text-kumo-subtle">empty</span>
  }
  const shown = layOut(value)
  const long = mayOverflow(shown)
  return (
    <span className="min-w-0">
      <span
        id={valueId}
        className={`block font-mono text-xs text-kumo-default whitespace-pre-wrap break-all${long && !expanded ? ' line-clamp-6' : ''}`}
      >
        {shown}
      </span>
      {long && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-1"
          aria-expanded={expanded}
          aria-controls={valueId}
          aria-label={`${expanded ? 'Show less' : 'Show all'} of ${label}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Show less' : 'Show all'}
        </Button>
      )}
    </span>
  )
}
