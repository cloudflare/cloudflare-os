import { ChatsPanel } from '@/blocks/ChatsPanel'
import type { SidebarChat } from '@/blocks/SidebarChatRow'
import { SidebarWorkspaceChats } from '@/blocks/SidebarWorkspaceChats'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { groupByTime } from '@/chat/timeGroups'
import { useSidebarChats } from './useSidebarChats'

/** How the sidebar's chats go places: each address, and going there in place. */
export type SidebarChatLinks = {
  chatHref: (chatId: number) => string
  onOpenChat: (chat: SidebarChat) => void
  workspaceHref: string
  onOpenWorkspace: () => void
  newChatHref: string
  onNewChat: () => void
}

type Common = {
  workspaceId: string
  /** The viewer may build in the workspace, and so has read state in it. */
  builds: boolean
  currentChatId?: number
  links: SidebarChatLinks
}

/** A workspace's chats under it in the sidebar (`SidebarWorkspaceChats`), read once it is expanded. */
export const SidebarChats = ({ workspaceId, builds, currentChatId, links }: Common) => {
  const data = useSidebarChats(workspaceId, builds, links.chatHref)
  return (
    <SidebarWorkspaceChats
      state={data}
      currentChatId={currentChatId}
      onOpenChat={links.onOpenChat}
      allChats={{ href: links.workspaceHref, onOpen: links.onOpenWorkspace }}
      newChat={{ href: links.newChatHref, onOpen: links.onNewChat }}
    />
  )
}

/** A workspace's chats in the panel beside the sidebar (`ChatsPanel`), by when. */
export const WorkspaceChatsPanel = ({
  workspaceId,
  builds,
  currentChatId,
  links,
  workspace,
  onClose,
}: Common & { workspace: { title: string; workspaceLabel: string; workspaceLook?: WorkspaceLook }; onClose: () => void }) => {
  const data = useSidebarChats(workspaceId, builds, links.chatHref)
  const state = data.status === 'ready'
    ? {
        status: 'ready' as const,
        groups: groupByTime(data.chats.map((chat) => ({ value: chat, at: chat.lastActive }))).map(({ key, label, entries }) => ({
          key,
          label,
          chats: entries.map(({ value }) => value),
        })),
      }
    : data
  return (
    <ChatsPanel
      workspace={{ ...workspace, href: links.workspaceHref, onOpen: links.onOpenWorkspace }}
      state={state}
      currentChatId={currentChatId}
      onOpenChat={links.onOpenChat}
      onNewChat={links.onNewChat}
      onClose={onClose}
    />
  )
}
