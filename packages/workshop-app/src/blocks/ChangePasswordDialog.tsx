import { useState } from 'react'
import { Input } from '@cloudflare/kumo'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'

export type ChangePasswordDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Changes it. Resolves to whether it was tried (`false` when the connection is down); it then
   * says it is done, and rejects with why it was not, such as the current password being wrong.
   */
  onChange: (current: string, next: string) => Promise<boolean>
}

/** The fewest characters a password may have, as sign-up asks. */
const MIN_LENGTH = 8

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Changes the password the user signs in with: the one they have now, then the new one twice.
 * Change is ready once the new one is long enough and both say the same; it then says it is done.
 */
export const ChangePasswordDialog = ({ open, onOpenChange, onChange }: ChangePasswordDialogProps) => {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const [problem, setProblem] = useState<string>()
  const short = next.length > 0 && next.length < MIN_LENGTH
  const differs = again.length > 0 && again !== next
  const ready = current.length > 0 && next.length >= MIN_LENGTH && again === next

  const change = async () => {
    if (!ready || pending) return
    setProblem(undefined)
    setPending(true)
    try {
      if (await onChange(current, next)) setDone(true)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => { if (!pending) onOpenChange(value) }}
      onClosed={() => {
        setCurrent('')
        setNext('')
        setAgain('')
        setDone(false)
        setProblem(undefined)
      }}
      title={done ? 'Password changed' : 'Change password'}
      description={done ? 'Use it the next time you sign in. Where you’re signed in now stays signed in.' : 'Your password signs you in here, on any device.'}
      footer={done ? (
        <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
      ) : (
        <>
          <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!ready || pending} onClick={() => void change()}>{pending ? 'Changing…' : 'Change password'}</Button>
        </>
      )}
    >
      {!done && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void change()
          }}
        >
          <Input label="Current password" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} disabled={pending} autoFocus />
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            disabled={pending}
            description={short ? undefined : `At least ${MIN_LENGTH} characters.`}
            error={short ? `At least ${MIN_LENGTH} characters, ${MIN_LENGTH - next.length} more.` : undefined}
          />
          <Input
            label="New password again"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(event) => setAgain(event.target.value)}
            disabled={pending}
            error={differs ? 'It isn’t the same as the new password.' : undefined}
          />
          {/* Enter submits from any field. */}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
