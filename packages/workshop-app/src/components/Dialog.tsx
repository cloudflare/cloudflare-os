import { useRef, type ReactNode } from 'react'
import { Dialog as BaseDialog } from '@cloudflare/kumo/primitives/dialog'
import { cn } from '@cloudflare/kumo/utils'
import { XIcon } from '@phosphor-icons/react'
import { Button } from './Button'
import './Dialog.css'

export type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What it is about, as its heading: "Share Todo". */
  title: ReactNode
  /** A line under the title, saying what will happen. */
  description?: ReactNode
  children?: ReactNode
  /** The answers, at the end: a primary action last. */
  footer?: ReactNode
  /**
   * `sm` for a question with two answers, `md` for a form, `lg` for a list to work through, `xl`
   * for one whose rows say a good deal each.
   */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /**
   * Opens with itself focused rather than its first control, for one read before it is answered,
   * whose first control is a choice no one should seem to be on yet.
   */
  focusSelf?: boolean
  /** Called once it has gone, for whoever needs it gone before going on. */
  onClosed?: () => void
}

const WIDTH = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl' } as const

/**
 * A question the page cannot go on without: centred over the window, which is dimmed and made
 * inert beneath it. Escape, a click outside and the × in its corner all put it away, as does
 * whatever the footer does. It grows in the way a card arrives in a conversation (`Dialog.css`).
 */
export const Dialog = ({ open, onOpenChange, title, description, children, footer, size = 'md', focusSelf, onClosed }: DialogProps) => {
  const popup = useRef<HTMLDivElement>(null)
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)} onOpenChangeComplete={(next) => { if (!next) onClosed?.() }}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="dialog-backdrop fixed inset-0 z-50 bg-black/20 dark:bg-black/50" />
        {/* Kept clear of the window's edges and its safe areas, and scrolled within if taller. */}
        <BaseDialog.Viewport className="fixed inset-0 z-50 grid grid-cols-[minmax(0,1fr)] place-items-center overflow-y-auto p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
          <BaseDialog.Popup
            ref={popup}
            initialFocus={focusSelf ? popup : undefined}
            className={cn(
              'dialog-popup relative flex w-full flex-col gap-5 rounded-[28px] bg-kumo-base p-6 text-base/5 text-kumo-default outline-none',
              'shadow-[0_12px_40px_rgb(0_0_0/0.12)] ring-1 ring-kumo-contrast/6',
              WIDTH[size],
            )}
          >
            <div className="flex flex-col gap-1.5 pe-8">
              <BaseDialog.Title className="text-lg/6 font-medium text-kumo-default">{title}</BaseDialog.Title>
              {description && <BaseDialog.Description className="text-base/5 text-kumo-subtle">{description}</BaseDialog.Description>}
            </div>
            {children}
            {footer && <div className="flex flex-wrap justify-end gap-2">{footer}</div>}
            <BaseDialog.Close
              render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" className="size-3.5" />} aria-label="Close" className="absolute end-3 top-3 text-kumo-subtle" />}
            />
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
