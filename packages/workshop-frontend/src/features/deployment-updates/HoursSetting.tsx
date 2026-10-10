import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { MAX_UPDATE_HOURS } from '@gadgets/workshop-shared/api'
import { useFieldErrorAlert } from '../ai-models/useFieldErrorAlert'

// The hours typed into a field, or null unless they are a whole number the server accepts.
const parseHours = (text: string): number | null => {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const hours = Number(trimmed)
  return hours <= MAX_UPDATE_HOURS ? hours : null
}

const HOURS_ERROR = `Enter a whole number of hours from 0 to ${MAX_UPDATE_HOURS}`

/** A whole number of hours, saved on its own. */
export const HoursSetting = ({ label, help, hours, onSave }: {
  label: string
  help: string
  /** The hours the server holds. */
  hours: number
  /**
   * Saves `hours` and re-reads what the server holds, resolving whether both went through. A
   * failure is reported by the caller.
   */
  onSave: (hours: number) => Promise<boolean>
}) => {
  // What is typed into the field, or null while the field shows the server's hours.
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const fieldError = useFieldErrorAlert()
  const parsed = draft === null ? hours : parseHours(draft)
  const error = parsed === null ? HOURS_ERROR : undefined
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
      fieldError.pointAt(field.current, HOURS_ERROR)
      return
    }
    if (parsed === hours) {
      setDraft(null)
      return
    }
    focusBeforeSave.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSaving(true)
    try {
      // Until the server's hours have been re-read, what was typed stays: after a failed save, to
      // be saved again, and after a failed re-read, since the hours the field would show are stale.
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
        value={draft ?? String(hours)}
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
