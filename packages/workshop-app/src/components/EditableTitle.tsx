import { useRef, useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type EditableTitleProps = {
  value: string
  /** A new title was settled on: different, and not blank. */
  onRename: (title: string) => void
  'aria-label': string
  /** Shown while there is no title. */
  placeholder?: string
  /** The heading's own type, which the field takes on. */
  className?: string
}

/**
 * A title that is edited where it is: it reads as plain text, as wide as it is, until pointed at
 * or clicked into, when a rounded surface says it can be changed. Enter or leaving it keeps what
 * was typed, and Escape puts the title back.
 */
export const EditableTitle = ({ value, onRename, 'aria-label': label, placeholder, className }: EditableTitleProps) => {
  // What is being typed, while it is.
  const [draft, setDraft] = useState<string>()
  // Left with Escape, which keeps nothing that was typed.
  const cancelled = useRef(false)
  const settle = () => {
    const next = cancelled.current ? undefined : draft?.trim()
    cancelled.current = false
    setDraft(undefined)
    if (next && next !== value) onRename(next)
  }

  return (
    <input
      aria-label={label}
      value={draft ?? value}
      placeholder={placeholder}
      // Where `field-sizing` is not supported, about as wide as what is in it.
      size={Math.max((draft ?? value).length || (placeholder?.length ?? 0), 1)}
      enterKeyHint="done"
      onFocus={() => setDraft(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={settle}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelled.current = true
          event.currentTarget.blur()
        }
      }}
      className={cn(
        'field-sizing-content max-w-full min-w-0 appearance-none rounded-xl border-0 bg-transparent px-2.5 py-1 outline-none',
        'placeholder:text-kumo-subtle hover:bg-kumo-contrast/5 focus:bg-kumo-contrast/5',
        className,
      )}
    />
  )
}
