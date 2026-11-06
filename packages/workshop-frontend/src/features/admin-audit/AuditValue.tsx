import { useId, useState } from 'react'
import { Button } from '@cloudflare/kumo'

// Past this many characters or lines, a value may not fit the three lines it is clamped to.
const CLAMP_CHARACTERS = 160
const CLAMP_LINES = 3

const mayOverflow = (value: string) =>
  value.length > CLAMP_CHARACTERS || value.split('\n').length > CLAMP_LINES

/**
 * One side of a setting change, verbatim. A value may be thousands of characters, so a long one is
 * clamped to three lines, with a toggle that shows it whole, named after `label` (which side of
 * which change) so that one change's toggles can be told apart. An absent side shows a dash, which
 * a screen reader would read as "em dash", so it is announced as "none".
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
  const long = mayOverflow(value)
  return (
    <span className="min-w-0">
      <span
        id={valueId}
        className={`block font-mono text-xs text-kumo-default whitespace-pre-wrap break-all${long && !expanded ? ' line-clamp-3' : ''}`}
      >
        {value}
      </span>
      {long && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-1"
          aria-expanded={expanded}
          aria-controls={valueId}
          aria-label={`${expanded ? 'Show less' : 'Show all'} of ${label}`}
          onClick={() => setExpanded((shown) => !shown)}
        >
          {expanded ? 'Show less' : 'Show all'}
        </Button>
      )}
    </span>
  )
}
