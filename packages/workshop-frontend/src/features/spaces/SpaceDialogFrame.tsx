import type { ReactNode } from 'react'
import { Dialog } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import { WorkshopIconButton } from '../../components/WorkshopControls'

const FRAME_CLASS_NAMES = {
  // A short form, placed a fifth of the way down like the app's confirmations.
  form: '!top-[20%] !w-[min(440px,calc(100vw-32px))]',
  // A list that may outgrow the viewport: the caller's body scrolls inside a height-capped column.
  list: '!top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(560px,calc(100vw-32px))] flex-col',
} as const

/**
 * The shell the spaces dialogs share: an open dialog with a title, a description and a close
 * button, over the body and footer its caller renders. Mounted only while the dialog is open, so
 * each opening starts from fresh state.
 */
export const SpaceDialogFrame = ({ layout, title, description, busy, onClose, children }: {
  layout: keyof typeof FRAME_CLASS_NAMES
  title: string
  description: ReactNode
  /** A call that closing would orphan is in flight: the dialog stays open until it settles. */
  busy: boolean
  onClose: () => void
  children: ReactNode
}) => (
  <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <Dialog
      className={`responsive-dialog !z-[1000] !-translate-y-0 overflow-hidden bg-kumo-base p-0 ${FRAME_CLASS_NAMES[layout]}`}
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
      {children}
    </Dialog>
  </Dialog.Root>
)
