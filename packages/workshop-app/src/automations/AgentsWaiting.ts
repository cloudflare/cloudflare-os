import type { ActionLogEntry, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { isAgentRun } from './agents'

/** Reads how many of one workspace's agents' runs are waiting on a person. */
export type LoadWaiting = (workspaceId: string) => Promise<number>

// How many workspaces are asked at a time. Each is a round trip of its own that wakes the workspace.
const AT_ONCE = 3
// How long what a workspace said is taken as it is, before it is asked again.
const FRESH = 2 * 60_000

/**
 * How many of a workspace's agents' runs are waiting on a person, from its chats and the actions
 * waiting to be approved: a run stopped on a decision (`awaitingDecision`), or with an action of
 * its own waiting.
 */
export const runsWaiting = (chats: readonly AiChatMetadata[], pending: readonly ActionLogEntry[]) => {
  const withActions = new Set(pending.filter(({ state }) => state === 'pending').map(({ chatId }) => chatId))
  return chats.filter((chat) => isAgentRun(chat) && (chat.awaitingDecision || withActions.has(chat.id))).length
}

/**
 * How many of each workspace's agents' runs are waiting on a person, for the sidebar. Nothing
 * says so of the user's workspaces as a whole, so each is asked for its own, a few at a time, in
 * the order they are wanted in, and what it said is kept for a while; a workspace that is open
 * says so as it changes (`report`). One that could not be read is left unknown, and is asked
 * again the next time it is wanted.
 */
export class AgentsWaiting {
  // Replaced, never changed, so that it can be a snapshot.
  private waiting: ReadonlyMap<string, number> = new Map()
  private readonly readAt = new Map<string, number>()
  private readonly loading = new Set<string>()
  private queue: string[] = []
  private load: LoadWaiting | undefined
  private readonly listeners = new Set<() => void>()

  constructor(private readonly now: () => number = Date.now) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** How many runs wait in each workspace that has said, by its id. */
  snapshot = () => this.waiting

  /**
   * Asks the workspaces `ids`, in that order, with `load`: those that have not said, or said too
   * long ago, which stay as they were until they say again. Takes the place of what was wanted
   * before.
   */
  want(ids: string[], load: LoadWaiting) {
    this.load = load
    const now = this.now()
    this.queue = ids.filter((id) => !this.loading.has(id) && (this.readAt.get(id) ?? -Infinity) + FRESH <= now)
    this.pump()
  }

  /** What a workspace that is open says, as it changes, which is fresher than anything asked. */
  report(workspaceId: string, count: number) {
    this.readAt.set(workspaceId, this.now())
    this.set(workspaceId, count)
  }

  /** Asks no more workspaces, as when the connection is lost. Those being asked are let answer. */
  stop() {
    this.queue = []
  }

  private set(workspaceId: string, count: number) {
    if ((this.waiting.get(workspaceId) ?? 0) === count && this.waiting.has(workspaceId)) return
    this.waiting = new Map(this.waiting).set(workspaceId, count)
    for (const listener of this.listeners) listener()
  }

  private pump() {
    while (this.loading.size < AT_ONCE && this.queue.length > 0) {
      const id = this.queue.shift()!
      this.loading.add(id)
      const asked = this.now()
      this.load!(id)
        .then(
          (count) => {
            // What an open workspace said meanwhile is fresher.
            if ((this.readAt.get(id) ?? -Infinity) > asked) return
            this.readAt.set(id, this.now())
            this.set(id, count)
          },
          // Left unknown.
          () => {},
        )
        .finally(() => {
          this.loading.delete(id)
          this.pump()
        })
    }
  }
}
