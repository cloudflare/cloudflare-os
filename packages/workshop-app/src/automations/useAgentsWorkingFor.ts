import { useEffect, useMemo, useRef } from 'react'
import { useChatThreads } from '@/workspaces/WorkspacesContext'
import { calledByGadget, startedInChat, type Agent } from './agents'
import { useAgents } from './useAgents'

const NONE: Agent[] = []
const latestRun = (agent: Agent) => agent.runs[0]?.lastActive.getTime() ?? 0

/** What agents work for: a gadget, which calls on them, or a chat, whose agent started their runs. */
export type AgentsTarget = { workspaceId: string } & ({ gadgetId: number; chatId?: undefined } | { chatId: number; gadgetId?: undefined })

/**
 * The agents working for a gadget or a chat, the one that ran last first, for its header to say
 * so. Read again whenever a run in its workspace moves on, as the live list of chats has it
 * (`spawnerName`), so that what the header says keeps up with them. None, for nothing.
 */
export const useAgentsWorkingFor = (target: AgentsTarget | undefined): Agent[] => {
  const workspaceId = target?.workspaceId
  const gadgetId = target?.gadgetId
  const chatId = target?.chatId
  const ids = useMemo(() => (workspaceId === undefined ? undefined : [workspaceId]), [workspaceId])
  const { state, reload } = useAgents(ids)
  const threads = useChatThreads()
  // When a run of one of the workspace's agents was last active.
  const moved = threads?.reduce((latest, thread) =>
    thread.workspaceId === workspaceId && thread.spawnerName !== undefined ? Math.max(latest, thread.latestActivityAt?.getTime() ?? 0) : latest, 0) ?? 0
  const seen = useRef(moved)
  useEffect(() => {
    if (moved === seen.current) return
    seen.current = moved
    reload()
  }, [moved, reload])
  return useMemo(
    () => {
      if (state.status !== 'ready') return NONE
      const working = gadgetId !== undefined ? calledByGadget(gadgetId) : chatId !== undefined ? startedInChat(chatId) : undefined
      return working ? state.agents.filter(working).toSorted((a, b) => latestRun(b) - latestRun(a)) : NONE
    },
    [state, gadgetId, chatId],
  )
}
