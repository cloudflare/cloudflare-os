import {
  Delete02Icon, Link04Icon, LinkSquare02Icon, MailOpen01Icon, MoreHorizontalIcon, ViewOffSlashIcon,
} from '@/components/icons'
import { type ButtonProps, DropdownMenu } from '@gadgets/ui'

/**
 * How the viewer takes a workspace out of their list: its owner deletes it, for everyone, and
 * whoever it was shared with removes it from their own list only, keeping their access.
 */
export type WorkspaceRemoval = 'delete' | 'dismiss'

export type WorkspaceMoreMenuProps = {
  /** The workspace's title, for the menu's name. */
  title: string
  /** The workspace's address. Left out, as on its own page, it is neither opened nor copied from here. */
  href?: string
  /** Marks every chat in it read, while it has anything the viewer has not read. */
  onMarkRead?: () => void
  /** How the viewer may take it out of their list, and the way to ask, which asks first. */
  removal?: { kind: WorkspaceRemoval; onSelect: () => void }
  /** The trigger Button's variant: ghost over a list, as its star is. */
  triggerVariant?: ButtonProps['variant']
  /** Styles the button the menu opens from. */
  triggerClassName?: string
}

const copyLink = (href: string) => {
  // Refused without permission, and missing on a page not served securely: nothing is copied.
  navigator.clipboard.writeText(new URL(href, window.location.href).href).catch(() => {})
}

/**
 * What else can be done with a workspace: mark it read, while there is anything to; from its
 * address, open it in another tab and copy its link; then, after a line, delete it or remove it
 * from the list, whichever is the viewer's.
 */
export const WorkspaceMoreMenu = ({ title, href, onMarkRead, removal, triggerVariant = 'ghost', triggerClassName }: WorkspaceMoreMenuProps) => (
  <DropdownMenu icon={MoreHorizontalIcon} aria-label={`More for ${title}`} triggerVariant={triggerVariant} triggerClassName={triggerClassName} align="end">
    {onMarkRead && <DropdownMenu.Item icon={MailOpen01Icon} onSelect={onMarkRead}>Mark as read</DropdownMenu.Item>}
    {onMarkRead && (href || removal) && <DropdownMenu.Separator />}
    {href && (
      <>
        <DropdownMenu.Item icon={LinkSquare02Icon} onSelect={() => window.open(href, '_blank', 'noopener')}>Open in new tab</DropdownMenu.Item>
        <DropdownMenu.Item icon={Link04Icon} onSelect={() => copyLink(href)}>Copy link</DropdownMenu.Item>
      </>
    )}
    {href && removal && <DropdownMenu.Separator />}
    {removal?.kind === 'delete' && <DropdownMenu.Item icon={Delete02Icon} danger onSelect={removal.onSelect}>Delete workspace…</DropdownMenu.Item>}
    {removal?.kind === 'dismiss' && <DropdownMenu.Item icon={ViewOffSlashIcon} onSelect={removal.onSelect}>Remove from my list…</DropdownMenu.Item>}
  </DropdownMenu>
)
