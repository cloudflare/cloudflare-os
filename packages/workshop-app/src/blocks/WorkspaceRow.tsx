import type { ReactNode } from 'react'
import { StarIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { LinkButton } from '@/components/LinkButton'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { MemberAvatars, type ListedMember } from './MemberAvatars'
import { WorkspaceMoreMenu } from './WorkspaceMoreMenu'

export type WorkspaceRowProps = {
  workspaceLabel: string
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

// A button and the gap before it.
const ROOM = '[--action-room:calc(var(--control-size)+0.25rem)]'

const ACTION = 'text-kumo-subtle not-data-disabled:hover:bg-kumo-contrast/5 not-data-disabled:hover:text-kumo-default'

/**
 * One of the row's buttons at its end, which slides out from under the edge, pushing the time in,
 * while the row is pointed at or has focus, or its menu is open. Always out to a finger, which
 * cannot point, and while `shown`.
 */
const Action = ({ shown, children }: { shown?: boolean; children: ReactNode }) => (
  <span
    className={cn(
      // The sidebar underlay's glide (`useWorkspaceUnderlay`), so pointing at a row answers as quickly.
      ROOM,
      'flex shrink-0 justify-end transition-[width,opacity] duration-75 ease-[cubic-bezier(0.2,0,0.15,1)] motion-reduce:transition-none',
      shown
        ? 'w-(--action-room) opacity-100'
        : 'pointer-events-none w-0 opacity-0 group-has-focus-visible:pointer-events-auto group-has-focus-visible:w-(--action-room) group-has-focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:w-(--action-room) group-hover:opacity-100 group-has-data-popup-open:pointer-events-auto group-has-data-popup-open:w-(--action-room) group-has-data-popup-open:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:w-(--action-room) pointer-coarse:opacity-100',
    )}
  >
    {children}
  </span>
)

/**
 * One workspace on the Workspaces page, on one line: its icon and title, and at the far end who
 * has access to it and when it was last active. Pointed at, more and its star slide out at the end; a starred one keeps
 * its star out. The star is last, so it stays where it is as more slides out before it.
 */
export const WorkspaceRow = ({ workspaceLabel, title, time, members, starred, onStarredChange, href, onSelect }: WorkspaceRowProps) => (
  <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
    <LinkButton
      href={href}
      onClick={onSelect}
      // The whole row opens the workspace, apart from the buttons over it.
      className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base after:absolute after:inset-0 after:content-['']"
    >
      <WorkspaceIcon label={workspaceLabel} />
      <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
      {members && members.length > 0 && <MemberAvatars members={members} />}
      {time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
    </LinkButton>
    {href && (
      <Action>
        <span className="relative flex">
          <WorkspaceMoreMenu title={title} href={href} triggerClassName={ACTION} />
        </span>
      </Action>
    )}
    <Action shown={starred}>
      <Button
        variant="ghost"
        icon={<StarIcon weight={starred ? 'fill' : 'regular'} />}
        aria-label={`Star ${title}`}
        aria-pressed={starred}
        onClick={() => onStarredChange(!starred)}
        className={cn('relative', ACTION)}
      />
    </Action>
  </div>
)
