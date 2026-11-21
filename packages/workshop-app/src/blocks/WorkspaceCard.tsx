import { cn } from '@cloudflare/kumo/utils'
import { CardAction, LIST_ACTION, LinkButton } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/prefs/preferenceFields'
import { MemberAvatars, type ListedMember } from './MemberAvatars'
import { StarButton } from './StarButton'
import { UnreadDot } from './UnreadDot'
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
  /** How many have access to it, when more than `members` lists. */
  memberCount?: number
  starred: boolean
  onStarredChange: (starred: boolean) => void
  /** The workspace's address, so that it can be opened in another tab. */
  href?: string
  /** Whether anything in it is unread, which a dot marks, and its more menu marks read. */
  unread?: { onMarkRead: () => void }
  /** How the viewer may take it out of their list, from its more menu. */
  removal?: WorkspaceMoreMenuProps['removal']
  onSelect: () => void
}

const HIGHLIGHT = 'group-hover:bg-kumo-contrast/5 group-has-focus-visible:bg-kumo-contrast/5 group-has-data-popup-open:bg-kumo-contrast/5'

/**
 * One workspace on the Workspaces page, as a card: its icon, and under it its title, on two lines
 * at most, then on one line when it was last active, after a dot while it has anything unread, and, at its end, who has access to it. Pointed at, more and its star show in its corner; a starred
 * one keeps its star.
 */
export const WorkspaceCard = ({ workspaceLabel, workspaceLook, title, time, members, memberCount, starred, onStarredChange, href, unread, removal, onSelect }: WorkspaceCardProps) => (
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
          <span className="flex min-w-0 items-center gap-1.5">
            {unread && <UnreadDot />}
            <span className="truncate text-sm text-kumo-subtle">{time}</span>
          </span>
          {members && members.length > 0 && <MemberAvatars members={members} count={memberCount} small />}
        </span>
      </span>
    </LinkButton>
    <span className="absolute top-2 right-2 flex">
      {href && (
        <CardAction>
          <WorkspaceMoreMenu title={title} href={href} onMarkRead={unread?.onMarkRead} removal={removal} triggerClassName={LIST_ACTION} />
        </CardAction>
      )}
      <CardAction shown={starred}>
        <StarButton title={title} starred={starred} onStarredChange={onStarredChange} pin />
      </CardAction>
    </span>
  </div>
)
