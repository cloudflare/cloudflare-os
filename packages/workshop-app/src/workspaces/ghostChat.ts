import type { ChatItem } from '@/chat/chatItems'
import { plainLine } from './activity/WorkspaceActivity'

/** What a chat open in its conversation says of itself for the sidebar, where it is not among the recent chats. */
export type GhostChatLine = {
  /** Its latest message as plain words: its first line, without the quote a reply opens with. */
  preview?: string
  /** Who said it, where that is not the chat's own assistant: "You", or whoever else sent it. */
  speaker?: string
  /** Something was said in it since `since`: by anyone, or sent to its agent and not read yet. */
  fresh: boolean
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('>'))

/** What the sidebar says of a chat open in its conversation (`items`), and whether anything was said in it since `since` (ms). */
export const ghostLineOf = (items: readonly ChatItem[], since: number): GhostChatLine => {
  const latest = items.findLast((item) => item.kind === 'user' || item.kind === 'assistant')
  const fresh = items.some((item) =>
    (item.kind === 'user' && (item.sentAt === undefined || item.sentAt.getTime() >= since)) ||
    (item.kind === 'assistant' && item.sentAt.getTime() >= since))
  if (!latest || (latest.kind !== 'user' && latest.kind !== 'assistant')) return { fresh }
  const line = firstLine(latest.text)
  return {
    preview: line === undefined ? undefined : plainLine(line),
    speaker: latest.kind === 'user' ? (latest.from ?? 'You') : undefined,
    fresh,
  }
}
