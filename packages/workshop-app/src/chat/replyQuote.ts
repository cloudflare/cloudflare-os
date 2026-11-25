import { answerProse } from './answerParts'
import type { AssistantItem, UserItem } from './chatItems'

// A reply names the message it answers (`replyToSequence`), which is what links it there, and
// carries a line of that message inside its own text, as a Markdown blockquote ahead of what was
// written: the agent is not shown what a reply answers, so this way it reads the quote as anyone
// would, and a client that knows nothing of replies shows it as the quote it is.

/** How much of a message is quoted. Enough to recall it by, not to repeat it. */
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
    ? answerProse(item.parts)
    : item.parts.map((part) => (part.type === 'text' ? part.text : part.type === 'capsule' ? part.title : part.type === 'format' ? part.noun : `/${part.name}`)).join(''))

/** The text to send for a reply: the quote, then what was written. */
export const withQuote = (quote: string, text: string) => `> ${quote}\n\n${text}`

/**
 * Takes a reply apart again: the quote it opens with as one line, what was written, and where in
 * the message that starts, for anything that points into the message by position. Only for a
 * message that names what it replies to: another that opens with a blockquote is as it was written.
 * A message that is nothing but a quote is left whole.
 */
export const splitQuote = (message: string): { quote?: string; body: string; offset: number } => {
  const opening = /^(?:>.*\n)+\n+/.exec(message)?.[0]
  if (!opening || opening.length === message.length) return { body: message, offset: 0 }
  const quote = opening.split('\n').map((line) => line.replace(/^> ?/, '').trim()).filter(Boolean).join(' ')
  return quote ? { quote, body: message.slice(opening.length), offset: opening.length } : { body: message, offset: 0 }
}
