import { useState } from 'react'
import { Banner, Button, Dialog } from '@gadgets/ui'
import { usePending, type ActionResult } from './usePending'

export type UpdateFileDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The file's name, as it was saved. */
  name: string
  /** Saves over it. A rejection leaves the dialog open, under why. */
  onConfirm: () => ActionResult
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Asks before saving a gadget over the file an earlier save of it made in one of the user's
 * accounts, which cannot be taken back: what is in the file is replaced, with what was suggested in
 * it. Whoever shows it puts it away once it is done.
 */
export const UpdateFileDialog = ({ open, onOpenChange, name, onConfirm }: UpdateFileDialogProps) => {
  const [pending, run] = usePending()
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
    // Not put away while it is being saved.
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <header className="flex flex-col gap-1 p-6 pb-2 leading-snug">
        <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">Update “{name}”?</Dialog.Title>
        <Dialog.Description className="text-sm text-kumo-subtle">
          This replaces its content with the current version of this gadget. Suggestions that are pending in it are discarded, and comments may lose their place.
        </Dialog.Description>
      </header>
      <footer className="flex flex-col gap-3 p-6 pt-4">
        {problem && <Banner title="Couldn’t update it" description={problem} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button variant="primary" disabled={pending} onClick={confirm}>{pending ? 'Updating…' : 'Update'}</Button>
        </div>
      </footer>
    </Dialog>
  )
}
