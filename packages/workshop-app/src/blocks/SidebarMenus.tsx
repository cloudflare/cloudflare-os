import {
  ArrowSquareOutIcon,
  BellIcon,
  BellSlashIcon,
  ChatCircleIcon,
  CheckIcon,
  EnvelopeSimpleIcon,
  FolderIcon,
  PlusIcon,
  PushPinIcon,
  PushPinSlashIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'
import type { SidebarChat } from './SidebarChatItem'

/** How long a workspace is muted for: an hour, until tomorrow morning, or until it is unmuted. */
export type MuteLength = 'hour' | 'tomorrow' | 'always'

/** What can be done from the sidebar to what it lists, each only where it is given. */
export type SidebarActions = {
  onOpenWorkspace: (workspaceId: string) => void
  onPinWorkspace?: (workspaceId: string, pinned: boolean) => void
  /** Mutes a workspace for as long as is chosen, or unmutes it with `null`. */
  onMuteWorkspace?: (workspaceId: string, length: MuteLength | null) => void
  onMarkWorkspaceRead?: (workspaceId: string) => void
  onNewChat?: (workspaceId: string) => void
  onMuteChat?: (chat: SidebarChat, muted: boolean) => void
  onMarkChatRead?: (chat: SidebarChat, read: boolean) => void
  /** Takes a chat out of the sidebar, until it needs the viewer again. */
  onHideChat?: (chat: SidebarChat) => void
}

/** A workspace as its menu says it: whether it is pinned, muted, or has anything unread. */
export type MenuWorkspace = { id: string; pinned?: boolean; muted?: boolean; unread?: boolean; href?: string }

const openInNewTab = (href: string) => window.open(href, '_blank', 'noopener')

const MuteWorkspaceItems = ({ workspace, actions }: { workspace: MenuWorkspace; actions: SidebarActions }) =>
  workspace.muted
    ? <DropdownMenu.Item icon={BellIcon} onSelect={() => actions.onMuteWorkspace?.(workspace.id, null)}>Unmute workspace</DropdownMenu.Item>
    : (
        <>
          <DropdownMenu.Item onSelect={() => actions.onMuteWorkspace?.(workspace.id, 'hour')}>For 1 hour</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => actions.onMuteWorkspace?.(workspace.id, 'tomorrow')}>Until tomorrow</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => actions.onMuteWorkspace?.(workspace.id, 'always')}>Until I turn it back on</DropdownMenu.Item>
        </>
      )

const PinItem = ({ workspace, actions }: { workspace: MenuWorkspace; actions: SidebarActions }) =>
  actions.onPinWorkspace && (
    <DropdownMenu.Item icon={workspace.pinned ? PushPinSlashIcon : PushPinIcon} onSelect={() => actions.onPinWorkspace?.(workspace.id, !workspace.pinned)}>
      {workspace.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
    </DropdownMenu.Item>
  )

/**
 * What a chat's menu in the sidebar has: opening it elsewhere, marking it read or unread and going
 * to its workspace; pinning its workspace and muting either; and taking it out of the sidebar.
 */
export const ChatMenuItems = ({ chat, actions }: { chat: SidebarChat; actions: SidebarActions }) => {
  const workspace: MenuWorkspace = { id: chat.workspaceId, pinned: chat.workspacePinned, muted: chat.workspaceMuted }
  return (
    <>
      {chat.href && <DropdownMenu.Item icon={ArrowSquareOutIcon} onSelect={() => openInNewTab(chat.href!)}>Open in new tab</DropdownMenu.Item>}
      {actions.onMarkChatRead && (
        chat.unread
          ? <DropdownMenu.Item icon={CheckIcon} onSelect={() => actions.onMarkChatRead?.(chat, true)}>Mark as read</DropdownMenu.Item>
          : <DropdownMenu.Item icon={EnvelopeSimpleIcon} onSelect={() => actions.onMarkChatRead?.(chat, false)}>Mark as unread</DropdownMenu.Item>
      )}
      <DropdownMenu.Item icon={FolderIcon} onSelect={() => actions.onOpenWorkspace(chat.workspaceId)}>Go to workspace</DropdownMenu.Item>
      <DropdownMenu.Separator />
      <PinItem workspace={workspace} actions={actions} />
      {/* What is muted is unmuted as it is; the rest is muted from one item. */}
      {actions.onMuteChat && chat.muted && <DropdownMenu.Item icon={BellIcon} onSelect={() => actions.onMuteChat?.(chat, false)}>Unmute chat</DropdownMenu.Item>}
      {actions.onMuteWorkspace && chat.workspaceMuted && <MuteWorkspaceItems workspace={workspace} actions={actions} />}
      {((actions.onMuteChat && !chat.muted) || (actions.onMuteWorkspace && !chat.workspaceMuted)) && (
        <DropdownMenu.Submenu label="Mute" icon={BellSlashIcon}>
          {actions.onMuteChat && !chat.muted && <DropdownMenu.Item icon={ChatCircleIcon} onSelect={() => actions.onMuteChat?.(chat, true)}>This chat</DropdownMenu.Item>}
          {actions.onMuteWorkspace && !chat.workspaceMuted && (
            <DropdownMenu.Submenu label="This workspace" icon={FolderIcon}>
              <MuteWorkspaceItems workspace={workspace} actions={actions} />
            </DropdownMenu.Submenu>
          )}
        </DropdownMenu.Submenu>
      )}
      {actions.onHideChat && (
        <>
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon={XCircleIcon} onSelect={() => actions.onHideChat?.(chat)}>Remove from sidebar</DropdownMenu.Item>
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
      workspace.muted
        ? <MuteWorkspaceItems workspace={workspace} actions={actions} />
        : (
            <DropdownMenu.Submenu label="Mute workspace" icon={BellSlashIcon}>
              <MuteWorkspaceItems workspace={workspace} actions={actions} />
            </DropdownMenu.Submenu>
          )
    )}
  </>
)
