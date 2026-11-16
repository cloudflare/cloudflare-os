import { useEffect, useMemo, useRef } from 'react'
import { useChatThreads } from '@/workspaces/WorkspacesContext'
import { calledByGadget, type Agent } from './agents'
import { useAgents } from './useAgents'

const NONE: Agent[] = []
const latestRun = (agent: Agent) => agent.runs[0]?.lastActive.getTime() ?? 0

/**
 * The agents a gadget calls on, the one that ran last first, for its header to say they are
 * working for it. Read again whenever a run in its workspace moves on, as the live list of chats
 * has it (`spawnerName`), so that what the header says keeps up with them. None, for no gadget.
 */
export const useGadgetAgents = (gadget: { workspaceId: string; workpieceId: number } | undefined): Agent[] => {
  const workspaceId = gadget?.workspaceId
  const workpieceId = gadget?.workpieceId
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
    () => (workpieceId === undefined || state.status !== 'ready' ? NONE : state.agents.filter(calledByGadget(workpieceId)).toSorted((a, b) => latestRun(b) - latestRun(a))),
    [state, workpieceId],
  )
}
