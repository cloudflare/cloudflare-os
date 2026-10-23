import { Link } from '@tanstack/react-router'
import { BellSlash, DotsThree, Star, ShareNetwork, Trash, Pencil } from '@phosphor-icons/react'
import { DropdownMenu } from '@cloudflare/kumo'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from '../menuStyles'
import { useState, useEffect, useRef } from 'react'
import type { GadgetMetadataWithTimestamps, NotificationMute } from '@gadgets/workshop-shared/api'
import { WorkspaceNotificationsMenu } from '../../features/notifications/WorkspaceNotificationsMenu'
import { describeMute } from '../../features/notifications/notificationMute'
import { isImeComposing } from '../../keyboardEvent'
import { useUnreadState } from '../../features/notifications/UnreadStateBridge'
import { UnreadBadge } from '../../features/notifications/UnreadBadge'

function initials(title: string | undefined): string {
  const t = (title || 'Untitled').trim()
  if (!t) return 'UG'
  const parts = t.split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || t.slice(0, 2).toUpperCase()
}

/**
 * One row in the sidebar's Favorites / Recent list. Compact, with a monogram avatar, a truncated
 * title, and an overflow menu (favorite, rename, share, notifications, delete). Its callbacks are
 * passed in by the parent so this row stays a pure presentational component.
 */
export default function SidebarGadgetRow({
  gadget,
  collapsed = false,
  onTogglePin,
  onRename,
  onShare,
  onNotificationMuteChange,
  onDelete,
}: {
  gadget: GadgetMetadataWithTimestamps
  collapsed?: boolean
  onTogglePin: (g: GadgetMetadataWithTimestamps) => void
  onRename: (g: GadgetMetadataWithTimestamps, newTitle: string) => void
  onShare: (g: GadgetMetadataWithTimestamps) => void
  onNotificationMuteChange: (g: GadgetMetadataWithTimestamps, mute: NotificationMute | undefined) => void
  onDelete: (g: GadgetMetadataWithTimestamps) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(gadget.title || '')
  const inputRef = useRef<HTMLInputElement>(null)
  const unread = useUnreadState()
  const unreadChats = unread?.state?.chats.filter(chat =>
    chat.workspaceId === gadget.id && chat.unreadMessageCount > 0) ?? []
  const unreadMessages = unreadChats.reduce((count, chat) => count + chat.unreadMessageCount, 0)

  useEffect(() => {
    if (renaming) inputRef.current?.focus()
  }, [renaming])

  const commit = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== gadget.title) onRename(gadget, trimmed)
    setRenaming(false)
  }

  const startRename = () => {
    setRenameValue(gadget.title || '')
    setRenaming(true)
  }

  const muteDescription = describeMute(gadget.notificationMute)

  return (
    <Link
      to="/workspace/$id"
      params={{ id: gadget.id }}
      className="group flex h-8 min-w-0 items-center gap-2 rounded-lg pl-1.5 pr-2.5 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint"
      activeProps={{ className: 'flex h-8 min-w-0 items-center gap-2 rounded-lg pl-1.5 pr-2.5 text-[13px] leading-[18px] tracking-[-0.25px] bg-kumo-fill text-kumo-strong font-medium' }}
      onClick={(e) => {
        if (renaming) e.preventDefault()
      }}
      title={collapsed ? gadget.title || 'Untitled workspace' : undefined}
    >
      <div className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-kumo-fill text-[10px] font-medium text-kumo-subtle">
        <span aria-hidden="true">{initials(gadget.title)}</span>
        {collapsed && unreadChats.length > 0 && <span
          role="img"
          aria-label={`${unreadMessages} unread ${unreadMessages === 1 ? "message" : "messages"}`}
          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-kumo-badge-blue" />}
      </div>
      {!collapsed && (
        <>
          {renaming ? (
            <input
              ref={inputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setRenaming(false)
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] tracking-[-0.25px] outline-none border-b border-kumo-brand text-kumo-default"
              onClick={(e) => e.preventDefault()}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{gadget.title || 'Untitled workspace'}</span>
          )}
          {muteDescription && (
            <BellSlash size={12} alt={muteDescription} className="shrink-0 text-kumo-inactive" />
          )}

          {/* Inside the row's <Link>: stopPropagation blocks the Link's SPA handler, so preventDefault
              is needed to stop the native <a> from navigating. */}
          <div className="relative flex h-6 min-w-6 shrink-0 items-center justify-center"
            onClick={(e) => { e.stopPropagation(); e.preventDefault() }}>
            {/* Reuse the trailing slot: a hidden actions button must not squeeze the title/badge. */}
            <span className="pointer-events-none group-hover:invisible group-focus-within:invisible">
              <UnreadBadge count={unreadMessages} />
            </span>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <button
                    type="button"
                    aria-label="Workspace actions"
                    className="absolute inset-0 flex h-6 w-full items-center justify-center rounded-md text-kumo-subtle opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-kumo-fill hover:text-kumo-default focus:opacity-100"
                  >
                    <DotsThree size={14} weight="bold" />
                  </button>
                }
              />
              <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
                <DropdownMenu.Item disabled={unreadChats.length === 0} onClick={() => {
                  void unread?.markManyRead(unreadChats).catch(() => {})
                }} className={MENU_ITEM}>Mark workspace read</DropdownMenu.Item>
                <DropdownMenu.Item
                  onClick={startRename}
                  className={MENU_ITEM}
                >
                  <Pencil size={13} className="mr-2" /> Rename
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onClick={() => onTogglePin(gadget)}
                  className={MENU_ITEM}
                >
                  <Star size={13} className="mr-2" weight={gadget.pinned ? 'fill' : 'regular'} />
                  {gadget.pinned ? 'Unfavorite' : 'Favorite'}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onClick={() => onShare(gadget)}
                  className={MENU_ITEM}
                >
                  <ShareNetwork size={13} className="mr-2" /> Share
                </DropdownMenu.Item>
                <WorkspaceNotificationsMenu
                  workspaceId={gadget.id}
                  mute={gadget.notificationMute}
                  onMuteChange={(mute) => onNotificationMuteChange(gadget, mute)}
                />
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  variant="danger"
                  onClick={() => onDelete(gadget)}
                  className={MENU_ITEM_DANGER}
                >
                  <Trash size={13} className="mr-2" />
                  {gadget.owner ? 'Dismiss' : 'Delete'}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
        </>
      )}

      {/* Collapsed rows show only the monogram (aria-hidden), so name the link for screen readers. */}
      {collapsed && <span className="sr-only">{gadget.title || 'Untitled workspace'}</span>}
    </Link>
  )
}
