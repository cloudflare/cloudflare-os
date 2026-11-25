import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@gadgets/ui'
import { ShimmerText } from '@/components/ShimmerText'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/prefs/preferenceFields'
import { FOCUS_RING } from '@/components/focusRing'
import { TypingDots } from './TypingDots'
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
  /** Its latest message as plain words. */
  preview?: string
  /** Its latest message is still being read: its second line says so, shimmering, until it is. */
  previewLoading?: boolean
  /** Who said it, where that is not the chat's own assistant: "Maya", "You". */
  speaker?: string
  /** Its agent is at work. */
  working?: boolean
  unread?: boolean
  /** The viewer muted it, as its menu says: it is then not marked unread. */
  muted?: boolean
  /** The viewer muted its workspace, as above. */
  workspaceMuted?: boolean
  /** Its workspace is pinned to the sidebar. */
  workspacePinned?: boolean
  /** The chat's address, so that it can be opened in another tab. */
  href?: string
  /** Its workspace's address. */
  workspaceHref?: string
  /**
   * Not among the recent chats: the one open, or one left that something was said in, listed first
   * for as long as it is. `quiet`, nothing was said in it since it was opened, and it is drawn faintly.
   */
  ghost?: 'quiet' | 'active'
}

export type SidebarChatItemProps = SidebarChat & {
  selected?: boolean
  /** Its menu is open: it keeps the hover while the pointer is in the menu. */
  menuOpen?: boolean
  onSelect: () => void
  /** Without its workspace's icon, as in a card of one workspace's chats, where it would say it again. */
  compact?: boolean
}

// The ring that cuts the dots out of the row, in the sidebar's colour, and in the row's while it is
// pointed at or current, which lays a little of the contrast colour over it (`bg-kumo-fill`).
const CUT = 'ring-kumo-canvas group-hover/chat:ring-[color-mix(in_srgb,var(--color-kumo-canvas)_96%,var(--color-kumo-contrast))] group-data-underlay/chat:ring-[color-mix(in_srgb,var(--color-kumo-canvas)_96%,var(--color-kumo-contrast))]'

/**
 * One of the viewer's recent chats in the sidebar: its workspace's icon, its title, and under it its
 * latest message. Its workspace is the icon's to say. Its activity alone is marked: dots hopping at
 * the icon's corner while its agent is at work (`TypingDots`, as a workspace's list of chats has
 * them on its picture), and at its end, in the middle of the row, the dot while anything is unread,
 * unless it is muted. `compact`, with no icon, its second line is "Typing…", shimmering, while it
 * works.
 */
export const SidebarChatItem = ({
  id,
  title,
  workspaceTitle,
  workspaceLabel,
  workspaceLook,
  preview,
  previewLoading,
  speaker,
  working,
  unread,
  muted,
  workspaceMuted,
  ghost,
  selected,
  menuOpen,
  href,
  onSelect,
  compact = false,
}: SidebarChatItemProps) => {
  const quiet = muted || workspaceMuted
  const said = preview && (speaker ? `${speaker}: ${preview}` : preview)
  return (
    <LinkButton
      href={href}
      data-chat-key={id}
      data-menu-open={menuOpen || undefined}
      data-ghost={ghost}
      onClick={onSelect}
      aria-current={selected || undefined}
      className={cn(
        // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
        "relative after:absolute after:inset-0 after:content-['']",
        'group/chat flex w-full items-center gap-3 text-left not-data-underlay:hover:bg-kumo-fill', FOCUS_RING,
        // In a card, as small as a menu's lines.
        compact ? 'rounded-xl px-2 py-1.5 text-sm hover:bg-kumo-fill' : 'rounded-2xl px-3 py-3 pr-4 text-base',
        selected && 'not-data-underlay:bg-kumo-fill',
        // Faint, as only passing through, coming in whole once something is said in it.
        '*:transition-opacity *:duration-300',
        ghost === 'quiet' && '*:opacity-70',
      )}
    >
      {!compact && (
        <span data-pin-icon className="relative flex shrink-0">
          <WorkspaceIcon label={workspaceLabel} {...workspaceLook} />
          {working && <TypingDots className={cn('absolute -end-1.5 -bottom-1 h-3.5 rounded-full bg-kumo-base px-1 text-kumo-subtle ring-2 inset-ring inset-ring-kumo-line', CUT)} />}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col leading-snug">
        <span className="truncate font-medium text-kumo-default">
          {title}
          {/* What the icon says to whoever sees it. */}
          {!compact && <span className="sr-only">, in {workspaceTitle}</span>}
        </span>
        {compact && working
          // Where there is no icon to mark, its second line says it while it works.
          ? <ShimmerText className="truncate text-xs text-kumo-subtle">Typing…</ShimmerText>
          : !said && previewLoading
            ? <ShimmerText className={cn('truncate text-kumo-subtle', compact && 'text-xs')}>Loading…</ShimmerText>
            : <span className={cn('truncate text-kumo-subtle', compact && 'text-xs')}>{said}</span>}
      </span>
      {/* At the end of the row, in the middle of its two lines. */}
      {unread && !quiet && <UnreadDot />}
    </LinkButton>
  )
}
