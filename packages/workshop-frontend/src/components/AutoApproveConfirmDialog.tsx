import { Dialog } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'

interface AutoApproveConfirmDialogProps {
  open: boolean
  // Human-readable label of the action kind, e.g. "Append to Google Doc".
  actionLabel: string
  // Title of the connection (gatekeeper) the rule applies to, e.g. "My Google Doc".
  resourceTitle: string
  isProcessing?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/**
 * Confirmation for enabling auto-approval of an action type on a connection. Enabling is a standing
 * policy change -- it removes human review for a whole class of future actions
 */
export default function AutoApproveConfirmDialog({
  open,
  actionLabel,
  resourceTitle,
  isProcessing = false,
  onOpenChange,
  onConfirm,
}: AutoApproveConfirmDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isProcessing) onOpenChange(nextOpen)
      }}
    >
      <Dialog
        className="responsive-dialog !z-[1000] !w-[min(440px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[20%] !-translate-y-0"
        size="sm"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              Always approve “{actionLabel}”?
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              Future <span className="font-medium text-kumo-default">{actionLabel}</span> actions on{' '}
              <span className="font-medium text-kumo-default">{resourceTitle}</span> will be applied
              automatically, without asking for approval. This action will be applied now too.
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton
                {...props}
                className="!h-7 !w-7"
                disabled={isProcessing}
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
              <WorkshopButton {...props} className="!h-9" disabled={isProcessing}>
                Cancel
              </WorkshopButton>
            )}
          />
          <WorkshopButton
            tone="primary"
            onClick={onConfirm}
            disabled={isProcessing}
            className="!h-9 min-w-[64px]"
          >
            {isProcessing ? 'Enabling...' : 'Always approve'}
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
