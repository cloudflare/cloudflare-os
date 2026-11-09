import type { ReactNode } from 'react'
import { Dialog } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import { WorkshopIconButton } from '../../components/WorkshopControls'

const FRAME_CLASS_NAMES = {
  // A short form, placed a fifth of the way down like the app's confirmations.
  form: '!top-[20%] !max-h-[calc(80vh-24px)] !w-[min(440px,calc(100vw-32px))]',
  // A list, placed higher to leave it room.
  list: '!top-[clamp(24px,10vh,80px)] !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(560px,calc(100vw-32px))]',
} as const

/**
 * The shell the spaces dialogs share: an open dialog with a title, a description and a close
 * button, over a body and, below it, a footer. The dialog is never taller than the window: the
 * body scrolls when it does not fit, and the title and the footer stay in view. Mounted only
 * while the dialog is open, so each opening starts from fresh state.
 */
export const SpaceDialogFrame = ({ layout, title, description, busy, onClose, footer, children }: {
  layout: keyof typeof FRAME_CLASS_NAMES
  title: string
  description: ReactNode
  /** A call that closing would orphan is in flight: the dialog stays open until it settles. */
  busy: boolean
  onClose: () => void
  /** The dialog's buttons, kept in view under the body. */
  footer?: ReactNode
  /** The body, which scrolls when the dialog would outgrow the window. */
  children: ReactNode
}) => (
  <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <Dialog
      className={`responsive-dialog !z-[1000] !flex !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0 ${FRAME_CLASS_NAMES[layout]}`}
      size={layout === 'form' ? 'sm' : 'lg'}
    >
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
        <div className="min-w-0">
          <Dialog.Title className="truncate text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
            {title}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {description}
          </Dialog.Description>
        </div>
        <Dialog.Close
          render={(props) => (
            <WorkshopIconButton {...props} className="!h-7 !w-7" disabled={busy} aria-label="Close">
              <X size={16} />
            </WorkshopIconButton>
          )}
        />
      </div>
      <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        {children}
      </div>
      {footer !== undefined && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-kumo-line px-5 py-3">
          {footer}
        </div>
      )}
    </Dialog>
  </Dialog.Root>
)
