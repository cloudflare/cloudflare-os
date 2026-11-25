import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/prefs/preferenceFields'
import { FOCUS_RING } from '@/components/focusRing'
import { UnreadDot } from './UnreadDot'

export type WorkspaceListItemProps = {
  /** Identifies the row to the sidebar's shared highlight. */
  id?: string
  workspaceLabel: string
  /** How its icon is drawn, when not as any workspace's is. */
  workspaceLook?: WorkspaceLook
  title: string
  /** A line under the title, e.g. when the workspace was last active. */
  subtitle?: string
  unread?: boolean
  /**
   * What in it is waiting on the user, in words, such as an agent's run stopped for their
   * approval: said in the subtitle's place, with a dot of its own in the unread dot's.
   */
  attention?: string
  selected?: boolean
  /** Its menu is open: it keeps the hover while the pointer is in the menu. */
  menuOpen?: boolean
  /** The workspace's address, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/** One workspace in the sidebar: its icon, title, subtitle and unread dot, or what waits on the user in it. */
export const WorkspaceListItem = ({
  id,
  workspaceLabel,
  workspaceLook,
  title,
  subtitle,
  unread,
  attention,
  selected,
  menuOpen,
  href,
  onSelect,
}: WorkspaceListItemProps) => (
  <LinkButton
    href={href}
    data-workspace-id={id}
    data-menu-open={menuOpen || undefined}
    onClick={onSelect}
    aria-current={selected || undefined}
    className={cn(
      // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
      "relative after:absolute after:inset-0 after:content-['']",
      'flex w-full items-center gap-3 rounded-2xl px-3 py-3 pr-4 text-left text-base not-data-underlay:hover:bg-kumo-fill', FOCUS_RING,
      selected && 'not-data-underlay:bg-kumo-fill',
    )}
  >
    <span data-pin-icon className="flex shrink-0"><WorkspaceIcon label={workspaceLabel} {...workspaceLook} /></span>
    <span className="min-w-0 flex-1 leading-snug">
      <span className="block truncate font-medium text-kumo-default">{title}</span>
      {attention
        ? <span className="block truncate text-kumo-warning">{attention}</span>
        : subtitle && <span className="block truncate text-kumo-subtle">{subtitle}</span>}
    </span>
    {attention
      ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-warning" />
      : unread && <UnreadDot />}
  </LinkButton>
)
