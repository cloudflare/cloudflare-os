import { chatConnectors, type ChatConnector } from './chatConnectors'
import type { ChatAttachment, ChatItem, HookItem, OutputItem } from './chatItems'

/** What a chat has, as its conversation shows, each kind latest first. */
export type ChatContext = {
  /** What it made or worked on, each once, as it was last titled. */
  outputs: OutputItem[]
  /** What was uploaded to it, each once. */
  files: ChatAttachment[]
  /** What it set up to run by itself, and was not deleted since. */
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
 * What a chat has, as far as `rows`, its conversation as loaded and what waits under it, show.
 *
 * This is partial for a long chat: what was made or uploaded before the earliest message loaded is
 * not here, and neither are the services (`chatConnectors`). Listing everything a chat has needs the
 * backend to say it (what each output, upload and automation was made in which chat, and the
 * services used), which the workspace does not yet; the library does not say which chat made an output.
 */
export const chatContextOf = (rows: readonly ChatItem[]): ChatContext => {
  const latestFirst = rows.toReversed()
  return {
    outputs: distinct(latestFirst.filter((row): row is OutputItem => row.kind === 'output'), (output) => output.workpieceId),
    files: distinct(latestFirst.flatMap((row) => (row.kind === 'user' ? row.attachments.toReversed() : [])), (file) => file.id),
    hooks: distinct(latestFirst.filter((row): row is HookItem => row.kind === 'hook'), (hook) => hook.hookId),
    connectors: chatConnectors(rows),
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
