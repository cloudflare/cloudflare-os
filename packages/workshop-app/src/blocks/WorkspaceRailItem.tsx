import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { Tooltip } from '@/components/Tooltip'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceListItemProps } from './WorkspaceListItem'

/**
 * One workspace on the collapsed sidebar's rail: its icon alone, with the unread dot on its
 * corner. Its title and subtitle are in a tooltip.
 */
export const WorkspaceRailItem = ({
  id,
  workspaceLabel,
  title,
  subtitle,
  unread,
  selected,
  href,
  onSelect,
}: WorkspaceListItemProps) => (
  <Tooltip
    side="right"
    content={(
      <>
        <span className="block font-medium">{title}</span>
        {subtitle && <span className="block text-kumo-subtle">{subtitle}</span>}
      </>
    )}
  >
    <LinkButton
      href={href}
      data-workspace-id={id}
      onClick={onSelect}
      aria-label={unread ? `${title}, unread` : title}
      aria-current={selected || undefined}
      className={cn(
        // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
        "relative after:absolute after:inset-0 after:content-['']",
        'grid size-10 place-items-center rounded-xl not-data-underlay:hover:bg-kumo-contrast/8',
        selected && 'not-data-underlay:bg-kumo-contrast/8',
      )}
    >
      <WorkspaceIcon label={workspaceLabel} small />
      {unread && <span aria-hidden="true" className="absolute right-1 bottom-1.5 size-2.5 rounded-full bg-kumo-brand ring-2 ring-kumo-canvas" />}
    </LinkButton>
  </Tooltip>
)
