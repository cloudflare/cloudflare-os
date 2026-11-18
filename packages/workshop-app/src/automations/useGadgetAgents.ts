import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { agentKeyOf } from './agents'

/** An agent one of a chat's gadgets starts, by its page's key and the name it was made with. */
export type GadgetAgent = { key: string; name: string }

const NONE: GadgetAgent[] = []

/**
 * The agents `gadgetIds` start, for a chat's or a gadget's header: each gadget's bindings
 * (`listBindings(chatId)`, so that in a chat its own not kept yet count) to a connection with no service that was made as an agent
 * spawner (`getCreationSpec()`), as the workspace's Agents tab finds them. Read again as `read`
 * changes, as when a turn ends, which may have given a gadget one. Empty until read, or where it
 * could not be.
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
    const spawnerName = async (target: number) => {
      const gatekeeper = overseer.getGatekeeperById(target)
      try {
        const spec = await gatekeeper.getCreationSpec()
        return spec.type === 'agentSpawner' ? spec.config.displayName : undefined
      } catch {
        return undefined
      } finally {
        gatekeeper[Symbol.dispose]()
      }
    }
    const gadgets = ids.split(',').map((id) => overseer.getGadget(Number(id)))
    void Promise.allSettled(gadgets.map(async (gadget) => {
      const bindings = await gadget.listBindings(chatId)
      // Only what has no service could be an agent.
      return Promise.all(bindings.filter(({ vendorId }) => vendorId === undefined).map(async ({ target }) => {
        const name = await spawnerName(target)
        return name === undefined ? [] : [{ key: agentKeyOf(target), name }]
      }))
    }))
      .then((results) => {
        if (!current) return
        const found = new Map<string, GadgetAgent>()
        for (const result of results) if (result.status === 'fulfilled') for (const agent of result.value.flat()) found.set(agent.key, agent)
        setAgents((before) => {
          const next = [...found.values()]
          return next.length === before.length && next.every(({ key, name }, index) => before[index]?.key === key && before[index]?.name === name) ? before : next
        })
      })
      .finally(() => {
        for (const gadget of gadgets) gadget[Symbol.dispose]()
        overseer[Symbol.dispose]()
      })
    return () => {
      current = false
    }
  }, [api, reconnecting, workspaceId, chatId, ids, read])

  return ids && workspaceId ? agents : NONE
}
