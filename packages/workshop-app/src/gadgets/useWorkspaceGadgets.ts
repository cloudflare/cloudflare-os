import { useEffect, useState } from 'react'
import { RpcTarget } from 'capnweb'
import type { GadgetSummary, WorkpieceId, WorkpieceSummary, WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'

/** What the server calls as a workspace's workpieces change, kept as its gadgets; `changed` hears them once all have arrived, and after each change. */
class GadgetSummaries extends RpcTarget implements WorkpiecesSubscriber {
  #gadgets = new Map<WorkpieceId, GadgetSummary>()
  #ready = false

  constructor(private readonly changed: (gadgets: ReadonlyMap<WorkpieceId, GadgetSummary>) => void) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (summary.type !== 'gadget') return
    this.#gadgets.set(summary.id, summary)
    this.#publish()
  }

  removed(id: WorkpieceId) {
    this.#gadgets.delete(id)
    this.#publish()
  }

  ready() {
    this.#ready = true
    this.#publish()
  }

  #publish() {
    if (this.#ready) this.changed(new Map(this.#gadgets))
  }
}

/**
 * A workspace's gadgets, by id, kept up to date while mounted if `wanted`: undefined until they
 * have all arrived, and while they cannot be listed. Give the calling component a `key` of the
 * workspace.
 */
export const useWorkspaceGadgets = (workspaceId: string, wanted = true): ReadonlyMap<WorkpieceId, GadgetSummary> | undefined => {
  const { api, reconnecting } = useApi()
  const [gadgets, setGadgets] = useState<ReadonlyMap<WorkpieceId, GadgetSummary>>()
  useEffect(() => {
    if (!wanted || reconnecting) return
    let current = true
    // Disposed by hand: `using` is not lowered for every browser this runs in.
    const overseer = api.openWorkspace(workspaceId)
    const subscription = overseer.subscribeToWorkpieces(new GadgetSummaries((next) => current && setGadgets(next)))
    // Gadgets only name what uses a connection, so a workspace that will not list them loses nothing else.
    subscription.catch(() => {})
    return () => {
      current = false
      subscription[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }, [api, reconnecting, workspaceId, wanted])
  return gadgets
}
