import type { ReactNode } from 'react'
import { ChatCircleIcon, StarIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Avatar } from '@/components/Avatar'
import { LinkButton } from '@/components/LinkButton'
import { LogoIcon } from '@/components/LogoIcon'
import { ShimmerText } from '@/components/ShimmerText'
import { formatCost } from '@/components/usageFormat'
import { StatusPill, type StatusPillProps } from './StatusPill'
import { TypingDots } from './TypingDots'
import { UnreadDot } from './UnreadDot'

/** What a chat's picture is marked with: waiting on someone, failed, at work, or with something unread. */
export type ChatBadge = 'waiting' | 'failed' | 'working' | 'unread'

export type ChatListItemProps = {
  title: string
  /** When it was last active, as the list it is in puts it; and as a narrow screen does, where shorter ("5m"). */
  time?: string
  shortTime?: string
  /** How many of its messages the viewer has not read, marked by a dot while there are any. */
  unread?: number
  /** It stopped on a decision only a person can make, or with an action waiting to be approved. */
  waiting?: boolean
  /** Who it is by: a person, in their picture (as `fullName` has it where `name` is "You"), or an agent, in the Workshop's cloud. */
  by?: { kind: 'person' | 'agent'; name: string; fullName?: string; picture?: string }
  /**
   * Under the title: its latest message, after who said it where that is worth saying ("Inbox
   * helper: …"); or, shimmering, that it is at work.
   */
  detail?: { words: string; speaker?: string; working?: boolean }
  /**
   * How it stands, as a pill before the time, tinted with what waits on someone (`warning`), went
   * wrong (`danger`), or is there to look at (`info`).
   */
  status?: Omit<StatusPillProps, 'className'>
  /** What its picture is marked with; where left out, that something is unread. */
  badge?: ChatBadge
  /** It is starred, and the way to star it or no longer, at the end of its row. */
  favorite?: { on: boolean; onToggle: () => void }
  /** Drawn in place of a chat's picture, for a row that stands for something else, such as the workspace's apps. */
  icon?: ReactNode
  /** What the chat has cost, in dollars, shown after the time where it is given. */
  cost?: number
  /** The chat's address, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

const BADGES: Record<Exclude<ChatBadge, 'working'>, { colour: string; label: string }> = {
  waiting: { colour: 'bg-kumo-warning', label: 'Waiting on someone' },
  failed: { colour: 'bg-kumo-danger', label: 'Failed' },
  unread: { colour: 'bg-kumo-brand', label: 'Unread' },
}

// The ring that cuts a mark out of the card a row is on, in the card's colour, and in the row's as
// it is pointed at or focused, which lays a little of the contrast colour over it.
const CUT = 'ring-kumo-tint group-hover/row:ring-[color-mix(in_srgb,var(--color-kumo-tint)_95%,var(--color-kumo-contrast))] group-has-focus-visible/row:ring-[color-mix(in_srgb,var(--color-kumo-tint)_95%,var(--color-kumo-contrast))]'

// The mark on a picture, at its corner, cut out of the surface it is on.
const Badge = ({ badge }: { badge: ChatBadge }) =>
  badge === 'working'
    ? <TypingDots className={cn('absolute -end-1.5 -bottom-1 h-3.5 rounded-full bg-kumo-base px-1 text-kumo-subtle ring-2', CUT)} />
    : <span role="img" aria-label={BADGES[badge].label} className={cn('absolute end-0 bottom-0 size-2 rounded-full ring-3', CUT, BADGES[badge].colour)} />

/**
 * One chat in a workspace's list of chats. Given who it is by, or anything to say under its title,
 * it is two lines: the person's picture or the agent's cloud, marked at its corner with how it
 * stands or that something is unread; its title over its latest message, after who said it, or
 * that it is at work; and how it stands, as a pill, before when it was last active. Otherwise it is one line, with a chat's icon, a dot
 * while anything is unread and Waiting on you, in the colour of something to look at, where it is.
 * A star at the end stars it, there while it is starred and otherwise while the row is pointed at;
 * what it cost comes last, where asked for.
 */
export const ChatListItem = ({ title, time, shortTime, unread = 0, waiting = false, by, detail, status, badge, favorite, icon, cost, href, onSelect }: ChatListItemProps) => {
  const twoLines = by !== undefined || detail !== undefined
  const mark = badge ?? (unread > 0 ? 'unread' : undefined)
  const picture = by?.kind === 'person'
    ? <Avatar name={by.fullName ?? by.name} src={by.picture} className="size-8 bg-kumo-base ring-1 ring-kumo-line" />
    : by?.kind === 'agent'
      ? <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-kumo-base text-kumo-default ring-1 ring-kumo-line"><LogoIcon mono /></span>
      : icon
        ? <span className="grid size-8 place-items-center">{icon}</span>
        : <span className="grid size-8 place-items-center rounded-full bg-kumo-base ring-1 ring-kumo-line"><ChatCircleIcon aria-hidden="true" className="size-4.5 text-kumo-default" /></span>
  return (
    <div className="group/row flex items-center rounded-2xl hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5">
      <LinkButton
        href={href}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-3 text-left text-base"
      >
        {twoLines
          ? (
            <span className="relative shrink-0">
              {picture}
              {mark && <Badge badge={mark} />}
              {mark !== 'unread' && unread > 0 && <span className="sr-only">, {unread} unread</span>}
            </span>
          )
          : icon ?? <ChatCircleIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-default" />}
        <span className="flex min-w-0 flex-1 flex-col leading-snug">
          <span className="truncate font-medium text-kumo-default">{title}</span>
          {twoLines && (
            // Cut short well before the row's end, as a glance at it rather than a line to read across.
            <span className="max-w-sm truncate text-kumo-subtle">
              {detail?.working
                ? <ShimmerText>{detail.words}</ShimmerText>
                : <>{detail?.speaker && `${detail.speaker}: `}{detail?.words || '\u00a0'}</>}
            </span>
          )}
        </span>
        {!twoLines && unread > 0 && <UnreadDot count={unread} />}
        {waiting && !twoLines && <span className="shrink-0 text-kumo-warning">Waiting on you</span>}
        {/* The pill keeps close to the time, as one thing said of the chat. */}
        <span className="flex shrink-0 items-center gap-2">
          {status && <StatusPill {...status} />}
          {time && <span className={cn('text-kumo-subtle', waiting && !twoLines && 'max-md:hidden', shortTime && 'max-md:sr-only')}>{time}</span>}
          {time && shortTime && <span aria-hidden="true" className={cn('text-kumo-subtle md:hidden', waiting && !twoLines && 'hidden')}>{shortTime}</span>}
        </span>
        {cost !== undefined && <span className="shrink-0 font-mono text-sm text-kumo-subtle">{formatCost(cost)}</span>}
      </LinkButton>
      {favorite && (
        <button
          type="button"
          aria-pressed={favorite.on}
          aria-label={favorite.on ? `Unstar ${title}` : `Star ${title}`}
          title={favorite.on ? 'Unstar' : 'Star'}
          onClick={favorite.onToggle}
          // Unstarred, it takes no room until the row is pointed at or focused, and then makes its own.
          className={cn(
            'grid h-8 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-full text-kumo-subtle hover:bg-kumo-contrast/5 hover:text-kumo-default',
            favorite.on
              ? 'me-2 w-8'
              : 'w-0 opacity-0 group-hover/row:me-2 group-hover/row:w-8 group-hover/row:opacity-100 group-has-focus-visible/row:me-2 group-has-focus-visible/row:w-8 group-has-focus-visible/row:opacity-100 pointer-coarse:hidden',
          )}
        >
          <StarIcon aria-hidden="true" weight={favorite.on ? 'fill' : 'regular'} className="size-4" />
        </button>
      )}
    </div>
  )
}
