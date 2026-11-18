import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { agentsOf, isAskOf, targetsOf } from './askGroups'
import type { AsksOverseer } from './GadgetAsks'

/** How many asks wait on the user across their gadgets, and how many on each. */
export type WaitingSnapshot = {
  /** Each ask once, though it may be asked by two gadgets that share a connection. */
  total: number
  /** By `gadgetKey`. */
  byGadget: ReadonlyMap<string, number>
}

/** The part of a workspace's Overseer a sweep reads, and the lease that must be disposed. */
export type SweepOverseer = Pick<AsksOverseer, 'getGadget' | 'listActions' | 'listChats'> & Disposable

/** The part of the API a sweep reads. */
export type SweepApi = {
  listOutputs(): Promise<{ outputs: OutputSummary[] }>
  openWorkspace(id: string): SweepOverseer
}

export type WaitingAsksOptions = {
  /** How many workspaces are read at once. */
  concurrency?: number
  now?: () => number
}

/** What a gadget is known by among every workspace's. */
export const gadgetKey = (workspaceId: string, workpieceId: number) => `${workspaceId}/${workpieceId}`

const EMPTY: WaitingSnapshot = { total: 0, byGadget: new Map() }
const CONCURRENCY = 3

/** The ids of what waits on someone in a workspace, from every page of its pending actions. */
const pendingIn = async (overseer: SweepOverseer) => {
  const pending = []
  let beforeId: number | undefined
  do {
    const page = await overseer.listActions({ beforeId, filter: 'pending' })
    pending.push(...page.entries)
    beforeId = page.nextBeforeId
  } while (beforeId !== undefined)
  return pending
}

/**
 * What the user's gadgets wait on them for, across every workspace they build in, for the sidebar
 * and the Library to say so wherever they are. Nothing tells the app when a gadget starts to wait,
 * and the Library's index says nothing of it, so it is known two ways. A gadget shown in the pane
 * reports what it asks as it changes (`report`), live. And a sweep (`sweep`, or `refresh` once
 * what it read is old) reads each workspace's pending actions, a few at a time, and, only where
 * something waits, its chats and its gadgets' bindings, to say whose it is (`isAskOf`): a round
 * trip to every workspace, which wakes each one. What a gadget asks from a chat is that chat's,
 * and is not counted. A workspace that could not be read keeps what was known of it.
 * Observable through `subscribe`/`getSnapshot`.
 */
export class WaitingAsks {
  #snapshot: WaitingSnapshot = EMPTY
  #listeners = new Set<() => void>()
  // By workspace, then gadget: the ids each asks.
  #known = new Map<string, Map<number, readonly number[]>>()
  // Shown in the pane, whose reports are newer than any sweep's.
  #live = new Set<string>()
  #sweeping: Promise<void> | undefined
  #sweptAt: number | undefined

  constructor(private readonly api: () => SweepApi, private readonly options: WaitingAsksOptions = {}) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  /** What one gadget asks now, by id, as it is shown: it is live until `release`. */
  report = (workspaceId: string, workpieceId: number, ids: readonly number[]) => {
    this.#live.add(gadgetKey(workspaceId, workpieceId))
    this.#set(workspaceId, workpieceId, ids)
    this.#publish()
  }

  /** The gadget is no longer shown: what it last said stands until the next sweep. */
  release = (workspaceId: string, workpieceId: number) => {
    this.#live.delete(gadgetKey(workspaceId, workpieceId))
  }

  /** Sweeps again when the last was longer ago than `maxAgeMs`, or there has been none. */
  refresh = (maxAgeMs: number) => {
    if (this.#sweptAt !== undefined && this.#now() - this.#sweptAt < maxAgeMs) return this.#sweeping ?? Promise.resolve()
    return this.sweep()
  }

  /** Reads every workspace the user builds in that has made something, a few at a time. */
  sweep = () => {
    this.#sweeping ??= this.#sweep().finally(() => {
      this.#sweeping = undefined
    })
    return this.#sweeping
  }

  async #sweep() {
    const api = this.api()
    let outputs: OutputSummary[]
    try {
      ;({ outputs } = await api.listOutputs())
    } catch {
      return
    }
    this.#sweptAt = this.#now()
    // Someone who only uses a workspace decides nothing in it.
    const byWorkspace = new Map<string, number[]>()
    for (const { workspaceId, workpieceId, role } of outputs) {
      if (role === 'use') continue
      byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), workpieceId])
    }
    // Gone from the library, so asking nothing that it can be told of.
    for (const workspaceId of this.#known.keys()) if (!byWorkspace.has(workspaceId)) this.#known.delete(workspaceId)
    const queue = [...byWorkspace]
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await this.#read(api, ...next)
    }
    await Promise.all(Array.from({ length: this.options.concurrency ?? CONCURRENCY }, worker))
    this.#publish()
  }

  async #read(api: SweepApi, workspaceId: string, gadgetIds: number[]) {
    let overseer: SweepOverseer | undefined
    try {
      overseer = api.openWorkspace(workspaceId)
      const pending = await pendingIn(overseer)
      if (pending.length === 0) {
        for (const id of gadgetIds) this.#sweptSet(workspaceId, id, [])
        return
      }
      const reading = overseer
      const [chats, ...bindings] = await Promise.all([
        reading.listChats(),
        ...gadgetIds.map(async (id) => {
          const gadget = reading.getGadget(id)
          try {
            return await gadget.listBindings()
          } finally {
            gadget[Symbol.dispose]()
          }
        }),
      ])
      gadgetIds.forEach((id, index) => {
        const targets = targetsOf(bindings[index])
        const scope = { targets, agents: agentsOf(chats, targets) }
        this.#sweptSet(workspaceId, id, pending.filter((entry) => isAskOf(entry, scope)).map((entry) => entry.id))
      })
    } catch {
      // What was known of it stands.
    } finally {
      overseer?.[Symbol.dispose]()
    }
    this.#publish()
  }

  #sweptSet(workspaceId: string, workpieceId: number, ids: readonly number[]) {
    if (!this.#live.has(gadgetKey(workspaceId, workpieceId))) this.#set(workspaceId, workpieceId, ids)
  }

  #set(workspaceId: string, workpieceId: number, ids: readonly number[]) {
    let gadgets = this.#known.get(workspaceId)
    if (!gadgets) this.#known.set(workspaceId, (gadgets = new Map()))
    gadgets.set(workpieceId, ids)
  }

  #publish() {
    let total = 0
    const byGadget = new Map<string, number>()
    for (const [workspaceId, gadgets] of this.#known) {
      const asked = new Set<number>()
      for (const [workpieceId, ids] of gadgets) {
        if (ids.length > 0) byGadget.set(gadgetKey(workspaceId, workpieceId), ids.length)
        for (const id of ids) asked.add(id)
      }
      total += asked.size
    }
    const before = this.#snapshot
    if (before.total === total && before.byGadget.size === byGadget.size && [...byGadget].every(([key, count]) => before.byGadget.get(key) === count)) return
    this.#snapshot = { total, byGadget }
    for (const listener of this.#listeners) listener()
  }

  #now() {
    return this.options.now?.() ?? Date.now()
  }
}
