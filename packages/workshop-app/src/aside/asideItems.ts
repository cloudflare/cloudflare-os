import type { ChatSnapshot } from '@/chat/ChatSession'
import type { ChatAttachment, OutputFormat } from '@/chat/chatItems'

/** An output, as what is needed to show it: where it is, and what it is. */
export type AsideOutput = {
  workspaceId: string
  workpieceId: number
  type: 'gadget' | 'worktree'
  format?: OutputFormat
  /** The chat it is shown from: it is shown with the changes proposed there. */
  chatId?: number
}

/** Something that can be shown in the aside, or as a page of its own. */
export type AsideItem = {
  /** Tells it from anything else that can be shown: its `AsideRef`, written out. */
  key: string
  title: string
  /**
   * When it was last sent or made in the chat it is one of: a file, when its message was sent; an
   * output, when the last message before its latest card was. Unknown for one named by a link alone.
   */
  at?: Date
} & ({ kind: 'file'; file: AsideFile } | { kind: 'output'; output: AsideOutput })

/** A file, as what is needed to show it: what it is, and where its bytes are. */
export type AsideFile = ChatAttachment & {
  workspaceId: string
  /** The chat it was sent in, which its bytes are fetched through. Unknown for one named by a link alone. */
  chatId?: number
}

/**
 * Something within a workspace that can be shown, as the URL names it: `12` for what was made
 * there (an app, a document), `file-<id>` for a file sent there. Beside a chat that is all of it
 * (`?open=`); on its own page the workspace goes in front (see `itemPageId`).
 */
export type AsideRef = { kind: 'output'; workpieceId: number } | { kind: 'file'; fileId: string }

const FILE = 'file-'

export const formatAsideRef = (ref: AsideRef): string => (ref.kind === 'output' ? String(ref.workpieceId) : `${FILE}${ref.fileId}`)

/** The ref `value` writes out, or nothing when it is not one. A number is one read from the URL. */
export const parseAsideRef = (value: unknown): AsideRef | undefined => {
  const written = typeof value === 'number' ? String(value) : value
  if (typeof written !== 'string') return undefined
  if (written.startsWith(FILE) && written.length > FILE.length) return { kind: 'file', fileId: written.slice(FILE.length) }
  if (!/^\d+$/.test(written)) return undefined
  const workpieceId = Number(written)
  return Number.isSafeInteger(workpieceId) ? { kind: 'output', workpieceId } : undefined
}

/** The `?open=` value for the URL: the ref written out, or nothing when it is not one. */
export const validateAsideParam = (value: unknown): string | undefined => {
  const ref = parseAsideRef(value)
  return ref && formatAsideRef(ref)
}

/**
 * The id of an item's own page: its workspace, then its ref. For now the workspace is part of it,
 * as nothing is told apart across workspaces without it; once items have ids of their own, only
 * this and `parseItemPageId` change.
 */
export const itemPageId = (workspaceId: string, ref: AsideRef) => `${workspaceId}-${formatAsideRef(ref)}`

/** The item a page's id names, or nothing when it names none. */
export const parseItemPageId = (id: string): { workspaceId: string; ref: AsideRef } | undefined => {
  // A workspace's id has no dash in it, but the ref after it can.
  const found = /^(.+?)-(\d+|file-.+)$/.exec(id)
  const ref = found && parseAsideRef(found[2])
  return found && ref ? { workspaceId: found[1], ref } : undefined
}

/**
 * Whether something made is an app, which has a page of its own apart from everything else
 * (`/app/`): a gadget that was not made as a document or another format.
 */
export const isApp = (output: { type: 'gadget' | 'worktree'; format?: unknown }) => output.type === 'gadget' && !output.format

/** Where an item is shown on its own: an app as an app, anything else in the library. */
export const itemPage = (workspaceId: string, ref: AsideRef, app: boolean) =>
  app
    ? ({ to: '/app/$itemId', params: { itemId: itemPageId(workspaceId, ref) } } as const)
    : ({ to: '/library/$itemId', params: { itemId: itemPageId(workspaceId, ref) } } as const)

/** Where a shown item is on its own. */
export const pageOf = (workspaceId: string, item: AsideItem) =>
  itemPage(workspaceId, parseAsideRef(item.key)!, item.kind === 'output' && isApp(item.output))

/**
 * What `ref` names, in the workspace `workspaceId`: one of `known` when it is among them, and
 * otherwise as much as the ref alone says, which the item's own connection fills in once it is
 * shown, such as an output's title. An output is shown with the changes proposed in `chatId`.
 */
export const asideItemFor = (workspaceId: string, ref: AsideRef, chatId: number | undefined, known: AsideItem[] = []): AsideItem => {
  const key = formatAsideRef(ref)
  const found = known.find((item) => item.key === key)
  if (found) return found
  return ref.kind === 'output'
    ? { key, title: 'Untitled', kind: 'output', output: { workspaceId, workpieceId: ref.workpieceId, type: 'gadget', chatId } }
    : { key, title: 'File', kind: 'file', file: { id: ref.fileId, name: 'File', mimeType: '', size: 0, workspaceId, chatId } }
}

/**
 * What a chat has to show beside it, most recently made or changed first: the outputs it made or
 * worked on, and the files sent in it. Only what has been loaded of the conversation is known.
 */
export const chatAsideItems = (workspaceId: string, chatId: number, chat: ChatSnapshot): AsideItem[] => {
  if (chat.status !== 'ready') return []
  const rows = [...chat.items, ...chat.pinned]
  // Rows have no time of their own but messages, so each is as late as the last message up to it.
  const times: Array<Date | undefined> = []
  let latest: Date | undefined
  for (const row of rows) {
    if ((row.kind === 'user' || row.kind === 'assistant') && row.sentAt) latest = row.sentAt
    times.push(latest)
  }
  const found = new Map<string, AsideItem>()
  // Later rows go first, and an output's latest row has its latest title.
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    const at = times[index]
    if (row.kind === 'output') {
      const key = formatAsideRef({ kind: 'output', workpieceId: row.workpieceId })
      if (found.has(key)) continue
      found.set(key, {
        key,
        title: row.title,
        at,
        kind: 'output',
        output: { workspaceId, workpieceId: row.workpieceId, type: row.type, format: row.format, chatId },
      })
    } else if (row.kind === 'user') {
      for (const file of row.attachments.toReversed()) {
        const key = formatAsideRef({ kind: 'file', fileId: file.id })
        if (!found.has(key)) found.set(key, { key, title: file.name, at, kind: 'file', file: { ...file, workspaceId, chatId } })
      }
    }
  }
  return [...found.values()]
}
