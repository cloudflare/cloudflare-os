import { useState } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { deletionProblem, deletionWords, type AutomationDetails } from './automationDetails'
import { usePending, type ActionResult } from './usePending'

export type DeleteAutomationDialogProps = Pick<AutomationDetails, 'title' | 'gadget'> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Deletes it. A rejection leaves the dialog open, under why. */
  onConfirm: () => ActionResult
}

// What the dialog holds, which is only there while it is open: why the last try failed starts over each time.
const DeleteAutomationContent = ({ title, gadget, onConfirm, pending, run }: Pick<DeleteAutomationDialogProps, 'title' | 'gadget' | 'onConfirm'> & {
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
        setProblem(deletionProblem(error))
      }
    })
  }

  return (
    <>
      <header className="flex items-start gap-3 p-6 pb-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">Delete “{title}”?</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">{deletionWords({ gadget })}</Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <footer className="flex flex-col gap-3 p-6 pt-4">
        {problem && <Banner title={problem} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button variant="danger" disabled={pending} onClick={confirm}>{pending ? 'Deleting…' : 'Delete'}</Button>
        </div>
      </footer>
    </>
  )
}

/**
 * Asks before deleting an automation from its row's more menu, where the question cannot grow out
 * of the button as a `ConfirmMenu`'s does: that it is for good, that the app it runs stays, and
 * that turning it off is the way to stop it for a while. Whoever shows it takes it away with the
 * row once done; a failure stays in it, under why.
 */
export const DeleteAutomationDialog = ({ open, onOpenChange, ...deletion }: DeleteAutomationDialogProps) => {
  const [pending, run] = usePending()
  return (
    // Not put away while it is being done.
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <DeleteAutomationContent {...deletion} pending={pending} run={(action) => { if (!pending) run(action) }} />
    </Dialog>
  )
}
