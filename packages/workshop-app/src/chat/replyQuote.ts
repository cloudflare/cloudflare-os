import type { AssistantItem, ChatItem, UserItem } from './chatItems'

// A reply carries what it answers inside its own text, as a Markdown blockquote ahead of what was
// written. There is no reply in the protocol: this way the agent reads the quote as anyone would,
// and a client that knows nothing of replies shows it as the quote it is.
//
// TODO: this wants support from the backend: a message that names the sequence of the one it
// replies to (on `sendChatMessage` and `AiChatMessage`). Without it a reply can only be matched to
// its message by the quoted line, which is a guess when two messages read the same, breaks if
// how a line is made here ever changes, and means paging back through history to find a message
// that a sequence would let be fetched directly (see `ChatSession.findQuoted`).

/** How much of a message is quoted. Enough to tell which one it was, not to repeat it. */
const QUOTE_LENGTH = 240

/**
 * A message as one plain line, short enough to quote: what marks it up as Markdown is taken out,
 * its lines are run together, and it is cut off where it gets long.
 */
export const quoteOf = (text: string): string => {
  const plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/```\w*|\*\*|~~|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // By character, not by code unit, so that an emoji is never cut in half.
  const characters = [...plain]
  return characters.length > QUOTE_LENGTH ? `${characters.slice(0, QUOTE_LENGTH).join('').trimEnd()}…` : plain
}

/**
 * The line a message in the conversation is quoted as. A person's message is quoted for what they
 * wrote, with what they mentioned by its name, and without the quote it may itself open with.
 */
export const quoteLine = (item: UserItem | AssistantItem): string =>
  quoteOf(item.kind === 'assistant'
    ? item.text
    : item.parts.map((part) => (part.type === 'text' ? part.text : part.type === 'capsule' ? part.title : part.type === 'format' ? part.noun : `/${part.name}`)).join(''))

/**
 * The message a reply answers, among the rows of the conversation: the nearest one before the
 * reply that would be quoted as the line the reply carries, which is all it has to go by.
 */
export const quotedBy = (reply: UserItem, rows: readonly ChatItem[]): UserItem | AssistantItem | undefined => {
  if (reply.quote === undefined) return undefined
  const at = rows.findIndex(({ key }) => key === reply.key)
  return rows.slice(0, at === -1 ? rows.length : at)
    .findLast((row): row is UserItem | AssistantItem => (row.kind === 'user' || row.kind === 'assistant') && quoteLine(row) === reply.quote)
}

/** The text to send for a reply: the quote, then what was written. */
export const withQuote = (quote: string, text: string) => `> ${quote}\n\n${text}`

/**
 * Takes a message that opens with a blockquote apart again: the quote as one line, what was
 * written, and where in the message that starts, for anything that points into the message by
 * position. A message that is nothing but a quote has no reply in it, and is left whole.
 */
export const splitQuote = (message: string): { quote?: string; body: string; offset: number } => {
  const opening = /^(?:>.*\n)+\n+/.exec(message)?.[0]
  if (!opening || opening.length === message.length) return { body: message, offset: 0 }
  const quote = opening.split('\n').map((line) => line.replace(/^> ?/, '').trim()).filter(Boolean).join(' ')
  return quote ? { quote, body: message.slice(opening.length), offset: opening.length } : { body: message, offset: 0 }
}
