import type { KeepAsk } from './ChatSession'

const quoted = (title: string) => `“${title}”`
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * What a chat's waiting changes do, a line each, in the words of whoever is asked to keep them.
 * A gadget, a connection or an agent spawner is named by `titleOf`, a gadget else by the title the
 * changes gave it, else plainly; what is given is said by name ("Lets “Calculator” use “Joke”"),
 * or by the name its code reaches it by where it has none to go by.
 */
export const keepChangeLines = ({ changes }: KeepAsk, titleOf: (gadgetId: number) => string | undefined): string[] => {
  const created = new Map(changes.created.map(({ gadgetId, title }) => [gadgetId, title]))
  const name = (gadgetId: number) => {
    const title = titleOf(gadgetId) ?? created.get(gadgetId)
    return title ? quoted(title) : 'a gadget'
  }
  const lines = [
    ...changes.created.map(({ gadgetId }) => `Makes ${name(gadgetId)}`),
    ...changes.bindings.map(({ gadgetId, name: binding, target }) => {
      const reached = titleOf(target)
      return reached ? `Lets ${name(gadgetId)} use ${quoted(reached)}` : `Gives ${name(gadgetId)} access to env.${binding}`
    }),
    ...changes.updates.map(({ gadgetId }) => `Brings its blueprint’s update into ${name(gadgetId)}`),
  ]
  if (changes.mainline) lines.push('Brings in what was kept elsewhere since')
  if (changes.conflicts.length) lines.push(`Leaves ${plural(changes.conflicts.length, 'file', 'files')} with conflicts`)
  // The same line twice says nothing more, as for two resources of one name.
  return [...new Set(lines)]
}

/** Why the changes wait for the user, the weightiest reason first. */
export const keepReason = ({ changes, shared }: KeepAsk): string => {
  if (changes.conflicts.length) return 'Look over the conflicts before keeping them.'
  if (changes.bindings.length) return 'What a gadget can reach is yours to decide.'
  if (changes.updates.length || changes.mainline) return 'An update waits for you to look it over first.'
  if (shared) return 'Others work in this workspace too, so changes wait for you.'
  return 'They couldn’t be kept on their own.'
}
