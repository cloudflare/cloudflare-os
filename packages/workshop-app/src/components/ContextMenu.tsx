import type { ReactNode } from 'react'
import { ContextMenu as BaseContextMenu } from '@cloudflare/kumo/primitives/context-menu'
import './ContextMenu.css'

export type ContextMenuProps = {
  /** The menu's items: `DropdownMenu.Item`s and separators, as a dropdown menu has. */
  menu: ReactNode
  'aria-label': string
  /** What it is the menu of, which opens it when right-clicked, or held with a finger. */
  children: ReactNode
  className?: string
}

/**
 * The menu something has when right-clicked, or held with a finger: the same items as its More
 * menu, on the same surface, growing out of where it was clicked on the dropdown menu's spring.
 */
export const ContextMenu = ({ menu, 'aria-label': label, children, className }: ContextMenuProps) => (
  <BaseContextMenu.Root>
    <BaseContextMenu.Trigger className={className}>{children}</BaseContextMenu.Trigger>
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner collisionPadding={12} className="z-50">
        <BaseContextMenu.Popup
          aria-label={label}
          className="context-menu max-h-[min(var(--available-height),24rem)] w-max max-w-[min(var(--available-width),28rem)] overflow-y-auto overscroll-contain rounded-[21px] bg-kumo-base p-1.5 text-kumo-default ring-1 ring-kumo-contrast/6 shadow-[0_8px_24px_rgb(0_0_0/0.08)] outline-none"
        >
          {menu}
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  </BaseContextMenu.Root>
)
