import type { ReactNode, Ref } from 'react'
import { Dialog } from '@cloudflare/kumo'
import { ChevronLeftIcon, CloseIcon } from '../../components/icons/designIcons'

/**
 * The sheet both sharing dialogs sit on (Figma "Share" page, in this app's dialog style): a title
 * with a line on what sharing gives, an optional way back from a sub-view, the content, and a
 * footer. Escape and the close button go back one step before they close.
 */
export const ShareDialogFrame = ({ open, onDismiss, title, description, onBack, backRef, backLabel, closeDisabled, footer, children }: {
  open: boolean
  /** Escape, the backdrop or the close button: back out of a sub-view, else close. */
  onDismiss: () => void
  title: ReactNode
  description?: ReactNode
  /** Shown in a sub-view, to return to the people list. */
  onBack?: () => void
  backRef?: Ref<HTMLButtonElement>
  backLabel?: string
  closeDisabled?: boolean
  footer?: ReactNode
  children: ReactNode
}) => (
  <Dialog.Root open={open} onOpenChange={next => { if (!next) onDismiss() }}>
    <Dialog
      className="responsive-dialog !z-[1000] flex !w-[min(512px,calc(100vw-32px))] max-h-[calc(100dvh-4rem)] flex-col overflow-hidden rounded-3xl bg-kumo-base p-0 sm:max-h-[calc(100dvh-8rem)]"
      size="lg"
    >
      <div className="flex shrink-0 items-start gap-2 px-5 pb-3 pt-5">
        {onBack && (
          <button
            ref={backRef}
            type="button"
            onClick={onBack}
            aria-label={backLabel ?? 'Back'}
            className="-ml-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
          >
            <ChevronLeftIcon size={14} />
          </button>
        )}
        <div className="flex min-h-7 min-w-0 flex-1 flex-col justify-center">
          <Dialog.Title className="truncate text-[15px] font-medium leading-[18px] text-kumo-default">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">{description}</Dialog.Description>
          )}
        </div>
        <Dialog.Close
          disabled={closeDisabled}
          render={props => (
            <button
              {...props}
              type="button"
              aria-label="Close"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:opacity-50"
            >
              <CloseIcon size={14} />
            </button>
          )}
        />
      </div>
      {children}
      {footer && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-kumo-line px-5 py-4">
          {footer}
        </div>
      )}
    </Dialog>
  </Dialog.Root>
)

/** The scrolling middle of a sharing dialog. */
export const ShareDialogBody = ({ children }: { children: ReactNode }) => (
  <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-none px-5 pb-3">{children}</div>
)

/** The footer's main action: a dark pill, as this app's dialogs end. */
export const sharePrimaryButtonClass =
  'ml-auto inline-flex h-[34px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-kumo-contrast px-3.5 text-[13px] font-medium text-kumo-inverse transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40'

/** The footer's way into a sub-view, such as what people without access see; as tall as the main action. */
export const shareFooterPillClass =
  'inline-flex h-[34px] min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-full bg-kumo-tint px-3 text-[13px] font-medium text-kumo-default transition-colors hover:bg-kumo-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring'
