import type { ActionLogEntry, AiChatMessage } from '@gadgets/workshop-shared/api'

/**
 * Where a pending request was asked for, as far as the client can tell.
 *
 * `elsewhere` means another chat, a hook firing, or gadget code running outside any conversation.
 * Which of the three cannot be told apart here — `ActionLogEntry` carries no caller — so the tray
 * says only that it came from elsewhere in the workspace.
 *
 * `unknown` is the honest answer while the open chat's earlier history is still unloaded: a
 * compacted conversation starts at the tail, so a request of its own can be out of sight, and
 * calling that "elsewhere" would be a claim the client cannot make yet.
 */
export type RequestOrigin = 'open-chat' | 'elsewhere' | 'unknown'

/**
 * A pending request the tray can act on: an action still awaiting a decision, on a real
 * connection.
 *
 * Observations and hook bindings are not decisions (an observation is recorded already approved),
 * and a built-in agent tool's entry reaches the client with no `gatekeeperId` at all, so neither
 * can appear here.
 */
export type PendingChange = ActionLogEntry & {
  type: 'action'
  gatekeeperId: NonNullable<ActionLogEntry['gatekeeperId']>
  origin: RequestOrigin
}

/**
 * The pending requests one connection is holding.
 *
 * A gatekeeper is created per (account, resource), so the connection *is* the resource the user
 * recognises — which also makes the group and the auto-approval rule the same scope.
 */
export interface PendingChangeGroup {
  gatekeeperId: number
  /** The resource's name, as the entries report it. */
  title: string
  /**
   * The group's requests, oldest first. Action ids count up, so this is submission order, which
   * is the order they must be applied in: each was simulated against the ones before it.
   */
  entries: PendingChange[]
  /**
   * True when a request in the group creates the resource itself. A creation needs an account
   * chosen for it, so it is decided on its own rather than in a bulk apply, and rejecting it
   * cascades to everything queued behind it.
   */
  hasCreation: boolean
}

/** A connection whose entries carry no usable title. */
const UNTITLED_RESOURCE = 'Unavailable connection'

/**
 * The ids of the requests the open chat has a message for.
 *
 * A chat's `action` messages are the only client-side record of which conversation a request came
 * from, since `ActionLogEntry` carries no caller. A chat may carry more than one message for the
 * same id after a reconnect replays the gap, which a set absorbs.
 */
export function chatRequestIds(messages: readonly AiChatMessage[]): Set<number> {
  const ids = new Set<number>()
  for (const message of messages) {
    if (message.type === 'action') ids.add(message.actionId)
  }
  return ids
}

/**
 * Groups the workspace's pending requests by the connection they target, this conversation's
 * connections first and each band's oldest group first.
 *
 * Workspace-scoped rather than chat-scoped: a hook firing, a scheduled task, or another chat
 * queues requests that are just as much waiting on a decision, and a tray that showed only this
 * conversation's left them with no surface but the Activity pane. `openChatIds` marks the ones
 * this conversation asked for, so an unfamiliar request is labelled rather than unexplained.
 *
 * `historyComplete` says whether `openChatIds` can be trusted to be the whole of this
 * conversation: a compacted chat loads only the tail, so until the earlier pages are in, a
 * request it has no message for may still be its own. Those are left `unknown` rather than
 * labelled and sorted down on a guess.
 *
 * Grouping by `gatekeeperId` rather than `resourceUrl`, which is absent until a creation applies.
 */
export function pendingChangeGroups(
  pending: readonly ActionLogEntry[],
  openChatIds: ReadonlySet<number>,
  historyComplete: boolean,
): PendingChangeGroup[] {
  const groups = new Map<number, PendingChangeGroup>()
  // `pending` arrives oldest first; ids count up, so this is also the order a bulk apply takes.
  for (const log of [...pending].toSorted((a, b) => a.id - b.id)) {
    if (log.type !== 'action' || log.state !== 'pending') continue
    const { gatekeeperId } = log
    if (gatekeeperId === undefined) continue
    const origin: RequestOrigin = openChatIds.has(log.id) ? 'open-chat'
      : historyComplete ? 'elsewhere'
        : 'unknown'
    const entry: PendingChange = { ...log, gatekeeperId, origin }

    const group = groups.get(gatekeeperId)
    if (group) {
      group.entries.push(entry)
      group.hasCreation ||= entry.creation === true
      // An earlier entry may predate the resource having a name of its own.
      if (group.title === UNTITLED_RESOURCE && entry.resourceTitle) group.title = entry.resourceTitle
    } else {
      groups.set(gatekeeperId, {
        gatekeeperId,
        title: entry.resourceTitle || UNTITLED_RESOURCE,
        entries: [entry],
        hasCreation: entry.creation === true,
      })
    }
  }

  // What this conversation asked for sits at the top, and what it did not keeps its place below:
  // the queue is the workspace's either way, so nothing is hidden from whoever is here to answer
  // it, but a request the user recognises is the first thing they meet.
  //
  // Only the groups move. A group's entries stay in id order, which is the order a bulk apply
  // takes and what "waiting on the request above it" points at. Insertion order within each band
  // is each group's oldest entry, since the entries were sorted by id.
  const asked: PendingChangeGroup[] = []
  const elsewhere: PendingChangeGroup[] = []
  for (const group of groups.values()) {
    if (isFromElsewhere(group)) elsewhere.push(group)
    else asked.push(group)
  }
  return [...asked, ...elsewhere]
}

/**
 * Whether every request in `group` is known to have been asked for somewhere else.
 *
 * One request whose origin is merely unknown is enough to withhold the label: the group may yet
 * turn out to be this conversation's own once its earlier history loads.
 */
export function isFromElsewhere(group: PendingChangeGroup): boolean {
  return group.entries.every(entry => entry.origin === 'elsewhere')
}

/** Every pending request across `groups`, in the order a bulk resolve would take them. */
export function pendingChangeEntries(groups: readonly PendingChangeGroup[]): PendingChange[] {
  return groups.flatMap(group => group.entries).toSorted((a, b) => a.id - b.id)
}

/**
 * How a group describes its size.
 *
 * Counts requests, not edits: one request can bundle many (a Slides batch describes itself as
 * "Makes N changes, all or none of which are applied"), so a count of edits would promise a
 * precision the tray does not have.
 */
export function describeGroupSize(group: PendingChangeGroup): string {
  const count = group.entries.length
  return count === 1 ? '1 request' : `${count} requests`
}

/**
 * How many of `groups` another chat, a hook or a scheduled task accounts for, for the tray's own
 * summary. Zero is the ordinary case: the conversation queued everything it is waiting on. A
 * request whose origin is not yet known is not counted — the summary states a fact or nothing.
 */
export function countFromElsewhere(groups: readonly PendingChangeGroup[]): number {
  return pendingChangeEntries(groups).filter(entry => entry.origin === 'elsewhere').length
}
