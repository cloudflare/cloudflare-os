import type { ReactElement, ReactNode } from 'react'
import { Popover as BasePopover } from '@cloudflare/kumo/primitives/popover'

export type PopoverProps = {
  /** The button that opens it. */
  trigger: ReactElement
  /** Names the popup for those who cannot see what it belongs to. */
  title: string
  children: ReactNode
}

/**
 * A surface that opens under its trigger and closes on Escape or a click elsewhere. It keeps to
 * the room there is, scrolling inside itself. Kumo's ready-made popover cannot set the
 * positioner's z-index above floating chat surfaces.
 */
export const Popover = ({ trigger, title, children }: PopoverProps) => (
  <BasePopover.Root>
    <BasePopover.Trigger render={trigger} />
    <BasePopover.Portal>
      <BasePopover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={12} className="z-50">
        <BasePopover.Popup
          aria-label={title}
          className="max-h-[min(var(--available-height),32rem)] w-[min(var(--available-width),28rem)] origin-[var(--transform-origin)] overflow-y-auto overscroll-contain rounded-[21px] bg-kumo-base p-4 text-base/5 text-kumo-default shadow-lg ring-1 ring-kumo-line outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>
)
