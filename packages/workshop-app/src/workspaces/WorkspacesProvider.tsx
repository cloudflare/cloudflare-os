import { useEffect, useState, type ReactNode } from 'react'
import { RpcTarget } from 'capnweb'
import type { ChatReadState, NotificationMute, UnreadStateSubscriber, UnreadThread, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { WorkspacesContext, type WorkspacesState } from './WorkspacesContext'

// How long after a chat changes its list is read again, so a burst of messages reads it once.
const CHATS_SETTLE = 400

/**
 * What the account says as the user's chats change. Only read state comes with a change, so the
 * list is read again for the rest (a new chat, a new title, the latest message).
 */
class ChatChanges extends RpcTarget implements UnreadStateSubscriber {
  constructor(private readonly changed: (chat?: ChatReadState) => void) {
    super()
  }

  async updated() {
    this.changed()
  }

  async summaryUpdated() {}

  async chatUpdated(_workspaceId: string, _chatId: number, chat: ChatReadState | null) {
    this.changed(chat ?? undefined)
  }
}

/**
 * Loads the user's workspaces when mounted, and again on `refresh()`. The list has no live updates
 * to subscribe to, so whoever changes it asks for a reload. Their chats are listed beside them and
 * kept live through the account's read state, which never opens a workspace.
 */
export const WorkspacesProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<WorkspacesState>({ status: 'loading' })
  // Bumped by refresh() to run the loading effect again.
  const [version, setVersion] = useState(0)
  // Stable, for whoever keeps it beyond a render, such as a chat session.
  const [refresh] = useState(() => () => setVersion((v) => v + 1))
  const [chats, setChats] = useState<UnreadThread[]>()

  useEffect(() => {
    if (reconnecting) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      api.getChatThreads().then(
        (threads) => !cancelled && setChats(threads),
        // The sidebar lists workspaces alone meanwhile.
        () => !cancelled && setChats(undefined),
      )
    }
    const changed = (chat?: ChatReadState) => {
      // A chat read or unread shows at once; the rest follows with the list.
      if (chat) {
        setChats((current) => current?.map((thread) => (thread.workspaceId === chat.workspaceId && thread.chatId === chat.chatId ? { ...thread, ...chat } : thread)))
      }
      clearTimeout(timer)
      timer = setTimeout(read, CHATS_SETTLE)
    }
    read()
    const subscription = Promise.resolve(api.subscribeToUnreadState('all', new ChatChanges(changed)))
    subscription.catch(() => {})
    return () => {
      cancelled = true
      clearTimeout(timer)
      void subscription.then((held) => held[Symbol.dispose](), () => {})
    }
  }, [api, reconnecting, version])

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (reconnecting) return
    let cancelled = false
    api.listWorkspaces().then(
      (workspaces) => {
        if (cancelled) return
        const byRecentActivity = workspaces.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
        setState({ status: 'ready', workspaces: byRecentActivity })
      },
      (error) => {
        if (!cancelled) setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, version])

  const mark = (id: string, change: Partial<WorkspaceMetadataWithTimestamps>) =>
    setState((current) =>
      current.status === 'ready'
        ? { ...current, workspaces: current.workspaces.map((workspace) => (workspace.id === id ? { ...workspace, ...change } : workspace)) }
        : current,
    )
  const setPinned = async (id: string, pinned: boolean) => {
    mark(id, { pinned })
    try {
      await api.setWorkspacePinned(id, pinned)
    } catch (error) {
      mark(id, { pinned: !pinned })
      throw error
    }
  }
  const rename = async (id: string, title: string) => {
    const before = state.status === 'ready' ? state.workspaces.find((workspace) => workspace.id === id)?.title : undefined
    mark(id, { title })
    const overseer = api.openWorkspace(id)
    try {
      await overseer.setTitle(title)
    } catch (error) {
      if (before !== undefined) mark(id, { title: before })
      throw error
    } finally {
      overseer[Symbol.dispose]()
    }
  }

  const setNotificationMute = async (id: string, mute: NotificationMute | null) => {
    const before = state.status === 'ready' ? state.workspaces.find((workspace) => workspace.id === id)?.notificationMute : undefined
    mark(id, { notificationMute: mute ?? undefined })
    try {
      await api.setWorkspaceNotificationMute(id, mute)
    } catch (error) {
      mark(id, { notificationMute: before })
      throw error
    }
  }

  const remove = async (id: string) => {
    const overseer = api.openWorkspace(id)
    try {
      await overseer.deleteSelf()
    } finally {
      overseer[Symbol.dispose]()
    }
    setState((current) =>
      current.status === 'ready' ? { ...current, workspaces: current.workspaces.filter((workspace) => workspace.id !== id) } : current,
    )
  }

  const create = async (title: string) => {
    // Named, so it is listed at once rather than waiting for a first message.
    const overseer = api.newWorkspace({ kind: 'workspace', title })
    try {
      const { id } = await overseer.getMetadata()
      refresh()
      return id
    } finally {
      overseer[Symbol.dispose]()
    }
  }

  const makeWorkspace = async (id: string, title: string) => {
    const overseer = api.openWorkspace(id)
    try {
      await overseer.makeWorkspace(title)
    } finally {
      overseer[Symbol.dispose]()
    }
    mark(id, { title, kind: 'workspace' })
  }

  return <WorkspacesContext value={{ state, chats, refresh, setPinned, rename, setNotificationMute, remove, create, makeWorkspace }}>{children}</WorkspacesContext>
}
