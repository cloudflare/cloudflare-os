import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { agentKeyOf } from './agents'

/** An agent one of a chat's gadgets starts, by its page's key and the name it was made with. */
export type GadgetAgent = { key: string; name: string }

const NONE: GadgetAgent[] = []

/**
 * The agents `gadgetIds` start, for a chat's or a gadget's header: the workspace's agent spawners
 * bound to any of them (`listAgentSpawners(chatId)`, so that in a chat its own bindings not kept
 * yet count), each named as it was made, as the workspace's Agents tab names them. Read again as
 * `read` changes, as when a turn ends, which may have given a gadget one. Empty until read, or
 * where it could not be.
 */
export const useGadgetAgents = (workspaceId: string | undefined, chatId: number | undefined, gadgetIds: readonly number[], read?: unknown) => {
  const { api, reconnecting } = useApi()
  const [agents, setAgents] = useState(NONE)
  // As a string, so that the same gadgets in a new array read nothing again.
  const ids = [...new Set(gadgetIds)].toSorted((a, b) => a - b).join(',')

  useEffect(() => {
    if (!ids || !workspaceId || reconnecting) return
    let current = true
    const overseer = api.openWorkspace(workspaceId)
    const gadgets = new Set(ids.split(',').map(Number))
    overseer.listAgentSpawners(chatId)
      .then((spawners) => {
        if (!current) return
        const next = spawners
          .filter(({ bindings }) => bindings.some(({ gadgetId }) => gadgets.has(gadgetId)))
          .map(({ id, config }) => ({ key: agentKeyOf(id), name: config.displayName }))
        setAgents((before) => (next.length === before.length && next.every(({ key, name }, index) => before[index]?.key === key && before[index]?.name === name) ? before : next))
      })
      .catch(() => {})
      .finally(() => overseer[Symbol.dispose]())
    return () => {
      current = false
    }
  }, [api, reconnecting, workspaceId, chatId, ids, read])

  return ids && workspaceId ? agents : NONE
}
