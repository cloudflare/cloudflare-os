import type { ReactElement, ReactNode } from 'react'
import { ContextMenu as BaseContextMenu } from '@cloudflare/kumo/primitives/context-menu'
import { cn } from '@cloudflare/kumo/utils'

export type ContextMenuProps = {
  /**
   * What is right-clicked, or pressed and held on a touch screen, to open the menu where it was:
   * drawn as it is, with what opens the menu merged into it.
   */
  trigger: ReactElement
  /** What the menu is of, for whatever reads it out. */
  'aria-label': string
  /** Its items: `DropdownMenu`'s, `Item`, `Separator` and `Submenu`, which are the same in either. */
  children: ReactNode
  /**
   * Whether it is open, for whoever keeps that, such as to open it only over some of what the
   * trigger holds. With `onOpenChange`; otherwise it opens and closes itself.
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * A menu opened where its trigger was right-clicked, or pressed and held on a touch screen, which
 * stands in for the browser's own. It is simply there, as a submenu is: there is no button to
 * morph out of.
 */
export const ContextMenu = ({ trigger, 'aria-label': label, children, open, onOpenChange }: ContextMenuProps) => (
  <BaseContextMenu.Root open={open} onOpenChange={onOpenChange && ((next) => onOpenChange(next))}>
    <BaseContextMenu.Trigger render={trigger} />
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner collisionPadding={12} className="z-50">
        <BaseContextMenu.Popup
          aria-label={label}
          className={cn(
            'flex max-h-[min(var(--available-height),24rem)] w-max max-w-[min(var(--available-width),28rem)] origin-[var(--transform-origin)] flex-col overflow-hidden rounded-[21px] bg-kumo-base text-kumo-default ring-1 ring-kumo-contrast/6 outline-none',
            'transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none',
          )}
        >
          <div className="overflow-y-auto overscroll-contain p-1.5">{children}</div>
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  </BaseContextMenu.Root>
)
