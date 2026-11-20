import {
  ArrowSquareOutIcon,
  BellIcon,
  BellSlashIcon,
  ChatCircleIcon,
  CheckIcon,
  EyeSlashIcon,
  FolderIcon,
  PlusIcon,
  PushPinIcon,
  PushPinSlashIcon,
} from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'
import type { SidebarChat } from './SidebarChatItem'

/** What can be done from the sidebar to what it lists, each only where it is given. */
export type SidebarActions = {
  onOpenWorkspace: (workspaceId: string) => void
  /** Pins a workspace, at a place among the pinned (`at`, else first), or unpins it. */
  onPinWorkspace?: (workspaceId: string, pinned: boolean, at?: number) => void
  /** Mutes a workspace until it is unmuted, or unmutes it. */
  onMuteWorkspace?: (workspaceId: string, muted: boolean) => void
  onMarkWorkspaceRead?: (workspaceId: string) => void
  onNewChat?: (workspaceId: string) => void
  onMuteChat?: (chat: SidebarChat, muted: boolean) => void
  /** Takes a chat out of the sidebar, until it needs the viewer again. */
  onHideChat?: (chat: SidebarChat) => void
}

/** A workspace as its menu says it: whether it is pinned, muted, or has anything unread. */
export type MenuWorkspace = { id: string; pinned?: boolean; muted?: boolean; unread?: boolean; href?: string }

const openInNewTab = (href: string) => window.open(href, '_blank', 'noopener')


const PinItem = ({ workspace, actions }: { workspace: MenuWorkspace; actions: SidebarActions }) =>
  actions.onPinWorkspace && (
    <DropdownMenu.Item icon={workspace.pinned ? PushPinSlashIcon : PushPinIcon} onSelect={() => actions.onPinWorkspace?.(workspace.id, !workspace.pinned)}>
      {workspace.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
    </DropdownMenu.Item>
  )

/**
 * What a chat's menu in the sidebar has: opening it elsewhere and going to its workspace; pinning its
 * workspace and muting either; and hiding it from the sidebar.
 */
export const ChatMenuItems = ({ chat, actions }: { chat: SidebarChat; actions: SidebarActions }) => {
  const workspace: MenuWorkspace = { id: chat.workspaceId, pinned: chat.workspacePinned, muted: chat.workspaceMuted }
  return (
    <>
      {chat.href && <DropdownMenu.Item icon={ArrowSquareOutIcon} onSelect={() => openInNewTab(chat.href!)}>Open in new tab</DropdownMenu.Item>}
      <DropdownMenu.Item icon={FolderIcon} onSelect={() => actions.onOpenWorkspace(chat.workspaceId)}>Go to workspace</DropdownMenu.Item>
      <DropdownMenu.Separator />
      <PinItem workspace={workspace} actions={actions} />
      {/* What is muted is unmuted as it is; the rest is muted from one item. */}
      {actions.onMuteChat && !chat.ghost && chat.muted && <DropdownMenu.Item icon={BellIcon} onSelect={() => actions.onMuteChat?.(chat, false)}>Unmute chat</DropdownMenu.Item>}
      {actions.onMuteWorkspace && chat.workspaceMuted && <DropdownMenu.Item icon={BellIcon} onSelect={() => actions.onMuteWorkspace?.(chat.workspaceId, false)}>Unmute workspace</DropdownMenu.Item>}
      {((actions.onMuteChat && !chat.ghost && !chat.muted) || (actions.onMuteWorkspace && !chat.workspaceMuted)) && (
        <DropdownMenu.Submenu label="Mute" icon={BellSlashIcon}>
          {actions.onMuteChat && !chat.ghost && !chat.muted && <DropdownMenu.Item icon={ChatCircleIcon} onSelect={() => actions.onMuteChat?.(chat, true)}>This chat</DropdownMenu.Item>}
          {actions.onMuteWorkspace && !chat.workspaceMuted && <DropdownMenu.Item icon={FolderIcon} onSelect={() => actions.onMuteWorkspace?.(chat.workspaceId, true)}>This workspace</DropdownMenu.Item>}
        </DropdownMenu.Submenu>
      )}
      {/* One not among the recent chats is muted from the chat itself, and has nothing to hide. */}
      {actions.onHideChat && !chat.ghost && (
        <>
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon={EyeSlashIcon} onSelect={() => actions.onHideChat?.(chat)}>Hide from sidebar</DropdownMenu.Item>
        </>
      )}
    </>
  )
}

/** What a workspace's menu in the sidebar has: opening it elsewhere, a new chat in it, marking it read, pinning and muting it. */
export const WorkspaceMenuItems = ({ workspace, actions }: { workspace: MenuWorkspace; actions: SidebarActions }) => (
  <>
    {workspace.href && <DropdownMenu.Item icon={ArrowSquareOutIcon} onSelect={() => openInNewTab(workspace.href!)}>Open in new tab</DropdownMenu.Item>}
    {actions.onNewChat && <DropdownMenu.Item icon={PlusIcon} onSelect={() => actions.onNewChat?.(workspace.id)}>New chat here</DropdownMenu.Item>}
    {actions.onMarkWorkspaceRead && workspace.unread && (
      <DropdownMenu.Item icon={CheckIcon} onSelect={() => actions.onMarkWorkspaceRead?.(workspace.id)}>Mark all as read</DropdownMenu.Item>
    )}
    <DropdownMenu.Separator />
    <PinItem workspace={workspace} actions={actions} />
    {actions.onMuteWorkspace && (
      <DropdownMenu.Item icon={workspace.muted ? BellIcon : BellSlashIcon} onSelect={() => actions.onMuteWorkspace?.(workspace.id, !workspace.muted)}>
        {workspace.muted ? 'Unmute workspace' : 'Mute workspace'}
      </DropdownMenu.Item>
    )}
  </>
)
