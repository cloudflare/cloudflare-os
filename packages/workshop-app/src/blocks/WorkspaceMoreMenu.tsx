import { ArrowSquareOutIcon, DotsThreeIcon, LinkIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'

export type WorkspaceMoreMenuProps = {
  /** The workspace's title, for the menu's name. */
  title: string
  /** The workspace's address. */
  href: string
  /** Styles the button the menu opens from. */
  triggerClassName?: string
}

const copyLink = (href: string) => {
  // Refused without permission, and missing on a page not served securely: nothing is copied.
  navigator.clipboard.writeText(new URL(href, window.location.href).href).catch(() => {})
}

/** What else can be done with a workspace where it is listed, from its address: open it in another tab, copy its link. */
export const WorkspaceMoreMenu = ({ title, href, triggerClassName }: WorkspaceMoreMenuProps) => (
  <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant="ghost" triggerClassName={triggerClassName} align="end">
    <DropdownMenu.Item icon={ArrowSquareOutIcon} onSelect={() => window.open(href, '_blank', 'noopener')}>Open in new tab</DropdownMenu.Item>
    <DropdownMenu.Item icon={LinkIcon} onSelect={() => copyLink(href)}>Copy link</DropdownMenu.Item>
  </DropdownMenu>
)
