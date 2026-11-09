import type { ReactNode } from 'react'
import { DropdownMenu, Tooltip } from '@cloudflare/kumo'
import { Link } from '@tanstack/react-router'
import { RoundButton, roundButtonClass } from '../../components/RoundButton'
import { AgentMark, ChatCloudMark, FolderBadge } from '../../components/icons/brandMarks'
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  CloseIcon,
  ExpandIcon,
  MoreIcon,
  ShareIcon,
  UserPlusIcon,
} from '../../components/icons/designIcons'
import { openSidebarDrawer } from '../../components/AppShell/commandPaletteBus'
import { MENU_CONTENT, MENU_POSITIONER_STYLE } from '../../components/menuStyles'
import { workspaceInitials } from '../workspaces/workspaceInitials'

/** What the chat header knows of the workspace the chat lives in. */
export type ChatHeaderWorkspace = {
  id: string
  title: string
  /** True for a workspace the user created and named, false for a chat's own implicit one. */
  named: boolean
}

/**
 * The header's way to bring people in. In a workspace it invites them to the whole workspace, so
 * it says so rather than looking like it shares only the chat; a chat on its own is shared as it.
 */
export const InviteOrShareButton = ({ workspace, onShare, className }: {
  workspace: Pick<ChatHeaderWorkspace, 'title' | 'named'>
  onShare: () => void
  className?: string
}) => workspace.named ? (
  <RoundButton label={`Invite to ${workspace.title}`} onClick={onShare} className={className}>
    <UserPlusIcon size={16} className="max-md:size-5" />
  </RoundButton>
) : (
  <RoundButton label="Share chat" onClick={onShare} className={className}>
    <ShareIcon size={16} className="max-md:size-5" />
  </RoundButton>
)

/**
 * The chat's header row (Figma "Frame 798" in "MacBook Pro 14\" - 4"): the workspace's folder
 * badge, the chat's title in a pill that opens the chat's details, and at the far end a way to
 * invite people (see `InviteOrShareButton`). On a phone (Figma "iPhone 18 Pro - 4") the badge
 * gives way to a back button to the chat list.
 */
export function ChatHeader({
  workspace,
  chatId,
  chatTitle,
  agentStarted,
  onOpenWorkspace,
  onShare,
  automations,
  trailing,
}: {
  workspace: ChatHeaderWorkspace
  chatId: number
  chatTitle: string
  agentStarted: boolean
  onOpenWorkspace: () => void
  onShare: () => void
  /** Beside the title: a way to the chat's automations, once it has some. */
  automations?: ReactNode
  /** Live state shown left of Share: who else is here, actions waiting for review. */
  trailing?: ReactNode
}) {
  return (
    <div className="flex h-[68px] shrink-0 items-center gap-2 p-4 md:h-[60px] md:p-3">
      <RoundButton label="Chats" onClick={openSidebarDrawer} className="!size-11 md:!hidden">
        <ArrowLeftIcon size={20} />
      </RoundButton>
      {workspace.named ? (
        <RoundButton
          label={`Open ${workspace.title}`}
          onClick={onOpenWorkspace}
          className="!size-9 ring-kumo-tint max-md:!hidden"
        >
          <FolderBadge initials={workspaceInitials(workspace.title)} size={24} className="text-kumo-contrast" />
        </RoundButton>
      ) : (
        // A chat outside any workspace has nowhere further to go, so its glyph is only a label.
        <span className={roundButtonClass('icon', '!size-9 cursor-default ring-kumo-tint hover:!bg-kumo-base max-md:!hidden')}>
          {agentStarted ? <AgentMark size={22} /> : <ChatCloudMark size={20} />}
        </span>
      )}
      <Link
        to="/workspace/$id"
        params={{ id: workspace.id }}
        search={{ chat: chatId, details: 'library' }}
        title={chatTitle}
        className={roundButtonClass('pill', 'h-11 min-w-0 max-w-full px-3 !text-[14px] ring-kumo-line md:!h-9 md:max-w-[min(420px,60%)] md:!text-[13px] md:ring-kumo-tint')}
      >
        <span className="truncate">{chatTitle}</span>
      </Link>
      {automations}
      <span className="flex-1" />
      {trailing && <div className="hidden items-center gap-2 md:flex">{trailing}</div>}
      <InviteOrShareButton workspace={workspace} onShare={onShare} className="max-md:!size-11" />
    </div>
  )
}

/** One of the pane's workpieces, as its switcher lists it. */
export type PaneChoice = { id: number; title: string; glyph: ReactNode; draft: boolean }

/**
 * The side pane's header (Figma "Frame 798" in "MacBook Pro 14\" - 22"): what the pane shows, in a
 * pill with its glyph, then More, Share, Full screen and Close. With several workpieces open to
 * the chat the pill switches between them.
 */
export function PaneHeader({
  glyph,
  title,
  badge,
  choices,
  activeId,
  onSelect,
  menu,
  onShare,
  shareLabel = 'Share app',
  onExpand,
  expandLabel = 'Full screen',
  onClose,
  closeLabel,
}: {
  glyph: ReactNode
  title: string
  badge?: string
  choices?: PaneChoice[]
  activeId?: number | null
  onSelect?: (id: number) => void
  /** The More menu's items, or nothing to leave the button out. */
  menu?: ReactNode
  /** Shares what the pane shows on its own; nothing leaves the button out, `false` shows it disabled. */
  onShare?: (() => void) | false
  shareLabel?: string
  /** Opens the pane full screen; nothing leaves the button out, `false` shows it disabled. */
  onExpand?: (() => void) | false
  expandLabel?: string
  onClose: () => void
  closeLabel: string
}) {
  const pill = (
    <>
      <span className="flex size-[26px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-tint text-kumo-default">
        {glyph}
      </span>
      <span className="truncate">{title}</span>
      {badge && (
        <span className="shrink-0 rounded-full bg-kumo-fill px-1.5 py-0.5 text-[10px] font-medium leading-none text-kumo-subtle">
          {badge}
        </span>
      )}
    </>
  )
  const pillClass = roundButtonClass('pill', 'min-w-0 max-w-[60%] gap-2 !pl-1.5 !pr-3 ring-kumo-line')

  return (
    <div className="flex h-[58px] shrink-0 items-center gap-2 p-3">
      {choices && choices.length > 1 && onSelect ? (
        <DropdownMenu>
          <DropdownMenu.Trigger render={
            <button type="button" className={pillClass} title={title} aria-label={`${title}: switch`}>
              {pill}
              <ChevronDownIcon size={14} className="shrink-0 text-kumo-subtle" />
            </button>
          } />
          <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="start">
            {choices.map(choice => (
              <DropdownMenu.Item
                key={choice.id}
                onClick={() => onSelect(choice.id)}
                aria-current={choice.id === activeId ? 'true' : undefined}
                className={`!h-auto gap-2 rounded-lg !px-2 !py-1.5 text-[13px] leading-[18px] text-kumo-default data-highlighted:bg-kumo-tint ${choice.id === activeId ? 'font-medium' : ''}`}
              >
                <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-kumo-tint">{choice.glyph}</span>
                <span className="min-w-0 flex-1 truncate">{choice.title}</span>
                {choice.draft && <span className="text-[11px] text-kumo-subtle">Draft</span>}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
      ) : (
        <div className={`${pillClass} cursor-default hover:!bg-kumo-base`} title={title}>{pill}</div>
      )}
      <span className="flex-1" />
      {menu && (
        <DropdownMenu>
          <DropdownMenu.Trigger render={
            <button type="button" aria-label="More" className={roundButtonClass('icon')}>
              <MoreIcon size={16} />
            </button>
          } />
          <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="end">
            {menu}
          </DropdownMenu.Content>
        </DropdownMenu>
      )}
      {onShare !== undefined && (
        // A disabled button shows no tooltip, so the reason rides on a wrapper.
        <Tooltip content={shareLabel} render={
          <span className="inline-flex">
            <button type="button" aria-label={shareLabel} onClick={onShare || undefined} disabled={onShare === false}
              className={roundButtonClass('icon')}>
              <ShareIcon size={16} />
            </button>
          </span>
        } />
      )}
      {onExpand !== undefined && (
        <RoundButton label={expandLabel} onClick={onExpand || undefined} disabled={onExpand === false} className="max-md:!hidden">
          <ExpandIcon size={16} />
        </RoundButton>
      )}
      <RoundButton label={closeLabel} onClick={onClose}>
        <CloseIcon size={16} />
      </RoundButton>
    </div>
  )
}

/**
 * The surface an app, its code or its connections sit on inside the pane (Figma "Todo App UI"): a
 * sheet with rounded top corners and a hairline. The design also draws a grab handle on it, which
 * is left out: nothing drags the sheet, so it would only sit over the app's own content.
 */
export function PaneSheet({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-2xl bg-kumo-base ring-1 ring-kumo-tint">
      {children}
    </div>
  )
}
