import { useState } from 'react'
import { Cancel01Icon } from '@/components/icons'
import { Banner, Button, Dialog } from '@gadgets/ui'
import { usePending, type ActionResult } from './usePending'

export type DeleteChatDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The chat's title, as it is shown. */
  title: string
  /** Deletes it. A rejection leaves the dialog open, under why. */
  onConfirm: () => ActionResult
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// What the dialog holds, which is only there while it is open: why the last try failed starts over each time.
const DeleteChatContent = ({ title, onConfirm, pending, run }: Pick<DeleteChatDialogProps, 'title' | 'onConfirm'> & {
  pending: boolean
  run: (action: () => ActionResult) => void
}) => {
  const [problem, setProblem] = useState<string>()
  const confirm = () => {
    setProblem(undefined)
    run(async () => {
      try {
        await onConfirm()
      } catch (error) {
        setProblem(messageOf(error))
      }
    })
  }

  return (
    <>
      <header className="flex items-start gap-3 p-6 pb-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">Delete “{title}”?</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            What was said in it goes for everyone in the workspace, with any changes it hasn’t kept. What it made stays in the
            library. This can’t be undone.
          </Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<Cancel01Icon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <footer className="flex flex-col gap-3 p-6 pt-4">
        {problem && <Banner title="Couldn’t delete the chat" description={problem} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button variant="danger" disabled={pending} onClick={confirm}>{pending ? 'Deleting…' : 'Delete'}</Button>
        </div>
      </footer>
    </>
  )
}

/**
 * Asks before deleting a chat, from a menu, where the question cannot grow out of the button as a
 * `ConfirmMenu`'s does. Whoever shows it puts it away once it is done; a failure stays in it,
 * under why.
 */
export const DeleteChatDialog = ({ open, onOpenChange, ...deletion }: DeleteChatDialogProps) => {
  const [pending, run] = usePending()
  return (
    // Not put away while it is being done.
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <DeleteChatContent {...deletion} pending={pending} run={(action) => { if (!pending) run(action) }} />
    </Dialog>
  )
}
