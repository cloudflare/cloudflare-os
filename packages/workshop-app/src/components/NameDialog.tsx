import { useState } from 'react'
import { Input } from '@cloudflare/kumo'
import { Button } from './Button'
import { Dialog } from './Dialog'

export type NameDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  /** The field's label: "Name". */
  label: string
  /** What the field starts with, such as the name it has now. */
  initial?: string
  placeholder?: string
  /** The action, as the button says it: "Rename", "Create". */
  confirm: string
  /**
   * The name it starts with may be kept, as when naming something for the first time from what it
   * is called now. Otherwise, as for a rename, it must change.
   */
  keepable?: boolean
  /**
   * Does it with the trimmed name, as `ConfirmDialog`'s `onConfirm` does: held while it is out,
   * open under why if it rejects, and left as it was on `false`.
   */
  onSubmit: (name: string) => void | boolean | Promise<void | boolean>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Asks for a name, for something new or to rename something, and does it with Enter or the button. */
export const NameDialog = ({ open, onOpenChange, title, description, label, initial = '', placeholder, confirm, keepable = false, onSubmit }: NameDialogProps) => {
  const [name, setName] = useState(initial)
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const trimmed = name.trim()
  const submit = async () => {
    if (!trimmed || pending) return
    setProblem(undefined)
    setPending(true)
    try {
      if ((await onSubmit(trimmed)) !== false) onOpenChange(false)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      onClosed={() => {
        setName(initial)
        setProblem(undefined)
      }}
      size="sm"
      title={title}
      description={description}
      footer={(
        <>
          <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={pending || !trimmed || (!keepable && trimmed === initial)} onClick={() => void submit()}>{confirm}</Button>
        </>
      )}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <Input label={label} value={name} onChange={(event) => setName(event.target.value)} placeholder={placeholder} disabled={pending} autoFocus />
      </form>
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
