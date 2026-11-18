import { useId, useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { layOut, mayOverflow } from './auditText'

/**
 * One side of a setting change, as it was recorded, but for JSON, which is laid out one field to a
 * line (`layOut`). A value may be thousands of characters, so a long one is cut to six lines, with
 * the way to show it whole, named for which side of which change it is (`label`), so that one
 * change's can be told apart. A side there is none of is a dash, which is said as "none", and an
 * empty one says so, as it would show nothing.
 */
export const AuditValue = ({ value, label }: { value: string | undefined; label: string }) => {
  const [whole, setWhole] = useState(false)
  const id = useId()
  if (value === undefined) {
    return (
      <span className="font-mono text-sm text-kumo-default">
        <span aria-hidden="true">—</span>
        <span className="sr-only">none</span>
      </span>
    )
  }
  if (value === '') return <span className="text-sm text-kumo-subtle italic">empty</span>
  const shown = layOut(value)
  const long = mayOverflow(shown)
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <span id={id} className={cn('block max-w-full font-mono text-sm wrap-anywhere whitespace-pre-wrap text-kumo-default', long && !whole && 'line-clamp-6')}>{shown}</span>
      {long && (
        <button
          type="button"
          aria-expanded={whole}
          aria-controls={id}
          aria-label={`${whole ? 'Show less' : 'Show all'} of ${label}`}
          onClick={() => setWhole((open) => !open)}
          className="cursor-pointer text-sm font-medium text-kumo-subtle hover:text-kumo-default"
        >
          {whole ? 'Show less' : 'Show all'}
        </button>
      )}
    </span>
  )
}
