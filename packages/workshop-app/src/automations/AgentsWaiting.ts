import type { ActionLogEntry, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { isAgentRun } from './agents'

/**
 * What in a workspace is waiting on a person: its agents' runs, and the chats people had with its
 * agent, each stopped on a decision or with an action waiting to be approved.
 */
export type WorkspaceWaiting = { runs: number; chats: number }

/** Reads what in one workspace is waiting on a person. */
export type LoadWaiting = (workspaceId: string) => Promise<WorkspaceWaiting>

// How many workspaces are asked at a time. Each is a round trip of its own that wakes the workspace.
const AT_ONCE = 3
// How long what a workspace said is taken as it is, before it is asked again.
const FRESH = 2 * 60_000

/**
 * How many of a workspace's agents' runs are waiting on a person, from its chats and the actions
 * waiting to be approved: a run stopped on a decision (`awaitingDecision`), or with an action of
 * its own waiting.
 */
export const runsWaiting = (chats: readonly AiChatMetadata[], pending: readonly ActionLogEntry[]) => waitingOf(chats, pending).runs

/**
 * What in a workspace is waiting on a person, from its chats and the actions waiting to be
 * approved: a chat stopped on a decision (`awaitingDecision`), or with an action of its own
 * waiting, counted among its agents' runs or the chats people had, as it is either.
 */
export const waitingOf = (chats: readonly AiChatMetadata[], pending: readonly ActionLogEntry[]): WorkspaceWaiting => {
  const withActions = new Set(pending.filter(({ state }) => state === 'pending').map(({ chatId }) => chatId))
  const waiting = chats.filter((chat) => chat.awaitingDecision || withActions.has(chat.id))
  const runs = waiting.filter(isAgentRun).length
  return { runs, chats: waiting.length - runs }
}

const NOTHING: WorkspaceWaiting = { runs: 0, chats: 0 }

/**
 * What in each workspace is waiting on a person (`WorkspaceWaiting`), for the sidebar. Nothing
 * says so of the user's workspaces as a whole, so each is asked for its own, a few at a time, in
 * the order they are wanted in, and what it said is kept for a while; a workspace that is open
 * says so as it changes (`report`). One that could not be read is left unknown, and is asked
 * again the next time it is wanted.
 */
export class AgentsWaiting {
  // Replaced, never changed, so that it can be a snapshot.
  private waiting: ReadonlyMap<string, WorkspaceWaiting> = new Map()
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

  /** What waits in each workspace that has said, by its id. */
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
  report(workspaceId: string, waiting: WorkspaceWaiting) {
    this.readAt.set(workspaceId, this.now())
    this.set(workspaceId, waiting)
  }

  /** Asks no more workspaces, as when the connection is lost. Those being asked are let answer. */
  stop() {
    this.queue = []
  }

  private set(workspaceId: string, waiting: WorkspaceWaiting) {
    const was = this.waiting.get(workspaceId) ?? NOTHING
    if (this.waiting.has(workspaceId) && was.runs === waiting.runs && was.chats === waiting.chats) return
    this.waiting = new Map(this.waiting).set(workspaceId, waiting)
    for (const listener of this.listeners) listener()
  }

  private pump() {
    while (this.loading.size < AT_ONCE && this.queue.length > 0) {
      const id = this.queue.shift()!
      this.loading.add(id)
      const asked = this.now()
      this.load!(id)
        .then(
          (waiting) => {
            // What an open workspace said meanwhile is fresher.
            if ((this.readAt.get(id) ?? -Infinity) > asked) return
            this.readAt.set(id, this.now())
            this.set(id, waiting)
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
