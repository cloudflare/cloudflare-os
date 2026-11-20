import { BellSlashIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { ShimmerText } from '@/components/ShimmerText'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { UnreadDot } from './UnreadDot'

/** One of the viewer's recent chats, as the sidebar lists it. */
export type SidebarChat = {
  /** Unique among the chats listed: its workspace's id and its own. */
  id: string
  workspaceId: string
  title: string
  workspaceTitle: string
  workspaceLabel: string
  /** How its workspace's icon is drawn, when not as any workspace's is. */
  workspaceLook?: WorkspaceLook
  /** When it was last active, in a few letters: "5m", "2d". */
  time: string
  /** Its latest message as plain words. */
  preview?: string
  /** Who said it, where that is not the chat's own assistant: "Maya", "You". */
  speaker?: string
  /** What in it waits on the viewer, in words: "Needs approval". Said before the preview, which is then what it asks, in place of its workspace. */
  attention?: string
  /** Its agent is at work. */
  working?: boolean
  unread?: boolean
  /** The viewer muted it. */
  muted?: boolean
  /** The viewer muted its workspace. */
  workspaceMuted?: boolean
  /** Its workspace is pinned to the sidebar. */
  workspacePinned?: boolean
  /** The chat's address, so that it can be opened in another tab. */
  href?: string
  /** Its workspace's address. */
  workspaceHref?: string
}

export type SidebarChatItemProps = SidebarChat & {
  selected?: boolean
  onSelect: () => void
  /** Only the chat's title and what it says, as in a card of one workspace's chats, where the icon would say it again. */
  compact?: boolean
}

/**
 * One of the viewer's recent chats in the sidebar: its workspace's icon, its title and when it was
 * last active, and under them its workspace and latest message, or what waits on the viewer in it.
 * At its end, the dot of what waits or is unread, or that it is muted, which then marks nothing.
 */
export const SidebarChatItem = ({
  id,
  title,
  workspaceTitle,
  workspaceLabel,
  workspaceLook,
  time,
  preview,
  speaker,
  attention,
  working,
  unread,
  muted,
  workspaceMuted,
  selected,
  href,
  onSelect,
  compact = false,
}: SidebarChatItemProps) => {
  const quiet = muted || workspaceMuted
  const said = preview && (speaker ? `${speaker}: ${preview}` : preview)
  const where = compact ? said : [workspaceTitle, said].filter(Boolean).join(' · ')
  return (
    <LinkButton
      href={href}
      data-chat-key={id}
      onClick={onSelect}
      aria-current={selected || undefined}
      className={cn(
        // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
        "relative after:absolute after:inset-0 after:content-['']",
        'flex w-full items-center gap-3 rounded-2xl text-left text-base not-data-underlay:hover:bg-kumo-fill',
        compact ? 'px-2.5 py-2 hover:bg-kumo-fill' : 'px-3 py-3 pr-4',
        selected && 'not-data-underlay:bg-kumo-fill',
      )}
    >
      {!compact && <WorkspaceIcon label={workspaceLabel} {...workspaceLook} />}
      <span className="flex min-w-0 flex-1 flex-col leading-snug">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
          <span className="shrink-0 text-sm text-kumo-subtle tabular-nums">{time}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {attention
              ? <><span className="text-kumo-warning">{attention}</span>{preview && <span className="text-kumo-subtle"> · {preview}</span>}</>
              : working
                ? <ShimmerText className="text-kumo-subtle">Working…</ShimmerText>
                : <span className="text-kumo-subtle">{where}</span>}
          </span>
          {attention
            ? <span role="img" aria-label={attention} className="size-2 shrink-0 rounded-full bg-kumo-warning" />
            : quiet
              ? <BellSlashIcon role="img" aria-label="Muted" className="size-3.5 shrink-0 text-kumo-subtle" />
              : unread && <UnreadDot />}
        </span>
      </span>
    </LinkButton>
  )
}
