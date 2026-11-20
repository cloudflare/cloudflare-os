import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AuthenticatedApi, ChatReadState } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { useUnread } from '@/notifications/UnreadContext'
import { useApi } from '@/rpc/ApiContext'
import { RecentChats } from '@/workspaces/RecentChatsStore'
import { RecentChatsContext } from '@/workspaces/RecentChatsContext'
import { RECENT_FOR, TAIL_LENGTH, tailOf, tailsWanted, type ChatTail, type WorkspaceChatsReading } from '@/workspaces/recentChats'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { AgentsWaiting, waitingOf } from './AgentsWaiting'
import { AgentsWaitingContext } from './AgentsWaitingContext'

// How often they are asked again while the app is open.
const AGAIN = 2 * 60_000

// The last messages of the chats worth reading them of, that have changed since they were read,
// one at a time, as each wakes nothing more than the workspace already is. One that cannot be read
// is listed without them.
const readTails = async (overseer: ReturnType<RpcStub<AuthenticatedApi>['openWorkspace']>, workspaceId: string, reading: WorkspaceChatsReading, store: RecentChats, viewerId: string) => {
  const tails = new Map<number, ChatTail>()
  for (const chat of tailsWanted(reading, Date.now())) {
    if (!store.needsTail(workspaceId, chat)) continue
    try {
      const { messages } = await overseer.getChatHistory(chat.id, undefined, TAIL_LENGTH)
      tails.set(chat.id, tailOf(messages, chat.lastActive, viewerId))
    } catch {
      // Listed without what it said.
    }
  }
  return tails
}

/**
 * Asks the user's recently active workspaces, those they may build in, how many of their agents'
 * runs and of their chats are waiting on them, for the sidebar: on opening, and again every little
 * while. Each is read through its chats and the actions waiting, both asked of it at once. The
 * same reading, with the viewer's read state there and the last messages of the latest chats, says
 * which are the viewer's recent chats (`RecentChats`), which the sidebar lists; a workspace whose
 * unread messages change is read again at once, so that a chat moves up as soon as it is written in.
 */
export const AgentsWaitingProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting, user } = useApi()
  const workspaces = useWorkspaces()
  const unread = useUnread()
  const [store] = useState(() => new AgentsWaiting())
  const [recent] = useState(() => new RecentChats())
  const viewerId = user.id

  useEffect(() => {
    if (reconnecting || workspaces.status !== 'ready') return
    const ask = () => {
      const since = Date.now() - RECENT_FOR
      const ids = workspaces.workspaces.filter(({ role, lastActive }) => role !== 'use' && lastActive.getTime() >= since).map(({ id }) => id)
      recent.expect(ids)
      store.want(ids, async (id) => {
        const overseer = api.openWorkspace(id)
        try {
          const [chats, pending, readStates] = await Promise.all([
            overseer.listChats(),
            overseer.listActions({ filter: 'pending' }),
            // Through a promise, so that a server older than read state, which throws, is one that says nothing of it.
            Promise.resolve().then(() => api.getWorkspaceUnreadState(id)).catch((): ChatReadState[] => []),
          ])
          const approvals = new Set(pending.entries.flatMap(({ state, chatId }) => (state === 'pending' && chatId !== undefined ? [chatId] : [])))
          const reading = { chats, readStates, approvals }
          // Both together, so that a chat that moved up says what moved it.
          recent.set(id, reading, await readTails(overseer, id, reading, recent, viewerId))
          return waitingOf(chats, pending.entries)
        } catch (error) {
          recent.failed(id)
          throw error
        } finally {
          overseer[Symbol.dispose]()
        }
      })
    }
    ask()
    const again = setInterval(ask, AGAIN)
    return () => {
      clearInterval(again)
      store.stop()
    }
  }, [api, reconnecting, workspaces, store, recent, viewerId])

  // A workspace whose unread messages changed has something new in one of its chats.
  const counts = unread?.totals.known ? unread.totals.workspaces : undefined
  const lastCounts = useRef<ReadonlyMap<string, number>>(undefined)
  useEffect(() => {
    if (!counts) return
    const before = lastCounts.current
    lastCounts.current = counts
    if (!before) return
    const changed = [...new Set([...before.keys(), ...counts.keys()])].filter((id) => before.get(id) !== counts.get(id))
    if (changed.length > 0) store.refresh(changed)
  }, [counts, store])

  const [recentValue] = useState(() => ({ store: recent, refresh: (id: string) => store.refresh([id]) }))

  return (
    <AgentsWaitingContext value={store}>
      <RecentChatsContext value={recentValue}>{children}</RecentChatsContext>
    </AgentsWaitingContext>
  )
}
