import type { ReactNode } from 'react'
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import { DropdownMenu } from '@cloudflare/kumo'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'

/** One entry of a row's actions, shared by its right-click menu and its More menu. */
export type MenuEntry =
  | { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | 'separator'

// Base UI's items, unlike Kumo's, bring no layout of their own.
const BASE_ITEM = 'flex cursor-default select-none items-center gap-2 outline-none data-[disabled]:opacity-50'

/**
 * The actions of whatever it wraps, on a right-click (or a long press on touch), at the pointer,
 * as a desktop app offers them. Kumo has no context menu, so this is Base UI's, which Kumo's
 * DropdownMenu is built on, dressed as the app's other menus. The wrapper takes no space
 * (`display: contents`): the event still reaches it from the row inside.
 */
export const ContextMenu = ({ items, children }: { items: MenuEntry[]; children: ReactNode }) => (
  <BaseContextMenu.Root>
    <BaseContextMenu.Trigger className="contents">{children}</BaseContextMenu.Trigger>
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="outline-none" style={MENU_POSITIONER_STYLE}>
        <BaseContextMenu.Popup
          className={`${MENU_CONTENT} origin-[var(--transform-origin)] transition-[opacity,scale] duration-150 ease-out data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[ending-style]:duration-100 motion-reduce:transition-none`}
        >
          {items.map((item, index) => item === 'separator'
            ? <BaseContextMenu.Separator key={index} className="mx-1 my-1 h-px bg-kumo-line" />
            : (
              <BaseContextMenu.Item
                key={item.label}
                disabled={item.disabled}
                onClick={item.onSelect}
                className={`${BASE_ITEM} ${item.danger ? `${MENU_ITEM_DANGER} text-kumo-danger` : MENU_ITEM}`}
              >
                {item.label}
              </BaseContextMenu.Item>
            ))}
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  </BaseContextMenu.Root>
)

/** The same entries as items of a Kumo DropdownMenu, for the row's More button. */
export const DropdownMenuEntries = ({ items }: { items: MenuEntry[] }) => (
  <>
    {items.map((item, index) => item === 'separator'
      ? <DropdownMenu.Separator key={index} />
      : (
        <DropdownMenu.Item
          key={item.label}
          disabled={item.disabled}
          onClick={item.onSelect}
          className={item.danger ? MENU_ITEM_DANGER : MENU_ITEM}
        >
          {item.label}
        </DropdownMenu.Item>
      ))}
  </>
)
