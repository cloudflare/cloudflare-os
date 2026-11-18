import { useEffect, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { AgentsWaiting, runsWaiting } from './AgentsWaiting'
import { AgentsWaitingContext } from './AgentsWaitingContext'

// Only workspaces active this recently are asked: a run waiting on a person was active when it stopped.
const RECENT = 7 * 24 * 60 * 60_000
// How often they are asked again while the app is open.
const AGAIN = 2 * 60_000

/**
 * Asks the user's recently active workspaces, those they may build in, how many of their agents'
 * runs are waiting on them, for the sidebar: on opening, and again every little while. Each is
 * read through its chats and the actions waiting, both asked of it at once.
 */
export const AgentsWaitingProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const workspaces = useWorkspaces()
  const [store] = useState(() => new AgentsWaiting())

  useEffect(() => {
    if (reconnecting || workspaces.status !== 'ready') return
    const ask = () => {
      const since = Date.now() - RECENT
      const ids = workspaces.workspaces.filter(({ role, lastActive }) => role !== 'use' && lastActive.getTime() >= since).map(({ id }) => id)
      store.want(ids, async (id) => {
        const overseer = api.openWorkspace(id)
        try {
          const [chats, pending] = await Promise.all([overseer.listChats(), overseer.listActions({ filter: 'pending' })])
          return runsWaiting(chats, pending.entries)
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
  }, [api, reconnecting, workspaces, store])

  return <AgentsWaitingContext value={store}>{children}</AgentsWaitingContext>
}
