import type { WorkspaceMember } from './workspaceMembers'

/** Reads who has access to one workspace. */
export type LoadMembers = (workspaceId: string) => Promise<WorkspaceMember[]>

// How many workspaces are asked at a time. Each is a round trip of its own that wakes the workspace.
const AT_ONCE = 4
// How long what a workspace said is taken as it is, before it is asked again.
const FRESH = 5 * 60_000

/**
 * Who has access to each of the user's workspaces, for the Workspaces page. The list of workspaces
 * does not say (`listWorkspaces()` has no members), so each workspace is asked for its own, a few
 * at a time, in the order they are wanted in, and what it said is kept for a while: going back to
 * the page does not ask them all again. One that could not be read is left unknown, and is asked
 * again the next time it is wanted.
 */
export class WorkspaceMemberships {
  // Replaced, never changed, so that it can be a snapshot.
  private members: ReadonlyMap<string, WorkspaceMember[]> = new Map()
  private readonly readAt = new Map<string, number>()
  private readonly loading = new Set<string>()
  private queue: string[] = []
  private load: LoadMembers | undefined
  private readonly listeners = new Set<() => void>()

  constructor(private readonly now: () => number = Date.now) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The members of each workspace that has said, by its id. */
  snapshot = () => this.members

  /**
   * Asks the workspaces `ids` for their members, in that order, with `load`: those that have not
   * said, or said too long ago, whose members stay as they were until they say again. Takes the
   * place of what was wanted before.
   */
  want(ids: string[], load: LoadMembers) {
    this.load = load
    const now = this.now()
    this.queue = ids.filter((id) => !this.loading.has(id) && (this.readAt.get(id) ?? -Infinity) + FRESH <= now)
    this.pump()
  }

  /** Asks no more workspaces, as when the connection is lost. Those being asked are let answer. */
  stop() {
    this.queue = []
  }

  private pump() {
    while (this.loading.size < AT_ONCE && this.queue.length > 0) {
      const id = this.queue.shift()!
      this.loading.add(id)
      this.load!(id)
        .then(
          (members) => {
            this.members = new Map(this.members).set(id, members)
            this.readAt.set(id, this.now())
            for (const listener of this.listeners) listener()
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
