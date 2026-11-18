import type { AiChatMetadata } from '@gadgets/workshop-shared/api'

/** A chat to carry on in with an item beside it. */
export type ItemChat = {
  chatId: number
  title: string
  at: Date
  /** It had the item beside it when it was last open, in this browser. */
  showing: boolean
}

// As many as a menu offers without becoming a list to read.
const SHOWN = 4

/**
 * The chats of a workspace to carry on in with one of its items beside them: those that last had
 * it open first, then the most recently active. Not one an agent started, which is that agent's
 * run rather than somewhere to talk.
 */
export const itemChats = (
  chats: readonly AiChatMetadata[],
  workspaceId: string,
  /** The item, as `?open=` names it. */
  open: string,
  /** What was last shown beside a chat (`lastShown`). */
  shownIn: (workspaceId: string, chatId: number) => string | undefined,
): ItemChat[] =>
  chats
    .filter((chat) => chat.spawnerName === undefined)
    .map((chat): ItemChat => ({
      chatId: chat.id,
      title: chat.title || 'Untitled chat',
      at: chat.lastActive,
      showing: shownIn(workspaceId, chat.id) === open,
    }))
    .toSorted((a, b) => Number(b.showing) - Number(a.showing) || b.at.getTime() - a.at.getTime())
    .slice(0, SHOWN)
