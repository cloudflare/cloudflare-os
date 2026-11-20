import { LIST_ACTION, LinkButton } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/prefs/preferenceFields'
import { MemberAvatars, type ListedMember } from './MemberAvatars'
import { RowAction } from './RowAction'
import { StarButton } from './StarButton'
import { UnreadDot } from './UnreadDot'
import { WorkspaceMoreMenu, type WorkspaceMoreMenuProps } from './WorkspaceMoreMenu'

export type WorkspaceRowProps = {
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

/**
 * One workspace on the Workspaces page, on one line: its icon and title, a dot while it has
 * anything unread, and at the far end who has access to it and when it was last active. Pointed at, more and its star slide out at the end; a starred one keeps
 * its star out. The star is last, so it stays where it is as more slides out before it. On a narrow
 * screen the line has room for less: the time and more are left out, which the workspace's own
 * page has.
 */
export const WorkspaceRow = ({ workspaceLabel, workspaceLook, title, time, members, memberCount, starred, onStarredChange, href, unread, removal, onSelect }: WorkspaceRowProps) => (
  <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
    <LinkButton
      href={href}
      onClick={onSelect}
      // The whole row opens the workspace, apart from the buttons over it.
      className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base after:absolute after:inset-0 after:content-['']"
    >
      <WorkspaceIcon label={workspaceLabel} {...workspaceLook} />
      <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
      {unread && <UnreadDot />}
      {members && members.length > 0 && <MemberAvatars members={members} count={memberCount} />}
      {time && <span className="shrink-0 text-end text-kumo-subtle max-md:hidden">{time}</span>}
    </LinkButton>
    {href && (
      <span className="contents max-md:hidden">
        <RowAction>
          <span className="relative flex">
            <WorkspaceMoreMenu title={title} href={href} onMarkRead={unread?.onMarkRead} removal={removal} triggerClassName={LIST_ACTION} />
          </span>
        </RowAction>
      </span>
    )}
    <RowAction shown={starred}>
      <StarButton title={title} starred={starred} onStarredChange={onStarredChange} className="relative" />
    </RowAction>
  </div>
)
