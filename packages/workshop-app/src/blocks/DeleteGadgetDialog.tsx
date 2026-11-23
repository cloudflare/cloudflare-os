import { useState } from 'react'
import { Cancel01Icon } from '@/components/icons'
import { Banner, Button, Dialog } from '@gadgets/ui'
import { usePending, type ActionResult } from './usePending'

export type DeleteGadgetDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Its title, as it is shown. */
  title: string
  /** The workspace it is in, by title, which everyone with access to loses it. */
  workspace?: string
  /** Deletes it. A rejection leaves the dialog open, under why. */
  onConfirm: () => ActionResult
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// What the dialog holds, which is only there while it is open: why the last try failed starts over each time.
const DeleteGadgetContent = ({ title, workspace, onConfirm, pending, run }: Pick<DeleteGadgetDialogProps, 'title' | 'workspace' | 'onConfirm'> & {
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
            It goes for everyone with access to {workspace ? `“${workspace}”` : 'its workspace'}, with its data and anything set to
            run it. What it’s connected to stays in the workspace. This can’t be undone.
          </Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<Cancel01Icon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <footer className="flex flex-col gap-3 p-6 pt-4">
        {problem && <Banner title={`Couldn’t delete “${title}”`} description={problem} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button variant="danger" disabled={pending} onClick={confirm}>{pending ? 'Deleting…' : 'Delete'}</Button>
        </div>
      </footer>
    </>
  )
}

/**
 * Asks before deleting a gadget, a document or anything else made, from a menu, where the question
 * cannot grow out of the button as a `ConfirmMenu`'s does, saying what goes with it and what stays,
 * as the old app's did. Whoever shows it puts it away once it is done; a failure stays in it,
 * under why.
 */
export const DeleteGadgetDialog = ({ open, onOpenChange, ...deletion }: DeleteGadgetDialogProps) => {
  const [pending, run] = usePending()
  return (
    // Not put away while it is being done.
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <DeleteGadgetContent {...deletion} pending={pending} run={(action) => { if (!pending) run(action) }} />
    </Dialog>
  )
}
