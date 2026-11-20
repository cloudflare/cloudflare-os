import { AppWindowIcon, DotsThreeIcon, FolderSimpleIcon, InfoIcon, TrashIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'
import type { AutomationDetails } from './automationDetails'

export type AutomationMoreMenuProps = Pick<AutomationDetails, 'title' | 'gadget' | 'workspace'> & {
  /** Opens what there is to know of it, as its row does. */
  onShowDetails: () => void
  /** Asks whether to delete it. Absent for whoever may not. */
  onDelete?: () => void
  /** Styles the button the menu opens from. */
  triggerClassName?: string
}

/**
 * What else can be done with an automation from its row: see all of it, open the app it runs and
 * the workspace it is in, and after a line, delete it, which asks first.
 */
export const AutomationMoreMenu = ({ title, gadget, workspace, onShowDetails, onDelete, triggerClassName }: AutomationMoreMenuProps) => (
  <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant="ghost" triggerClassName={triggerClassName} align="end">
    <DropdownMenu.Item icon={InfoIcon} onSelect={onShowDetails}>Details</DropdownMenu.Item>
    {gadget && <DropdownMenu.Item icon={AppWindowIcon} onSelect={gadget.onOpen}>Open app</DropdownMenu.Item>}
    {workspace && <DropdownMenu.Item icon={FolderSimpleIcon} onSelect={workspace.onOpen}>Go to workspace</DropdownMenu.Item>}
    {onDelete && <DropdownMenu.Separator />}
    {onDelete && <DropdownMenu.Item icon={TrashIcon} danger onSelect={onDelete}>Delete…</DropdownMenu.Item>}
  </DropdownMenu>
)
