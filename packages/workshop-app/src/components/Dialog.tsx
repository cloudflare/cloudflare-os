import type { ReactNode } from 'react'
import { Dialog as BaseDialog } from '@cloudflare/kumo/primitives/dialog'
import { cn } from '@cloudflare/kumo/utils'

export type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Wider than most, for one that holds a service's own form, laid out for more room. */
  wide?: boolean
  /** What it holds, with a `Dialog.Title` in it, which is what it is called. */
  children: ReactNode
}

/**
 * Something that has the window to itself until it is answered or put away, in the middle of it
 * over everything else, which is dimmed and cannot be reached. Escape and a click beside it put it
 * away. It is no taller than the window: what is in it says which part scrolls.
 */
const DialogRoot = ({ open, onOpenChange, wide, children }: DialogProps) => (
  <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
    <BaseDialog.Portal>
      {/* Drawn for one opened from another too, which it dims as it dims the page. */}
      <BaseDialog.Backdrop forceRender className="fixed inset-0 z-50 bg-kumo-canvas/80 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
      {/* A surface in it is a step less round than it is (`--surface-radius`), which whatever draws one there goes by.
          Centred by its margins rather than moved, so that what is fixed in it, such as a
          configurator's frame (`ResourceConfiguratorFrame`), is placed by the window while it is still. */}
      <BaseDialog.Popup className={cn(
        '[--surface-radius:1rem] fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-3xl bg-kumo-base text-base text-kumo-default ring-1 ring-kumo-contrast/6 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none',
        wide && 'w-[min(40rem,calc(100vw-1.5rem))]',
      )}>
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>
)

export const Dialog = Object.assign(DialogRoot, {
  Title: BaseDialog.Title,
  Description: BaseDialog.Description,
  Close: BaseDialog.Close,
})
