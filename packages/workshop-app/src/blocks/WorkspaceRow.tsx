import { LinkButton } from '@/components/LinkButton'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { MemberAvatars, type ListedMember } from './MemberAvatars'
import { RowAction } from './RowAction'
import { LIST_ACTION, StarButton } from './StarButton'
import { WorkspaceMoreMenu } from './WorkspaceMoreMenu'

export type WorkspaceRowProps = {
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
  onSelect: () => void
}

/**
 * One workspace on the Workspaces page, on one line: its icon and title, and at the far end who
 * has access to it and when it was last active. Pointed at, more and its star slide out at the end; a starred one keeps
 * its star out. The star is last, so it stays where it is as more slides out before it.
 */
export const WorkspaceRow = ({ workspaceLabel, workspaceLook, title, time, members, starred, onStarredChange, href, onSelect }: WorkspaceRowProps) => (
  <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
    <LinkButton
      href={href}
      onClick={onSelect}
      // The whole row opens the workspace, apart from the buttons over it.
      className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base after:absolute after:inset-0 after:content-['']"
    >
      <WorkspaceIcon label={workspaceLabel} {...workspaceLook} />
      <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
      {members && members.length > 0 && <MemberAvatars members={members} />}
      {time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
    </LinkButton>
    {href && (
      <RowAction>
        <span className="relative flex">
          <WorkspaceMoreMenu title={title} href={href} triggerClassName={LIST_ACTION} />
        </span>
      </RowAction>
    )}
    <RowAction shown={starred}>
      <StarButton title={title} starred={starred} onStarredChange={onStarredChange} className="relative" />
    </RowAction>
  </div>
)
