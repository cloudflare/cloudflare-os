import type { ReactNode } from 'react'
import { Dialog as BaseDialog } from '@cloudflare/kumo/primitives/dialog'

export type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What it holds, with a `Dialog.Title` in it, which is what it is called. */
  children: ReactNode
}

/**
 * Something that has the window to itself until it is answered or put away, in the middle of it
 * over everything else, which is dimmed and cannot be reached. Escape and a click beside it put it
 * away. It is no taller than the window: what is in it says which part scrolls.
 */
const DialogRoot = ({ open, onOpenChange, children }: DialogProps) => (
  <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-kumo-canvas/80 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
      {/* A surface in it is a step less round than it is (`--surface-radius`), which whatever draws one there goes by. */}
      <BaseDialog.Popup className="[--surface-radius:1rem] fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-1.5rem))] -translate-1/2 flex-col overflow-hidden rounded-3xl bg-kumo-base text-base text-kumo-default ring-1 ring-kumo-contrast/6 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none">
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
