import type { ReactElement } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { ContextMenu } from '@cloudflare/kumo/primitives/context-menu'
import { Trash } from '@phosphor-icons/react'
import { MENU_POSITIONER_STYLE } from '../../components/menuStyles'

/**
 * The right-click (or long-press) menu of a gadget wherever the workspace lists one. `trigger` is
 * rendered as the element that opens it, and carries `data-popup-open` while the menu is open.
 */
export const GadgetContextMenu = ({
  trigger,
  onDelete,
}: {
  trigger: ReactElement
  onDelete: () => void
}) => (
  <ContextMenu.Root>
    <ContextMenu.Trigger render={trigger} />
    <DropdownMenu.Content style={MENU_POSITIONER_STYLE}>
      <DropdownMenu.Item icon={Trash} variant="danger" onClick={onDelete}>
        Delete
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </ContextMenu.Root>
)
