import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type EditableTitleProps = {
  value: string
  /** A new title was settled on: different, and not blank. */
  onRename: (title: string) => void
  'aria-label': string
  /** Shown while there is no title. */
  placeholder?: string
  /** It may run to several lines, as what is said of something does: it wraps, and is as tall as it takes. */
  multiline?: boolean
  /** The heading's own type, which the field takes on. */
  className?: string
  /**
   * Being edited from the start, with what it says chosen, as when it is renamed from a menu.
   * Only on one: focus goes to it when it is shown.
   */
  autoFocus?: boolean
  /** It was left, whether or not anything was kept: for whoever shows it only while it is edited. */
  onEnd?: () => void
}

/**
 * A title that is edited where it is: it reads as plain text, as wide as it is, until pointed at
 * or clicked into, when a rounded surface says it can be changed. Enter or leaving it keeps what
 * was typed, and Escape puts the title back. What is said under a title is edited the same way
 * (`multiline`).
 */
export const EditableTitle = ({ value, onRename, 'aria-label': label, placeholder, multiline = false, className, autoFocus, onEnd }: EditableTitleProps) => {
  // What is being typed, while it is.
  const [draft, setDraft] = useState<string>()
  // Left with Escape, which keeps nothing that was typed.
  const cancelled = useRef(false)
  const settle = () => {
    const next = cancelled.current ? undefined : draft?.trim()
    cancelled.current = false
    setDraft(undefined)
    if (next && next !== value) onRename(next)
    onEnd?.()
  }

  const shared = {
    'aria-label': label,
    value: draft ?? value,
    placeholder,
    enterKeyHint: 'done',
    autoFocus,
    onFocus: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(value)
      if (autoFocus) event.currentTarget.select()
    },
    onBlur: settle,
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Enter') event.currentTarget.blur()
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelled.current = true
        event.currentTarget.blur()
      }
    },
  } as const
  const shape = cn(
    'field-sizing-content max-w-full min-w-0 appearance-none rounded-xl border-0 bg-transparent px-2.5 py-1 outline-none',
    'placeholder:text-kumo-subtle hover:bg-kumo-contrast/5 focus:bg-kumo-contrast/5',
    className,
  )

  if (multiline) {
    return (
      <textarea
        {...shared}
        // Where `field-sizing` is not supported, all the width there is and about as many lines as it takes.
        rows={Math.max(Math.ceil((draft ?? value).length / 70), 1)}
        onChange={(event) => setDraft(event.target.value)}
        className={cn(shape, 'resize-none supports-[not(field-sizing:content)]:w-full')}
      />
    )
  }
  return (
    <input
      {...shared}
      // Where `field-sizing` is not supported, about as wide as what is in it.
      size={Math.max((draft ?? value).length || (placeholder?.length ?? 0), 1)}
      onChange={(event) => setDraft(event.target.value)}
      className={shape}
    />
  )
}
