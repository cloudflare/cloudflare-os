import { useEffect, useRef, useState } from 'react'
import { isImeComposing } from '../keyboardEvent'

// How long after a rename starts the menu that started it may still be closing.
const MENU_CLOSE_GRACE_MS = 500

/**
 * A name as an input while it is renamed in place: it opens focused with the name selected; Enter
 * or leaving it saves, Escape keeps the old name. `onDone` gets the new name, or null when it is
 * unchanged or kept. Clicks and keys stay in it rather than reaching the row or button around it.
 */
export const InlineRename = ({ value, label, onDone, className = '' }: {
  value: string
  /** The input's accessible name, such as "Rename Tip Jar". */
  label: string
  onDone: (title: string | null) => void
  className?: string
}) => {
  const [draft, setDraft] = useState(value)
  // Enter saves and unmounts the field; the blur that can follow must not save again.
  const doneRef = useRef(false)
  // A menu that started the rename hands focus back to its button as it closes, just after the
  // field took it; that blur is the menu's, not the user's.
  const startedRef = useRef(0)
  useEffect(() => { startedRef.current = performance.now() }, [])
  const finish = (save: boolean) => {
    if (doneRef.current) return
    doneRef.current = true
    const title = draft.trim()
    onDone(save && title && title !== value ? title : null)
  }
  return (
    <input
      autoFocus
      value={draft}
      onFocus={event => event.currentTarget.select()}
      onChange={event => setDraft(event.target.value)}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onBlur={event => {
        const field = event.currentTarget
        if (performance.now() - startedRef.current < MENU_CLOSE_GRACE_MS
            && event.relatedTarget?.closest('[aria-haspopup="menu"]')) {
          requestAnimationFrame(() => field.focus())
          return
        }
        finish(true)
      }}
      onKeyDown={event => {
        event.stopPropagation()
        if (isImeComposing(event)) return
        if (event.key === 'Enter') { event.preventDefault(); finish(true) }
        if (event.key === 'Escape') { event.preventDefault(); finish(false) }
      }}
      aria-label={label}
      spellCheck={false}
      className={`min-w-0 rounded-md bg-kumo-base text-kumo-default outline-none ring-1 ring-kumo-ring ${className}`}
    />
  )
}
