import { useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Button, ON_SETTINGS_CARD, type SaveOutcome, SettingRow, TextField } from '@gadgets/ui'

export type SettingTextProps = {
  title: string
  description?: ReactNode
  /** The text as it is kept. */
  value: string
  /** What was written was saved, different from what is kept. Empty is kept as it is. */
  onSave: (value: string) => Promise<SaveOutcome>
  placeholder?: string
  /** How many lines show. */
  rows?: number
  /** The most it may be, in characters: more than that cannot be saved, and says by how much. */
  maxLength?: number
}

const COUNT = new Intl.NumberFormat('en')

/**
 * A setting that is written at length, under what is said of it, at the row's full width: as it
 * can run to several lines, Enter is a new line, and what is written is kept only when it is
 * saved, or put back with Discard, both under it once it differs from what is kept, with how long
 * it is. What could not be kept stays, under why.
 */
export const SettingText = ({ title, description, value, onSave, placeholder, rows = 2, maxLength }: SettingTextProps) => {
  // What is being written, while it differs from what is kept.
  const [draft, setDraft] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string>()
  const text = draft ?? value
  const changed = draft !== undefined && draft !== value
  const over = maxLength !== undefined && text.length > maxLength ? text.length - maxLength : 0

  const save = async () => {
    if (draft === undefined) return
    setSaving(true)
    setProblem(undefined)
    const outcome = await onSave(draft)
    setSaving(false)
    if (outcome.saved) setDraft(undefined)
    else setProblem(outcome.problem)
  }

  return (
    <SettingRow title={title} description={description} stacked>
      <div className="flex w-full flex-col gap-3">
        <TextField
          aria-label={title}
          rows={rows}
          value={text}
          placeholder={placeholder}
          invalid={over > 0 || problem !== undefined}
          readOnly={saving}
          aria-busy={saving || undefined}
          onValueChange={(next) => {
            setDraft(next)
            setProblem(undefined)
          }}
        />
        {changed && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p role={problem || over ? 'alert' : undefined} className={cn('me-auto text-sm', problem || over ? 'text-kumo-danger' : 'text-kumo-subtle')}>
              {problem ?? (over
                ? `${COUNT.format(over)} ${over === 1 ? 'character' : 'characters'} too many`
                : maxLength !== undefined && `${COUNT.format(text.length)} of ${COUNT.format(maxLength)} characters`)}
            </p>
            <Button variant="ghost" disabled={saving} onClick={() => setDraft(undefined)} className={ON_SETTINGS_CARD}>Discard</Button>
            <Button variant="primary" disabled={saving || over > 0} onClick={() => void save()}>Save</Button>
          </div>
        )}
      </div>
    </SettingRow>
  )
}
