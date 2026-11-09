import { Link } from '@tanstack/react-router'
import { PencilSimpleLine } from '@phosphor-icons/react'
import type { UnreadThread } from '@gadgets/workshop-shared/api'
import { ChatGlyph, type ChatGlyphKind } from './ChatGlyph'

/**
 * One chat in the sidebar (Figma "Frame 771"): its glyph, title and latest message, with an orange
 * dot while it has unread messages, and a pencil while changes made in it wait for a decision,
 * read or not. The selected chat sits on the black-4% wash.
 */
export const RecentChatRow = ({ chat, glyph, selected }: {
  chat: UnreadThread
  glyph: ChatGlyphKind
  selected: boolean
}) => {
  const unread = chat.unreadMessageCount > 0
  const drafts = chat.draftsWaiting ?? 0
  return (
    <Link
      to="/workspace/$id"
      params={{ id: chat.workspaceId }}
      search={{ chat: chat.chatId }}
      aria-current={selected ? 'page' : undefined}
      className={[
        'flex h-[59px] shrink-0 items-center gap-2.5 rounded-2xl py-3 pl-3 pr-4 outline-none transition-colors max-md:h-[76px]',
        'focus-visible:ring-2 focus-visible:ring-kumo-ring',
        // Also while its right-click menu is open (see ContextMenu), as a desktop list does.
        selected ? 'bg-kumo-tint' : 'hover:bg-kumo-tint [[data-popup-open]>&]:bg-kumo-tint',
      ].join(' ')}
    >
      {/* 35px in the rail, 40px in the phone's drawer (Figma "iPhone 18 Pro - 3"). */}
      <span className="flex size-[35px] shrink-0 items-center justify-center max-md:size-10">
        <span className="max-md:scale-[1.143]"><ChatGlyph glyph={glyph} /></span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 max-md:gap-1">
        <span className="truncate text-[13px] font-medium leading-4 text-kumo-default max-md:text-[14px] max-md:leading-[17px]">{chat.chatTitle}</span>
        <span className="truncate text-[13px] leading-4 text-kumo-subtle max-md:text-[14px] max-md:leading-[17px]">
          {chat.latestMessagePreview || ' '}
        </span>
      </span>
      {drafts > 0 && (
        <span
          title={`${drafts} ${drafts === 1 ? 'change' : 'changes'} to review`}
          className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-kumo-warning-tint text-kumo-warning"
        >
          <PencilSimpleLine size={11} weight="bold" aria-hidden="true" />
          <span className="sr-only">{drafts} {drafts === 1 ? 'change' : 'changes'} to review</span>
        </span>
      )}
      {unread && (
        <span className="size-2 shrink-0 rounded-full bg-kumo-brand">
          <span className="sr-only">Unread messages</span>
        </span>
      )}
    </Link>
  )
}
