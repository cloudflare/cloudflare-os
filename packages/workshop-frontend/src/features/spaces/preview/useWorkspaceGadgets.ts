import { useEffect, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type {
  GadgetClient,
  Overseer,
  WorkpieceId,
  WorkpieceSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../../rpcErrors'

// Collects the workspace's gadgets until the initial listing is complete, then reports the whole
// set; later entries update it. Only permanent gadgets are reported: a pending (chat-scoped)
// gadget is a draft only its chat shows, and a worktree has nothing to render.
class PermanentGadgetsSubscriber extends RpcTarget implements WorkpiecesSubscriber {
  #known = new Map<WorkpieceId, WorkpieceSummary>()
  #ready = false
  #cancelled = false

  constructor(private readonly onChange: (gadgets: WorkpieceSummary[]) => void) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (this.#cancelled) return
    this.#known.set(summary.id, summary)
    if (this.#ready) this.#publish()
  }

  removed(id: WorkpieceId) {
    if (this.#cancelled) return
    this.#known.delete(id)
    if (this.#ready) this.#publish()
  }

  ready() {
    if (this.#cancelled) return
    this.#ready = true
    this.#publish()
  }

  cancel() {
    this.#cancelled = true
  }

  #publish() {
    this.onChange([...this.#known.values()]
      .filter(workpiece => workpiece.type === 'gadget' && workpiece.chatId === undefined)
      .toSorted((a, b) => a.id - b.id))
  }
}

/** What `useWorkspaceGadgets` reports about a workspace. */
export type WorkspaceGadgets = {
  /**
   * The workspace's permanent gadgets (no chat-pending drafts, no worktrees) with its default
   * gadget first, or the lowest id when no default is recorded (only blueprint instantiation
   * records one) or the default was deleted. The rest follow by id. Empty until `ready`.
   */
  gadgets: WorkpieceSummary[]
  /** The gadget on screen: `requestedId` when it names one of `gadgets`, else the first. */
  selectedId: WorkpieceId | null
  /** A stub for `selectedId`, or null while there is none to show. */
  gadget: RpcStub<GadgetClient> | null
  /** Whether the initial listing has arrived, telling "still listing" from "has no gadgets". */
  ready: boolean
}

/**
 * The gadgets a preview of a workspace can show, and the one it shows. `gadgets[0]` is the
 * workspace's default gadget; the others are offered beside it. `requestedId` is the viewer's
 * choice among them: an unknown or since-removed id falls back to the first, so a stale choice
 * still shows something. The stub of the gadget on screen is disposed when another replaces it,
 * and with everything else when the overseer changes or the caller unmounts.
 */
export const useWorkspaceGadgets = (
  overseer: RpcStub<Overseer> | null,
  defaultGadgetId: WorkpieceId | undefined,
  requestedId: WorkpieceId | undefined,
): WorkspaceGadgets => {
  const [listed, setListed] = useState<WorkpieceSummary[] | null>(null)
  const [gadget, setGadget] = useState<{ id: WorkpieceId; stub: RpcStub<GadgetClient> } | null>(null)

  useEffect(() => {
    setListed(null)
    if (!overseer) return
    let cancelled = false
    let subscription: RpcStub<{}> | null = null
    const subscriber = new PermanentGadgetsSubscriber((list) => { if (!cancelled) setListed(list) })
    overseer.subscribeToWorkpieces(subscriber)
      .then((resolved) => {
        if (cancelled) {
          resolved[Symbol.dispose]()
          return
        }
        subscription = resolved
      })
      .catch((err) => {
        if (!cancelled) logRpcFailure('Failed to subscribe to a previewed workspace’s gadgets:', err)
      })
    return () => {
      cancelled = true
      subscriber.cancel()
      subscription?.[Symbol.dispose]()
    }
  }, [overseer])

  const gadgets = listed === null ? [] : defaultFirst(listed, defaultGadgetId)
  const selectedId = gadgets.find(candidate => candidate.id === requestedId)?.id
    ?? gadgets[0]?.id
    ?? null

  useEffect(() => {
    if (!overseer || selectedId === null) {
      setGadget(null)
      return
    }
    // getGadget() pipelines on the overseer, so the stub is usable before the reply arrives.
    const stub = overseer.getGadget(selectedId)
    setGadget({ id: selectedId, stub })
    return () => { stub[Symbol.dispose]() }
  }, [overseer, selectedId])

  return {
    gadgets,
    selectedId,
    gadget: gadget !== null && gadget.id === selectedId ? gadget.stub : null,
    ready: listed !== null,
  }
}

// `byId` is sorted ascending, so with no default (or a deleted one) its first entry leads.
const defaultFirst = (byId: WorkpieceSummary[], defaultGadgetId: WorkpieceId | undefined) => {
  const found = byId.find(candidate => candidate.id === defaultGadgetId)
  return found === undefined ? byId : [found, ...byId.filter(candidate => candidate !== found)]
}
