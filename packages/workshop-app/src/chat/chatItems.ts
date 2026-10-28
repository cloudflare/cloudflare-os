import type { AiChatMessage } from '@gadgets/workshop-shared/api'

/** What this app renders for a message. Everything it cannot render becomes `unsupported`. */
export type ChatItem =
  | { kind: 'user' | 'assistant' | 'error'; id: number; text: string }
  | { kind: 'unsupported'; id: number }

const toItem = (message: AiChatMessage): ChatItem | undefined => {
  const id = message.sequence
  switch (message.type) {
    // Never shown, in the full Workshop either: bookkeeping for the model.
    case 'catalogChange':
    case 'agentNudge':
      return undefined
    case 'error':
      return { kind: 'error', id, text: message.message }
    case 'message': {
      const { author, message: text } = message
      if (author.type === 'user') {
        // Attachment-only messages have nothing else to show.
        return text ? { kind: 'user', id, text } : { kind: 'unsupported', id }
      }
      if (author.type === 'agent') {
        if (text) return { kind: 'assistant', id, text }
        // A turn that only called tools shows cards in the full Workshop; reasoning alone shows nothing.
        return message.toolCalls?.length ? { kind: 'unsupported', id } : undefined
      }
      return { kind: 'unsupported', id }
    }
    default:
      return { kind: 'unsupported', id }
  }
}

/**
 * Turns a chat's messages into renderable items, in order. Consecutive unsupported items collapse
 * into one, so a long tool-calling turn is one placeholder rather than a wall of them.
 */
export const toChatItems = (messages: AiChatMessage[]): ChatItem[] => {
  const items: ChatItem[] = []
  for (const message of messages) {
    const item = toItem(message)
    if (!item) continue
    if (item.kind === 'unsupported' && items.at(-1)?.kind === 'unsupported') continue
    items.push(item)
  }
  return items
}
