import { cn } from '@cloudflare/kumo/utils'
import { LinkButton, Tooltip } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceListItemProps } from './WorkspaceListItem'

/**
 * One workspace on the collapsed sidebar's rail: its icon alone, with the unread dot on its
 * corner, or the dot of what waits on the user in it. Its title and subtitle, or what waits, are
 * in a tooltip.
 */
export const WorkspaceRailItem = ({
  id,
  workspaceLabel,
  workspaceLook,
  title,
  subtitle,
  unread,
  attention,
  selected,
  href,
  onSelect,
}: WorkspaceListItemProps) => (
  <Tooltip
    side="right"
    content={(
      <>
        <span className="block font-medium">{title}</span>
        {attention
          ? <span className="block text-kumo-warning">{attention}</span>
          : subtitle && <span className="block text-kumo-subtle">{subtitle}</span>}
      </>
    )}
  >
    <LinkButton
      href={href}
      data-workspace-id={id}
      onClick={onSelect}
      aria-label={attention ? `${title}, ${attention.toLowerCase()}` : unread ? `${title}, unread` : title}
      aria-current={selected || undefined}
      className={cn(
        // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
        "relative after:absolute after:inset-0 after:content-['']",
        'grid size-10 place-items-center rounded-xl not-data-underlay:hover:bg-kumo-contrast/8',
        selected && 'not-data-underlay:bg-kumo-contrast/8',
      )}
    >
      <WorkspaceIcon label={workspaceLabel} {...workspaceLook} small />
      {(attention || unread) && <span aria-hidden="true" className={cn('absolute right-1 bottom-1.5 size-2.5 rounded-full ring-2 ring-kumo-canvas', attention ? 'bg-kumo-warning' : 'bg-kumo-brand')} />}
    </LinkButton>
  </Tooltip>
)
