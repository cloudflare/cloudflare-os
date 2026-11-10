import { useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import type { GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'

/**
 * Confirms deleting `gadget`. Mounted per request, it opens at once and calls `onClosed` once its
 * closing transition ends, so the gadget's name stays on screen until it has faded out. It holds
 * the summary itself, since the workpiece subscription may drop the gadget from the list before
 * the deletion returns.
 */
export const DeleteGadgetDialog = ({
  gadget,
  onDelete,
  onClosed,
}: {
  gadget: GadgetSummary
  /**
   * Settles once the deletion has finished or failed, reporting a failure itself; the dialog
   * stays open, busy, until then.
   */
  onDelete: (id: WorkpieceId) => Promise<void>
  onClosed: () => void
}) => {
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onDelete(gadget.id)
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  return (
    <Dialog.Root
      role="alertdialog"
      open={open}
      onOpenChange={next => { if (!next && !busy) setOpen(false) }}
      onOpenChangeComplete={isOpen => { if (!isOpen) onClosed() }}
    >
      <Dialog className="responsive-dialog overflow-y-auto p-8">
        <Dialog.Title className="text-lg font-semibold">
          Delete “{gadget.title}”?
        </Dialog.Title>
        <Dialog.Description className="mt-2 text-kumo-subtle">
          This permanently deletes the gadget, its data and its hooks. Its connections stay in the
          workspace. This can’t be undone.
        </Dialog.Description>
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close
            render={props => (
              <Button variant="secondary" {...props} disabled={busy}>
                Cancel
              </Button>
            )}
          />
          <Button variant="destructive" loading={busy} onClick={() => { void confirm() }}>
            Delete
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
