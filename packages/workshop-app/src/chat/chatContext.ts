import { chatConnectors, type ChatConnector } from './chatConnectors'
import type { ChatAttachment, ChatItem, HookItem, OutputItem } from './chatItems'
import type { ChatArtifacts } from './ChatSession'

/** What a chat has, each kind latest first. */
export type ChatContext = {
  /** What it made that its workspace still has, each once, as it is titled now. */
  outputs: OutputItem[]
  /** What was uploaded to it, each once. */
  files: ChatAttachment[]
  /** What it set up to run by itself, and was not deleted since, as far as its conversation is loaded. */
  hooks: HookItem[]
  connectors: ChatConnector[]
}

/** `rows`, each kept the first time `key` has it, in the order they come. */
const distinct = <T>(rows: Iterable<T>, key: (row: T) => string | number | undefined): T[] => {
  const seen = new Set<string | number>()
  const found: T[] = []
  for (const row of rows) {
    const id = key(row)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    found.push(row)
  }
  return found
}

/**
 * What a chat has: what it made, what was uploaded to it and the services it used, all of it, as
 * its workspace lists it (`artifacts`, nothing while that is unread); and its automations, from
 * `rows`, its conversation as loaded and what waits under it.
 */
export const chatContextOf = (artifacts: ChatArtifacts | undefined, rows: readonly ChatItem[]): ChatContext => {
  const latestFirst = (artifacts?.artifacts ?? []).toReversed()
  return {
    outputs: distinct(latestFirst.flatMap((artifact): OutputItem[] => {
      if (artifact.type !== 'workpiece') return []
      const { workpiece, sequence } = artifact
      const output = workpiece.type === 'gadget' ? workpiece.output : undefined
      return [{
        kind: 'output',
        id: sequence,
        key: `output:${workpiece.id}`,
        workpieceId: workpiece.id,
        title: workpiece.title,
        type: workpiece.type,
        draft: workpiece.type === 'gadget' && workpiece.chatId !== undefined,
        format: output && { noun: output.noun, icon: output.icon },
      }]
    }), (output) => output.workpieceId),
    files: distinct(latestFirst.flatMap((artifact): ChatAttachment[] => {
      if (artifact.type !== 'attachment') return []
      const { id, name, mimeType, size } = artifact.attachment
      return [{ id, name: name || 'Attached file', mimeType, size }]
    }), (file) => file.id),
    hooks: distinct(rows.toReversed().filter((row): row is HookItem => row.kind === 'hook'), (hook) => hook.hookId),
    connectors: chatConnectors(artifacts?.connections ?? []),
  }
}

const KINDS = [
  ['outputs', 'output'],
  ['hooks', 'automation'],
  ['files', 'upload'],
  ['connectors', 'connector'],
] as const

/** How many things a chat has in all. */
export const contextCount = (context: ChatContext) => KINDS.reduce((total, [kind]) => total + context[kind].length, 0)

/**
 * What a chat has in a few words, for a button that opens it: "3 outputs · 1 automation", the
 * first two kinds it has, and how many others there are.
 */
export const contextSummary = (context: ChatContext): string => {
  const parts = KINDS.flatMap(([kind, noun]) => {
    const count = context[kind].length
    return count === 0 ? [] : [`${count} ${noun}${count === 1 ? '' : 's'}`]
  })
  return parts.length > 2 ? `${parts.slice(0, 2).join(' · ')} · +${parts.length - 2}` : parts.join(' · ')
}
