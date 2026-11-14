import { useState, type ReactNode } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'

export type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** What will happen, and what cannot be had back. */
  description?: ReactNode
  /** The action, as the button says it: "Delete chat". */
  confirm: string
  /** It cannot be undone, so the button says so in its colour. */
  destructive?: boolean
  /**
   * Does it. While a promise it returns is out the dialog stays, its buttons held, and it goes
   * once the promise resolves. A rejection leaves it open, under why.
   */
  onConfirm: () => void | Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Asks before doing something that cannot be taken back, with the action named on its button. */
export const ConfirmDialog = ({ open, onOpenChange, title, description, confirm, destructive, onConfirm }: ConfirmDialogProps) => {
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const run = async () => {
    setProblem(undefined)
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      // Not while it is being done, which would leave it half done with nothing to say so.
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      onClosed={() => setProblem(undefined)}
      size="sm"
      title={title}
      description={description}
      footer={(
        <>
          <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={destructive ? 'danger' : 'primary'} disabled={pending} onClick={() => void run()}>{confirm}</Button>
        </>
      )}
    >
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
