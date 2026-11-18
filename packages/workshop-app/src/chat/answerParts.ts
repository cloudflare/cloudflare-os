import { parseInlineHtmlBlocks } from '@gadgets/workshop-shared/inline-html-blocks'
import type { AnswerPart } from '@/blocks/AssistantMessage'

// Text as a code block, in a fence longer than any run of backticks in it.
const asCode = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}html\n${text}\n${fence}`
}

/**
 * What the agent said, in order: its prose, and the live views it drew between `<inline-html>`
 * tags (the shared parser's, which says where a tag counts). While it is still `streaming`, a
 * block that has not closed is a view being drawn; once written, one the agent never closed is
 * shown as the code it is, rather than run half-written. Prose that is only the space between
 * two views is left out.
 */
export const answerParts = (text: string, { streaming = false }: { streaming?: boolean } = {}): AnswerPart[] =>
  parseInlineHtmlBlocks(text, { streaming }).flatMap((segment): AnswerPart[] => {
    switch (segment.kind) {
      case 'text':
        return segment.text.trim() ? [{ type: 'text', text: segment.text }] : []
      case 'block':
        return [{ type: 'view', html: segment.html, title: segment.title, error: segment.error }]
      case 'open':
        return streaming
          ? [{ type: 'view', html: segment.html, title: segment.title, drawing: true }]
          : [{ type: 'text', text: asCode(segment.text) }]
    }
  })

/** The prose of an answer, for quoting it: the words around its views, or else what they are called. */
export const answerProse = (parts: readonly AnswerPart[]): string => {
  const words = parts.flatMap((part) => (part.type === 'text' ? [part.text.trim()] : []))
  return words.length ? words.join('\n\n') : parts.map((part) => (part.type === 'view' ? part.title ?? 'Live view' : '')).join(' ')
}
