import { useState, type FormEvent } from 'react'
import { Button, SettingRow, TextField } from '@gadgets/ui'

export type PasswordFormProps = {
  /** Resolves to why the password was not changed, or to nothing once it is. */
  onChange: (current: string, next: string) => Promise<string | undefined>
}

// As the sign-up form asks of a new password.
const MIN_LENGTH = 8

/**
 * Changes the password, as the rows of a `SettingsGroup`: the one there is, then the new one
 * twice, each a row with its field in the rows' column, and the button under them. What is wrong
 * with what was typed is said before it is sent, and what the server refused after, across from
 * the button. Once changed, the fields are empty again, and that line says so.
 */
export const PasswordForm = ({ onChange }: PasswordFormProps) => {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [changed, setChanged] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setChanged(false)
    if (next.length < MIN_LENGTH) return setProblem(`Use at least ${MIN_LENGTH} characters for the new password.`)
    if (next !== again) return setProblem('The new passwords don’t match.')
    setBusy(true)
    setProblem(undefined)
    const failure = await onChange(current, next)
    setBusy(false)
    if (failure !== undefined) return setProblem(failure)
    setCurrent('')
    setNext('')
    setAgain('')
    setChanged(true)
  }

  // The row's column where it has one; a width of its own where it is under what is said.
  const width = 'w-72 @lg:w-full'
  return (
    <form onSubmit={submit} className="flex flex-col">
      <SettingRow title="Current password">
        <TextField aria-label="Current password" type="password" autoComplete="current-password" value={current} onValueChange={setCurrent} disabled={busy} className={width} />
      </SettingRow>
      <SettingRow title="New password" description={`At least ${MIN_LENGTH} characters.`}>
        <TextField aria-label="New password" type="password" autoComplete="new-password" value={next} onValueChange={setNext} disabled={busy} className={width} />
      </SettingRow>
      <SettingRow title="Confirm new password">
        <TextField aria-label="Confirm new password" type="password" autoComplete="new-password" value={again} onValueChange={setAgain} disabled={busy} invalid={again !== '' && again !== next} className={width} />
      </SettingRow>
      {/* How it went, across from the button that does it. */}
      <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-3 border-t border-kumo-line py-4">
        {problem && <p role="alert" className="min-w-[min(100%,14rem)] flex-1 text-sm text-kumo-danger">{problem}</p>}
        {changed && <p role="status" className="min-w-[min(100%,14rem)] flex-1 text-sm text-kumo-subtle">Password changed.</p>}
        <Button type="submit" variant="primary" disabled={busy || !current || !next || !again}>
          {busy ? 'Changing…' : 'Change password'}
        </Button>
      </div>
    </form>
  )
}
