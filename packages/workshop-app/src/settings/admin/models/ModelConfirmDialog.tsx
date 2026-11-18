import type { ReactNode } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'

export type ModelConfirmDialogProps = {
  /** What is asked, or nothing while nothing is: "Disable “GPT-6”?". */
  title: string | undefined
  /** What doing it does to whatever uses the model. */
  description: ReactNode
  /** The button that does it, and what it says while it is done: "Disable", "Disabling…". */
  confirmLabel: string
  pendingLabel: string
  /** It is being done, which holds the dialog. */
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Asks before something is done to a gateway model that breaks what uses it, or frees its ID,
 * which a menu's item cannot grow a question out of as a `ConfirmMenu` does. Open while there is
 * a `title`, and held while it is done; why it could not be is said over the part, as the rest is.
 */
export const ModelConfirmDialog = ({ title, description, confirmLabel, pendingLabel, pending, onConfirm, onCancel }: ModelConfirmDialogProps) => (
  <Dialog open={title !== undefined} onOpenChange={(open) => { if (!open && !pending) onCancel() }}>
    <header className="flex items-start gap-3 p-6 pb-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
        <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">{title}</Dialog.Title>
        <Dialog.Description className="text-sm text-kumo-subtle">{description}</Dialog.Description>
      </div>
      <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
    </header>
    <footer className="flex justify-end gap-2 p-6 pt-4">
      <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
      <Button variant="danger" disabled={pending} onClick={onConfirm}>{pending ? pendingLabel : confirmLabel}</Button>
    </footer>
  </Dialog>
)
