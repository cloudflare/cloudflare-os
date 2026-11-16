import type { ReactNode } from 'react'
import { StarIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { LinkButton } from '@/components/LinkButton'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { MemberAvatars, type ListedMember } from './MemberAvatars'
import { WorkspaceMoreMenu } from './WorkspaceMoreMenu'

export type WorkspaceCardProps = {
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

const ACTION = 'text-kumo-subtle not-data-disabled:hover:bg-kumo-contrast/5 not-data-disabled:hover:text-kumo-default'
const HIGHLIGHT = 'group-hover:bg-kumo-contrast/5 group-has-focus-visible:bg-kumo-contrast/5 group-has-data-popup-open:bg-kumo-contrast/5'

/**
 * One of the card's buttons in its corner, out of sight until the card is pointed at or has focus,
 * or its menu is open. Always there to a finger, which cannot point, and while `shown`.
 */
const Action = ({ shown, children }: { shown?: boolean; children: ReactNode }) => (
  <span
    className={cn(
      'relative flex transition-opacity duration-75 motion-reduce:transition-none',
      !shown && 'opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-has-data-popup-open:opacity-100 pointer-coarse:opacity-100',
    )}
  >
    {children}
  </span>
)

/**
 * One workspace on the Workspaces page, as a card: its icon, and under it its title, on two lines
 * at most, then on one line when it was last active and, at its end, who has access to it. Pointed at, more and its star show in its corner; a starred
 * one keeps its star.
 */
export const WorkspaceCard = ({ workspaceLabel, title, time, members, starred, onStarredChange, href, onSelect }: WorkspaceCardProps) => (
  <div className="group relative flex flex-col rounded-3xl bg-kumo-tint">
    <LinkButton
      href={href}
      onClick={onSelect}
      // The whole card opens the workspace, apart from the buttons over it.
      className={cn('flex flex-1 flex-col justify-between gap-8 rounded-3xl p-4 text-left text-base', HIGHLIGHT)}
    >
      <WorkspaceIcon label={workspaceLabel} />
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
        <Action>
          <WorkspaceMoreMenu title={title} href={href} triggerClassName={ACTION} />
        </Action>
      )}
      <Action shown={starred}>
        <Button
          variant="ghost"
          icon={<StarIcon weight={starred ? 'fill' : 'regular'} />}
          aria-label={`Star ${title}`}
          aria-pressed={starred}
          onClick={() => onStarredChange(!starred)}
          className={ACTION}
        />
      </Action>
    </span>
  </div>
)
