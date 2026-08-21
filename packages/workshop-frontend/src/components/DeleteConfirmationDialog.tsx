import { Dialog } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'

interface DeleteConfirmationDialogProps {
  open: boolean
  title: string
  description: ReactNode
  isDeleting?: boolean
  /** Label for the confirm button (defaults to "Delete"). */
  confirmLabel?: string
  /** Label for the confirm button while the action runs (defaults to "Deleting..."). */
  confirmingLabel?: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export default function DeleteConfirmationDialog({
  open,
  title,
  description,
  isDeleting = false,
  confirmLabel = 'Delete',
  confirmingLabel = 'Deleting...',
  onOpenChange,
  onConfirm,
}: DeleteConfirmationDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isDeleting) onOpenChange(nextOpen)
      }}
    >
      <Dialog
        className="responsive-dialog !z-[1000] !w-[min(420px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[20%] !-translate-y-0"
        size="sm"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              {title}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              {description}
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton
                {...props}
                className="!h-7 !w-7"
                disabled={isDeleting}
                aria-label="Close"
              >
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
          <Dialog.Close
            render={(props) => (
              <WorkshopButton
                {...props}
                className="!h-9"
                disabled={isDeleting}
              >
                Cancel
              </WorkshopButton>
            )}
          />
          <WorkshopButton
            tone="danger"
            onClick={onConfirm}
            disabled={isDeleting}
            className="!h-9 min-w-[64px]"
          >
            {isDeleting ? confirmingLabel : confirmLabel}
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
