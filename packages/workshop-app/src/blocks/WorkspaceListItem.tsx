import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'

export type WorkspaceListItemProps = {
  /** Identifies the row to the sidebar's shared highlight. */
  id?: string
  workspaceLabel: string
  title: string
  /** A line under the title, e.g. when the workspace was last active. */
  subtitle?: string
  unread?: boolean
  selected?: boolean
  /** The workspace's address, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/** One workspace in the sidebar: its icon, title, subtitle and unread dot. */
export const WorkspaceListItem = ({
  id,
  workspaceLabel,
  title,
  subtitle,
  unread,
  selected,
  href,
  onSelect,
}: WorkspaceListItemProps) => (
  <LinkButton
    href={href}
    data-workspace-id={id}
    onClick={onSelect}
    aria-current={selected || undefined}
    className={cn(
      // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
      "relative after:absolute after:inset-0 after:content-['']",
      'flex w-full items-center gap-3 rounded-2xl px-3 py-3 pr-4 text-left text-base not-data-underlay:hover:bg-kumo-fill',
      selected && 'not-data-underlay:bg-kumo-fill',
    )}
  >
    <WorkspaceIcon label={workspaceLabel} />
    <span className="min-w-0 flex-1 leading-snug">
      <span className="block truncate font-medium text-kumo-default">{title}</span>
      {subtitle && <span className="block truncate text-kumo-subtle">{subtitle}</span>}
    </span>
    {unread && <span role="img" aria-label="Unread" className="size-2 shrink-0 rounded-full bg-kumo-brand" />}
  </LinkButton>
)
