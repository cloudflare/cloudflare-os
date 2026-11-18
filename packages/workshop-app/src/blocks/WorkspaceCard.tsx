import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { CardAction } from './CardAction'
import { MemberAvatars, type ListedMember } from './MemberAvatars'
import { LIST_ACTION, StarButton } from './StarButton'
import { WorkspaceMoreMenu, type WorkspaceMoreMenuProps } from './WorkspaceMoreMenu'

export type WorkspaceCardProps = {
  workspaceLabel: string
  /** How its icon is drawn, when not as any workspace's is. */
  workspaceLook?: WorkspaceLook
  title: string
  /** When it was last active, as the list it is in puts it. */
  time?: string
  /** Everyone with access to it, the owner first, once that is known: the viewer alone, when nobody else has. */
  members?: ListedMember[]
  starred: boolean
  onStarredChange: (starred: boolean) => void
  /** The workspace's address, so that it can be opened in another tab. */
  href?: string
  /** How the viewer may take it out of their list, from its more menu. */
  removal?: WorkspaceMoreMenuProps['removal']
  onSelect: () => void
}

const HIGHLIGHT = 'group-hover:bg-kumo-contrast/5 group-has-focus-visible:bg-kumo-contrast/5 group-has-data-popup-open:bg-kumo-contrast/5'

/**
 * One workspace on the Workspaces page, as a card: its icon, and under it its title, on two lines
 * at most, then on one line when it was last active and, at its end, who has access to it. Pointed at, more and its star show in its corner; a starred
 * one keeps its star.
 */
export const WorkspaceCard = ({ workspaceLabel, workspaceLook, title, time, members, starred, onStarredChange, href, removal, onSelect }: WorkspaceCardProps) => (
  <div className="group relative flex flex-col rounded-3xl bg-kumo-tint">
    <LinkButton
      href={href}
      onClick={onSelect}
      // The whole card opens the workspace, apart from the buttons over it.
      className={cn('flex flex-1 flex-col justify-between gap-8 rounded-3xl p-4 text-left text-base', HIGHLIGHT)}
    >
      <WorkspaceIcon label={workspaceLabel} {...workspaceLook} />
      <span className="flex min-w-0 flex-col gap-1 leading-snug">
        <span className="line-clamp-2 font-medium wrap-anywhere text-kumo-default">{title}</span>
        {/* As tall as the pictures whether or not they are known yet, so that the title does not move when they are. */}
        <span className="flex h-5 items-center justify-between gap-2">
          <span className="truncate text-sm text-kumo-subtle">{time}</span>
          {members && members.length > 0 && <MemberAvatars members={members} small />}
        </span>
      </span>
    </LinkButton>
    <span className="absolute top-2 right-2 flex">
      {href && (
        <CardAction>
          <WorkspaceMoreMenu title={title} href={href} removal={removal} triggerClassName={LIST_ACTION} />
        </CardAction>
      )}
      <CardAction shown={starred}>
        <StarButton title={title} starred={starred} onStarredChange={onStarredChange} />
      </CardAction>
    </span>
  </div>
)
