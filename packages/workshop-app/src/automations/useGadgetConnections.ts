import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'

const NONE: ReadonlyMap<number, ReadonlySet<number>> = new Map()

/**
 * What each of `gadgetIds` is bound to (`listBindings()`, their targets), by the gadget's id, for
 * putting what waits outside any chat down to the automation that runs it (`asksOfAutomations`).
 * Read again as `read` changes, as when something new waits; a gadget that could not be read is
 * left out. Empty until read, or with no gadgets.
 */
export const useGadgetConnections = (workspaceId: string, gadgetIds: readonly number[], read?: unknown) => {
  const { api, reconnecting } = useApi()
  const [connections, setConnections] = useState(NONE)
  // As a string, so that the same gadgets in a new array read nothing again.
  const ids = [...new Set(gadgetIds)].toSorted((a, b) => a - b).join(',')

  useEffect(() => {
    if (!ids || reconnecting) return
    let current = true
    const overseer = api.openWorkspace(workspaceId)
    const gadgets = ids.split(',').map((id) => [Number(id), overseer.getGadget(Number(id))] as const)
    void Promise.allSettled(gadgets.map(async ([id, gadget]) => [id, new Set((await gadget.listBindings()).map(({ target }) => target))] as const))
      .then((results) => {
        if (current) setConnections(new Map(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))))
      })
      .finally(() => {
        for (const [, gadget] of gadgets) gadget[Symbol.dispose]()
        overseer[Symbol.dispose]()
      })
    return () => {
      current = false
    }
  }, [api, reconnecting, workspaceId, ids, read])

  return ids ? connections : NONE
}
