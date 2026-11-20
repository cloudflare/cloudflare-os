import type { SidebarChat } from './SidebarChatItem'
import type { SidebarWorkspace } from './WorkspaceNav'

/** A workspace on the collapsed sidebar's rail, with the recent chats in it that the expanded sidebar lists. */
export type RailWorkspace = SidebarWorkspace & { chats: SidebarChat[] }

const marks = (chats: readonly SidebarChat[]) => ({
  unread: chats.some(({ unread, muted, workspaceMuted }) => unread && !muted && !workspaceMuted),
  attention: chats.find(({ attention }) => attention)?.attention,
})

/**
 * The rail's workspaces, which say on one icon each what the expanded sidebar lists: the pinned
 * ones first, as they are, then each workspace the recent chats are in, in the order its first
 * chat is listed. Each is marked unread, or waiting on the viewer, where it or a chat in it is.
 */
export const railWorkspacesOf = (workspaces: readonly SidebarWorkspace[], chats: readonly SidebarChat[]): RailWorkspace[] => {
  const byWorkspace = new Map<string, SidebarChat[]>()
  for (const chat of chats) byWorkspace.set(chat.workspaceId, [...(byWorkspace.get(chat.workspaceId) ?? []), chat])
  const listed = workspaces.map((workspace) => {
    const its = byWorkspace.get(workspace.id) ?? []
    const { unread, attention } = marks(its)
    return { ...workspace, unread: workspace.unread || unread, attention: workspace.attention ?? attention, chats: its }
  })
  const listedIds = new Set(workspaces.map(({ id }) => id))
  const others = [...byWorkspace].filter(([id]) => !listedIds.has(id)).map(([id, its]): RailWorkspace => {
    const [first] = its
    return {
      id,
      title: first.workspaceTitle,
      workspaceLabel: first.workspaceLabel,
      workspaceLook: first.workspaceLook,
      href: first.workspaceHref,
      muted: first.workspaceMuted,
      ...marks(its),
      chats: its,
    }
  })
  return [...listed, ...others]
}
