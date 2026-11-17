import { useRef, useState, type KeyboardEvent } from 'react'

/**
 * How keeping a new value went: it is kept; or it was not, with why, or with nothing said where
 * it was not tried, as while the connection is down.
 */
export type SaveOutcome = { saved: true } | { saved: false; problem?: string }

type EditedField = {
  /** The value as it is kept. */
  value: string
  /** A new value was settled on, different from the one kept. */
  onSave: (value: string) => Promise<SaveOutcome>
  /** It may be left empty, which is then what is kept. Otherwise an empty field puts the value back. */
  optional?: boolean
}

/**
 * A line of text edited where it is: Enter or leaving the field keeps what was typed, and Escape
 * puts the value back. What could not be kept stays in the field, with why (`problem`), to be put
 * right or given up. Spread `field` on the `TextField`.
 */
export const useEditedField = ({ value, onSave, optional = false }: EditedField) => {
  // What is being typed, while it is, and after it could not be kept.
  const [draft, setDraft] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string>()
  // Left with Escape, which keeps nothing that was typed.
  const cancelled = useRef(false)

  const settle = async () => {
    const next = draft?.trim()
    if (cancelled.current || next === undefined || next === value || (next === '' && !optional)) {
      cancelled.current = false
      setDraft(undefined)
      setProblem(undefined)
      return
    }
    setSaving(true)
    setProblem(undefined)
    const outcome = await onSave(next)
    setSaving(false)
    if (outcome.saved) setDraft(undefined)
    else setProblem(outcome.problem)
  }

  return {
    problem,
    field: {
      value: draft ?? value,
      invalid: problem !== undefined,
      // Still focusable while it is kept, so that a keyboard user is not thrown out of it.
      readOnly: saving,
      'aria-busy': saving || undefined,
      spellCheck: false,
      enterKeyHint: 'done',
      onFocus: () => setDraft((current) => current ?? value),
      onValueChange: setDraft,
      onBlur: () => void settle(),
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        // An IME's confirming Enter is not the field's.
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur()
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelled.current = true
          event.currentTarget.blur()
        }
      },
    } as const,
  }
}
