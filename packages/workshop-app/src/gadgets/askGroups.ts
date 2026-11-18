import type { ActionLogEntry, AiChatMetadata, GadgetBindingInfo } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { formatActivity } from '@/workspaces/formatActivity'

/** Something a gadget's code, or an agent it started, asked to do through a connection. */
export type Ask = Extract<ActionLogEntry, { type: 'action' }>

/**
 * What tells one gadget's asks from the rest of its workspace's. An action does not say which
 * gadget made it, only the connection it went through and the chat it was made from, if any, so
 * an ask is the gadget's when it went through one of its connections from outside any chat, or
 * was made by an agent it started.
 */
export type AskScope = {
  /** What its bindings reach, by workpiece id: its connections, and the agents it can start. */
  targets: ReadonlySet<number>
  /** The chats of the agents it started, with what their spawner calls them. */
  agents: ReadonlyMap<number, string | undefined>
  /**
   * The chat it is shown from while that chat is out of sight, as on its own page: what went
   * through its connections from that chat is asked here too. Beside the chat, the chat asks it.
   */
  chatId?: number
}

/** The chats of the agents a gadget started: those its spawner bindings (`targets`) made. */
export const agentsOf = (
  chats: readonly Pick<AiChatMetadata, 'id' | 'spawnerId' | 'spawnerName'>[],
  targets: ReadonlySet<number>,
): Map<number, string | undefined> =>
  new Map(chats.flatMap(({ id, spawnerId, spawnerName }) => (spawnerId !== undefined && targets.has(spawnerId) ? [[id, spawnerName] as const] : [])))

/** What a gadget's bindings reach (`AskScope.targets`). */
export const targetsOf = (bindings: readonly Pick<GadgetBindingInfo, 'target'>[]): ReadonlySet<number> => new Set(bindings.map(({ target }) => target))

/** Whether `entry` is waiting on someone to decide it, and is the gadget's to ask (`AskScope`). */
export const isAskOf = (entry: ActionLogEntry, scope: AskScope): entry is Ask => {
  if (entry.type !== 'action' || entry.state !== 'pending') return false
  const { chatId, gatekeeperId } = entry
  if (chatId !== undefined && scope.agents.has(chatId)) return true
  if (gatekeeperId === undefined || !scope.targets.has(gatekeeperId)) return false
  return chatId === undefined || chatId === scope.chatId
}

/** Everything asked of one kind through one connection, decided together. */
export type AskGroup = {
  key: string
  /** Oldest first. */
  asks: Ask[]
  gatekeeperId?: number
  /**
   * The kind it can be allowed as from now on (`Overseer.setAutoApprovedActionKind`): only where
   * every one of them is one its service lets through unasked, and the workspace has not read
   * restricted data, where such rules never apply.
   */
  allowable?: ActionKind
  /** It makes something in one of the approver's accounts (`ActionLogEntry.creation`), asked where. */
  creation: boolean
}

/**
 * The asks as they are put to the user: those of one kind through one connection together, each
 * group where its first was made. A creation, or one with no kind, is asked on its own.
 */
export const askGroups = (asks: readonly Ask[], { restricted = false }: { restricted?: boolean } = {}): AskGroup[] => {
  const groups = new Map<string, Ask[]>()
  for (const ask of asks.toSorted((a, b) => a.id - b.id)) {
    const tag = ask.description.actionKind?.tag
    const key = ask.creation || tag === undefined || ask.gatekeeperId === undefined ? `action:${ask.id}` : `${ask.gatekeeperId}:${tag}`
    groups.set(key, [...(groups.get(key) ?? []), ask])
  }
  return [...groups].map(([key, grouped]) => {
    const [{ gatekeeperId, description, creation }] = grouped
    const allows = !restricted && gatekeeperId !== undefined && description.actionKind !== undefined &&
      grouped.every((ask) => ask.description.autoApprovable)
    return { key, asks: grouped, gatekeeperId, allowable: allows ? description.actionKind : undefined, creation: creation === true }
  })
}

// Older than this, an ask says when it was made: it was made while the viewer was elsewhere, or
// by somebody else.
const AWAY_MS = 2 * 60_000

// "Asked 5 min ago", "asked yesterday", "asked Monday": a name stays as it is written.
const askedAt = (at: Date, now: Date) => {
  const when = formatActivity(at, now)
  return `asked ${/^(Just|Yesterday|\d)/.test(when) ? when.charAt(0).toLowerCase() + when.slice(1) : when}`
}

/** What a group is called: the kind, as its service names it, else what its one ask is. */
export const askTitle = ({ asks: [first] }: AskGroup) =>
  first.description.actionKind && first.description.actionKind.label !== '' ? first.description.actionKind.label : first.description.title

/**
 * The line under a group's title: the agent that asks, where it is the gadget's agent rather than
 * its code; what it is done to, by its own name; how many; and since when, once that was a while
 * ago. "From Researcher · Q3 notes · 3 changes · asked 2 hours ago".
 */
export const askDetail = ({ asks }: AskGroup, agents: ReadonlyMap<number, string | undefined>, now = new Date()) => {
  const [first] = asks
  const { chatId } = first
  const parts = [
    chatId !== undefined && agents.has(chatId) ? `From ${agents.get(chatId) ?? 'its agent'}` : undefined,
    first.resourceTitle || undefined,
    asks.length > 1 ? `${asks.length} changes` : undefined,
    now.getTime() - first.createdAt.getTime() > AWAY_MS ? askedAt(first.createdAt, now) : undefined,
  ]
  const line = parts.filter(Boolean).join(' · ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}
