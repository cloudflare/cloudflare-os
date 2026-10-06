import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { useFieldErrorAlert } from '../ai-models/useFieldErrorAlert'

// The whole number typed into a field, or null unless it is one from `min` to `max`.
const parseWholeNumber = (text: string, min: number, max: number): number | null => {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= min && value <= max ? value : null
}

/** A whole number of hours or minutes, saved on its own. */
export const DurationSetting = ({ label, help, unit, min, max, value, onSave }: {
  label: string
  help: string
  unit: 'hours' | 'minutes'
  /** The fewest and the most the server accepts. */
  min: number
  max: number
  /** What the server holds. */
  value: number
  /**
   * Saves `value` and re-reads what the server holds, resolving whether both went through. A
   * failure is reported by the caller.
   */
  onSave: (value: number) => Promise<boolean>
}) => {
  // What is typed into the field, or null while the field shows the server's value.
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const fieldError = useFieldErrorAlert()
  const parsed = draft === null ? value : parseWholeNumber(draft, min, max)
  const rangeError = `Enter a whole number of ${unit} from ${min} to ${max}`
  const error = parsed === null ? rangeError : undefined
  // A save disables the field and its button, and a browser takes focus from a control that
  // becomes disabled without giving it back. So the control that had focus when the save began
  // gets it again once the save settles, unless focus has gone elsewhere since.
  const focusBeforeSave = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (saving) return
    if (document.activeElement === document.body) focusBeforeSave.current?.focus()
    focusBeforeSave.current = null
  }, [saving])

  const edit = (text: string) => {
    setDraft(text)
    fieldError.clear()
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (parsed === null) {
      fieldError.pointAt(field.current, rangeError)
      return
    }
    // Only an untouched field is known to match the server: after a failed re-read, `value` is
    // stale, so a typed value that equals it may still differ from what the server holds.
    if (draft === null) return
    focusBeforeSave.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSaving(true)
    try {
      // Until the server's value has been re-read, what was typed stays: after a failed save, to
      // be saved again, and after a failed re-read, since the value the field would show is stale.
      if (await onSave(parsed)) setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form noValidate onSubmit={save} className="grid content-start gap-2">
      <Input
        ref={field}
        label={label}
        description={help}
        inputMode="numeric"
        value={draft ?? String(value)}
        disabled={saving}
        onChange={(event) => edit(event.target.value)}
        error={error}
        aria-invalid={error !== undefined}
      />
      {fieldError.alert}
      <div>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={saving}
          disabled={saving}
          aria-label={`Save “${label}”`}
        >
          Save
        </Button>
      </div>
    </form>
  )
}
