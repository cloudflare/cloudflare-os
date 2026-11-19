import type { KeepAsk } from './ChatSession'
import type { BindingReach } from './useBindingTitles'

const quoted = (title: string) => `“${title}”`
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * What a chat's waiting changes do, a line each, in the words of whoever is asked to keep them.
 * A gadget, a connection or an agent spawner is named by `titleOf`, a gadget else by the title the
 * changes gave it, else plainly; what is given is said by name ("Connects “Calculator” to “Joke”"),
 * or by the title of the resource the binding reaches, else as "a connection". One of the user's AI
 * models is said as what the gadget may use ("Lets “Tip Jar” use Claude Haiku").
 */
export const keepChangeLines = (
  { changes }: KeepAsk,
  titleOf: (gadgetId: number) => string | undefined,
  /** What a binding reaches, by the title people know it by, where it is known (`useBindingTitles`). */
  resourceOf: (gadgetId: number, binding: string) => BindingReach | undefined = () => undefined,
): string[] => {
  const created = new Map(changes.created.map(({ gadgetId, title }) => [gadgetId, title]))
  const name = (gadgetId: number) => {
    const title = titleOf(gadgetId) ?? created.get(gadgetId)
    return title ? quoted(title) : 'a gadget'
  }
  const lines = [
    ...changes.created.map(({ gadgetId }) => `Creates ${name(gadgetId)}`),
    ...changes.edited.map((gadgetId) => `Changes ${name(gadgetId)}`),
    ...changes.bindings.map(({ gadgetId, name: binding, target }) => {
      // The name the code reaches it by means nothing to most people, so it is never said.
      const titled = titleOf(target)
      const resource = resourceOf(gadgetId, binding)
      if (titled === undefined && resource?.model) return `Lets ${name(gadgetId)} use ${resource.title}`
      const reached = titled ?? resource?.title
      return `Connects ${name(gadgetId)} to ${reached ? quoted(reached) : 'a connection'}`
    }),
    ...changes.updates.map(({ gadgetId }) => `Updates ${name(gadgetId)} to its template’s latest version`),
  ]
  if (changes.mainline) lines.push('Brings in changes kept elsewhere since this chat began')
  if (changes.conflicts.length) lines.push(`Leaves ${plural(changes.conflicts.length, 'file', 'files')} with conflicts to fix`)
  // The same line twice says nothing more, as for two resources of one name.
  return [...new Set(lines)]
}

/** What to know before keeping them, the weightiest first: else that nobody else has them yet. */
export const keepReason = ({ changes }: KeepAsk): string => {
  if (changes.conflicts.length) return 'Some files have conflicts to look over first.'
  if (changes.bindings.length) return 'Connecting a gadget to something needs your OK.'
  if (changes.updates.length || changes.mainline) return 'Look the updates over before you keep them.'
  return 'They’re only in this chat until you keep them.'
}
