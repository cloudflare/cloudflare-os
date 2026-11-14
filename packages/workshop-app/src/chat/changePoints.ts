import type { AiChatMessage } from '@gadgets/workshop-shared/api'

/**
 * A point in the chat that its gadgets can be put back to (`Overseer.restoreChanges`): `undo` puts
 * them as they were before the newest point, `redo` takes back undoing, and `restore` brings back
 * how they were at an older one.
 */
export type GoBack = {
  sequence: number
  to: 'before' | 'after'
  action: 'undo' | 'redo' | 'restore'
  /** The gadgets undoing removes, which were made at this point; asked about first. */
  deletes: number[]
}

/** Where each point is offered: on a turn's answer, or on the line marking what someone did. */
export type ChangePoints = {
  /** By the sequence of the answer that ends the turn whose changes were kept. */
  answers: ReadonlyMap<number, GoBack>
  /** By the sequence of the merge or restore that a line marks. */
  marks: ReadonlyMap<number, GoBack>
}

type Merge = Extract<AiChatMessage, { type: 'merge' }>
type Restore = Extract<AiChatMessage, { type: 'restore' }>

// A merge from before merges recorded what each commit replaced cannot be gone back on.
const restorable = (message: AiChatMessage): message is Merge | Restore =>
  (message.type === 'merge' && message.commits.length > 0 && message.commits.every(({ previousCommit }) => previousCommit !== undefined)) ||
  (message.type === 'restore' && message.commits.length > 0)

const answers = (message: AiChatMessage) => message.type === 'message' && message.author.type === 'agent' && message.message.trim() !== ''
// What starts a turn: a prompt that is not steering the one going on, or a command.
const opensTurn = (message: AiChatMessage) =>
  message.type === 'slashCommand' || (message.type === 'message' && message.author.type !== 'agent' && !message.steered)

/**
 * The points a chat's gadgets can be put back to, with what each offers: the newest undoes (or,
 * where it was an undo, redoes), the rest restore. The viewer's own merges, which are not marked
 * (see `toChatFeed`), are offered on the answer that ended their turn; someone else's, and every
 * restore, on their line. A merge whose turn said nothing has nowhere to be offered.
 */
export const changePoints = (messages: readonly AiChatMessage[], viewerId: string | undefined): ChangePoints => {
  const points = messages.filter(restorable)
  const newest = points.at(-1)?.sequence
  const bySequence = new Map(messages.map((message) => [message.sequence, message]))
  const onAnswers = new Map<number, GoBack>()
  const onMarks = new Map<number, GoBack>()
  // The answer that ends the turn, as far as each message: none once another turn opens.
  let answer: number | undefined

  for (const message of messages) {
    if (opensTurn(message)) answer = undefined
    else if (answers(message)) answer = message.sequence
    if (!restorable(message)) continue

    const isNewest = message.sequence === newest
    const undid = message.type === 'restore' && message.to === 'before' && bySequence.get(message.from)?.type === 'merge'
    const point: GoBack = isNewest
      ? {
          sequence: message.sequence,
          to: 'before',
          action: undid ? 'redo' : 'undo',
          deletes: message.type === 'merge' ? message.commits.filter(({ previousCommit }) => previousCommit === null).map(({ gadgetId }) => gadgetId) : [],
        }
      : { sequence: message.sequence, to: 'after', action: 'restore', deletes: [] }

    if (message.type === 'merge' && message.author.id === viewerId) {
      if (answer !== undefined) onAnswers.set(answer, point)
    } else {
      onMarks.set(message.sequence, point)
    }
  }
  return { answers: onAnswers, marks: onMarks }
}

const AND = new Intl.ListFormat('en', { type: 'conjunction' })

/** The gadgets an undo deletes, as a question names them: by title, or plainly where one has none known. */
export const nameGadgets = (titles: readonly (string | undefined)[]) =>
  titles.every((title) => title !== undefined)
    ? AND.format(titles.map((title) => `“${title}”`))
    : titles.length === 1 ? 'this gadget' : 'these gadgets'
