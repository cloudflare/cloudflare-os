import { parseInlineHtmlBlocks } from '@gadgets/workshop-shared/inline-html-blocks'

/** A part of an agent's answer, in order: what it says, or a live view it drew between. */
export type AnswerPart =
  | { kind: 'prose'; text: string }
  /** A view: its HTML, the name its `<title>` gives it, and why it will not run, when it will not. */
  | { kind: 'view'; html: string; title?: string; error?: string }

/**
 * An answer as the parts it is shown in: its prose around the `<inline-html>` blocks it drew,
 * which the one parser of that syntax finds. Prose that is only space between two views is
 * nothing. A block never closed, in an answer that is finished, is a view of what it has; in one
 * still being written (`streaming`), it is the view being drawn.
 */
export const answerParts = (text: string, { streaming = false } = {}): AnswerPart[] =>
  parseInlineHtmlBlocks(text, { streaming }).flatMap((segment): AnswerPart[] => {
    if (segment.kind === 'text') return segment.text.trim() === '' ? [] : [{ kind: 'prose', text: segment.text.trim() }]
    const view: AnswerPart = { kind: 'view', html: segment.html }
    if (segment.title !== undefined) view.title = segment.title
    if (segment.kind === 'block' && segment.error !== undefined) view.error = segment.error
    return [view]
  })

/** What an answer says, without the views it drew: for copying it, or quoting it in a reply. */
export const proseOf = (text: string): string =>
  answerParts(text).flatMap((part) => (part.kind === 'prose' ? [part.text] : [])).join('\n\n')

/** While an answer is being written: the name of the view it is drawing now, if it is drawing one. */
export const viewBeingDrawn = (text: string): { title?: string } | undefined => {
  const last = parseInlineHtmlBlocks(text, { streaming: true }).at(-1)
  return last?.kind === 'open' ? { title: last.title } : undefined
}
