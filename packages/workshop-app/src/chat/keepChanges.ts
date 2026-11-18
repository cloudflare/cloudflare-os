import type { KeepAsk } from './ChatSession'

const quoted = (title: string) => `“${title}”`
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * What a chat's waiting changes do, a line each, in the words of whoever is asked to keep them.
 * A gadget, a connection or an agent spawner is named by `titleOf`, a gadget else by the title the
 * changes gave it, else plainly; what is given is said by name ("Connects “Calculator” to “Joke”"),
 * or by the title of the resource the binding reaches, else as "a connection".
 */
export const keepChangeLines = (
  { changes }: KeepAsk,
  titleOf: (gadgetId: number) => string | undefined,
  /** What a binding reaches, by the title people know it by, where it is known (`useBindingTitles`). */
  resourceOf: (gadgetId: number, binding: string) => string | undefined = () => undefined,
): string[] => {
  const created = new Map(changes.created.map(({ gadgetId, title }) => [gadgetId, title]))
  const name = (gadgetId: number) => {
    const title = titleOf(gadgetId) ?? created.get(gadgetId)
    return title ? quoted(title) : 'a gadget'
  }
  const lines = [
    ...changes.created.map(({ gadgetId }) => `Creates ${name(gadgetId)}`),
    ...changes.bindings.map(({ gadgetId, name: binding, target }) => {
      // The name the code reaches it by means nothing to most people, so it is never said.
      const reached = titleOf(target) ?? resourceOf(gadgetId, binding)
      return `Connects ${name(gadgetId)} to ${reached ? quoted(reached) : 'a connection'}`
    }),
    ...changes.updates.map(({ gadgetId }) => `Updates ${name(gadgetId)} to its template’s latest version`),
  ]
  if (changes.mainline) lines.push('Brings in changes kept elsewhere since this chat began')
  if (changes.conflicts.length) lines.push(`Leaves ${plural(changes.conflicts.length, 'file', 'files')} with conflicts to fix`)
  // The same line twice says nothing more, as for two resources of one name.
  return [...new Set(lines)]
}

/** Why the changes wait for the user, the weightiest reason first. */
export const keepReason = ({ changes, shared }: KeepAsk): string => {
  if (changes.conflicts.length) return 'Some files have conflicts to look over first.'
  if (changes.bindings.length) return 'Connecting a gadget to something needs your OK.'
  if (changes.updates.length || changes.mainline) return 'Updates wait for you to look them over.'
  if (shared) return 'Others work in this workspace, so changes wait for you to keep them.'
  return 'These changes need you to keep them.'
}
