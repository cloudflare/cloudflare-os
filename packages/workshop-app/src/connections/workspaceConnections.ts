import type { WorkspaceConnectionInfo } from '@gadgets/workshop-shared/api'
import type { ActionKind, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { kindLabel, type ChangeRule } from '@/blocks/ChangeRulesList'

/** The services a workspace's connections go to, as far as this deployment offers them. */
export type ConnectionServices = ReadonlyMap<string, { name: string; logoUrl?: string; color?: string; resources: readonly SupportedResource[] }>

/** A workspace's connections to one service, or those every chat has. */
export type ConnectionGroup = { key: string; label: string; connections: WorkspaceConnectionInfo[] }

const byTitle = (a: WorkspaceConnectionInfo, b: WorkspaceConnectionInfo) => a.title.localeCompare(b.title)

/**
 * A workspace's connections a group each, as its Connections tab lists them: by service, the
 * services by name, each's connections by title; then those every chat has (`ambient`), which
 * nobody made.
 */
export const connectionGroups = (connections: readonly WorkspaceConnectionInfo[], services: ConnectionServices): ConnectionGroup[] => {
  const groups = new Map<string, ConnectionGroup>()
  for (const connection of connections) {
    if (connection.ambient) continue
    const group = groups.get(connection.vendorId)
    if (group) group.connections.push(connection)
    else groups.set(connection.vendorId, { key: connection.vendorId, label: services.get(connection.vendorId)?.name ?? connection.vendorId, connections: [connection] })
  }
  const always = connections.filter(({ ambient }) => ambient)
  return [
    ...[...groups.values()].toSorted((a, b) => a.label.localeCompare(b.label)),
    ...(always.length ? [{ key: 'always', label: 'Every chat has', connections: [...always] }] : []),
  ].map((group) => ({ ...group, connections: group.connections.toSorted(byTitle) }))
}

/** The kind of resource a connection is, as its service names it: "Google Doc"; or, for one every chat has, the service. */
export const kindOf = (connection: WorkspaceConnectionInfo, services: ConnectionServices) => {
  const service = services.get(connection.vendorId)
  return service?.resources.find(({ urlPattern }) => urlPattern === connection.typeUrlPattern)?.title ?? service?.name
}

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })
const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`)

/**
 * What uses a connection, in a few words: the gadgets, then the agents whose runs did, by name, two
 * at most, or how many gadgets while their names are not known, then how many chats: "Used by Tip
 * Jar and 2 chats", "Used in a chat", "Not used yet".
 */
export const usesLine = (gadgets: readonly string[] | number, chats: number, agents: readonly string[] = []) => {
  const chatWords = count(chats, 'a chat', 'chats')
  const names = typeof gadgets === 'number' ? (gadgets ? [count(gadgets, 'a gadget', 'gadgets'), ...agents] : [...agents]) : [...gadgets, ...agents]
  const more = typeof gadgets !== 'number' && agents.length === 0 ? 'more gadgets' : 'more'
  const named = typeof gadgets !== 'number' && names.length > 2 ? [names[0]!, `${names.length - 1} ${more}`] : names
  if (named.length === 0) return chats ? `Used in ${chatWords}` : 'Not used yet'
  return `Used by ${LIST.format(chats ? [...named, chatWords] : named)}`
}

/** What a workspace allows through a connection without asking, in a few words, as its toggle says it: "Document edits allowed", "2 changes allowed". */
export const automaticLine = (kinds: readonly ActionKind[]) =>
  kinds.length === 0 ? undefined : kinds.length === 1 ? `${kindLabel(kinds[0]!.label).title} allowed` : `${kinds.length} changes allowed`

/**
 * Every kind of change a connection can make, as its kind of resource declares them
 * (`SupportedResource.actionKinds`), or, for one every chat has, every kind its service declares,
 * each once, in the service's order: whether it may go ahead without asking, and whether this
 * workspace lets it (`automatic`, the kinds its rules name). A rule for a kind not declared, made
 * from an action's "Always allow", is listed too, after them, so that it can be undone.
 */
export const changesOf = (connection: WorkspaceConnectionInfo, resources: readonly SupportedResource[], automatic: readonly ActionKind[]): ChangeRule[] => {
  const declared = connection.ambient ? resources : resources.filter(({ urlPattern }) => urlPattern === connection.typeUrlPattern)
  const on = new Set(automatic.map(({ tag }) => tag))
  const changes = new Map<string, ChangeRule>()
  for (const { kind, autoApprovable } of declared.flatMap(({ actionKinds = [] }) => actionKinds)) {
    if (!changes.has(kind.tag)) changes.set(kind.tag, { kind, autoApprovable, automatic: autoApprovable && on.has(kind.tag) })
  }
  for (const kind of automatic) {
    if (!changes.has(kind.tag)) changes.set(kind.tag, { kind, autoApprovable: true, automatic: true })
  }
  return [...changes.values()]
}
