import type { UserMessageAttachment, UserMessagePart } from '@/blocks/UserMessage'

/** The first message of a chat just started, as the page that sent it drew it. */
export type FirstMessage = { parts: UserMessagePart[]; attachments: UserMessageAttachment[] }

// Only the latest: a chat is started, then opened at once. Kept here rather than in the history's
// state, which can't hold a format's icon.
let handed: { at: string; message: FirstMessage } | undefined

/** Hands the chat being opened the message that started it, to draw until its history is read. */
export const handOverFirstMessage = (workspaceId: string, chatId: number, message: FirstMessage) => {
  handed = { at: `${workspaceId}/${chatId}`, message }
}

/** The message that started this chat, where the page before it just sent it. */
export const firstMessageOf = (workspaceId: string, chatId: number) =>
  handed?.at === `${workspaceId}/${chatId}` ? handed.message : undefined
