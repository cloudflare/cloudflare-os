import { documentLength, type BillowDocument, type ItemDefinition, type ItemNode, type ModelRange } from '@gadgets/billow'
import type { FormatIconName } from '@/components/FormatIcon'
import type { ComposerCommand } from './composerCommand'
import type { ComposerConnection } from './ComposerConnectionLines'

/**
 * What a draft asks for something as: a format by its name, or a template (`template`) by its
 * title; with what it is for, where whoever chose it knows.
 */
export type DraftFormat = { noun: string; icon: FormatIconName; template?: true; description?: string }

/**
 * What a draft holds besides its words, each a pill at its start, ahead of them, that is deleted
 * as one character is: the skill or command it goes with, the format or template it starts with,
 * and the connections it gives the chat.
 */
export type DraftRegistry = {
  command: ItemDefinition<ComposerCommand, { key: string }>
  format: ItemDefinition<DraftFormat, null>
  connection: ItemDefinition<ComposerConnection, { key: string }>
}

/** A draft: its pills, then its words. */
export type DraftDocument = BillowDocument<DraftRegistry>
export type DraftPill = ItemNode<DraftRegistry>
/** A pill before it is in a draft, which gives it its id. */
export type NewDraftPill = { [Type in DraftPill['itemType']]: Pick<Extract<DraftPill, { itemType: Type }>, 'itemType' | 'data'> }[DraftPill['itemType']]

const isPill = (node: DraftDocument[number]): node is DraftPill => typeof node !== 'string'

/** The pills a draft has, which are all at its start, in the order they were added. */
export const draftPills = (draft: DraftDocument) => draft.filter(isPill)

// What is written after them, as it is.
const wordsOf = (draft: DraftDocument) => draft.filter((node) => typeof node === 'string').join('')

// A draft of these pills and these words.
const made = (pills: readonly DraftPill[], words: string): DraftDocument => (words ? [...pills, words] : pills)

/** The skill or command the draft goes with. */
export const draftCommand = (draft: DraftDocument) => draftPills(draft).find((pill) => pill.itemType === 'command')

/** The format or template the draft starts with. */
export const draftFormat = (draft: DraftDocument) => draftPills(draft).find((pill) => pill.itemType === 'format')

/** The connections the draft gives the chat, in the order they were added. */
export const draftConnections = (draft: DraftDocument): ComposerConnection[] =>
  draftPills(draft).flatMap((pill) => (pill.itemType === 'connection' ? [pill.data] : []))

/**
 * Whether a draft may be as it is: its pills all at its start, ahead of its words, as a message
 * is sent with what it holds named apart from what it says, not where it was written; and among
 * them one skill or command at most, one format at most, and each connection once. What would
 * make it otherwise, such as words typed ahead of a pill or a pill pasted among the words, is
 * not taken.
 */
export const draftAllowed = (draft: DraftDocument) => {
  const pills = draftPills(draft)
  const keys = pills.flatMap((pill) => (pill.itemType === 'connection' ? [pill.data.key] : []))
  return draft.slice(0, pills.length).every(isPill) &&
    pills.filter((pill) => pill.itemType === 'command').length <= 1 &&
    pills.filter((pill) => pill.itemType === 'format').length <= 1 &&
    new Set(keys).size === keys.length
}

/** The words of a draft, which are what is sent as its text: what is written after its pills. */
export const draftWords = (draft: DraftDocument) => wordsOf(draft).trim()

/** Whether there is anything in the draft at all, a pill or a word. */
export const draftIsEmpty = (draft: DraftDocument) => draftPills(draft).length === 0 && draftWords(draft) === ''

/**
 * A change to a draft that was not typed in it: what the draft then is, and where a place in it
 * as it was is in it then (`move`), for the cursor to be kept by. A place among the pills, where
 * the cursor cannot be, is the start of the words.
 */
export type DraftChange = { draft: DraftDocument; move: (position: number) => number }

/**
 * The draft with a pill after those it has, ahead of its words; or, given the pill it takes the
 * place of (`instead`), where that one was: a draft goes with one skill and starts with one format.
 */
export const withPill = (draft: DraftDocument, pill: DraftPill, instead?: string): DraftChange => {
  const pills = draftPills(draft)
  const next = pills.some(({ id }) => id === instead) ? pills.map((each) => (each.id === instead ? pill : each)) : [...pills, pill]
  return { draft: made(next, wordsOf(draft)), move: (position) => Math.max(position + next.length - pills.length, next.length) }
}

/** The draft without one of its pills. */
export const withoutPill = (draft: DraftDocument, id: string): DraftChange => {
  const pills = draftPills(draft)
  const next = pills.filter((each) => each.id !== id)
  return { draft: made(next, wordsOf(draft)), move: (position) => Math.max(position + next.length - pills.length, next.length) }
}

// The draft with `length` of its words gone from `found` in them, and one of the spaces they
// were between, so that taking them out strands no doubled or leading space; and with `added`
// after its pills.
const cut = (draft: DraftDocument, found: number, length: number, added: readonly DraftPill[] = []): DraftChange => {
  const words = wordsOf(draft)
  const before = words.slice(0, found)
  const after = words.slice(found + length)
  const closed = (!before || /\s$/.test(before)) && /^[^\S\n]/.test(after) ? 1 : 0
  const pills = draftPills(draft)
  const start = pills.length + found
  const end = start + length + closed
  return {
    draft: made([...pills, ...added], before + after.slice(closed)),
    move: (position) => {
      if (position < pills.length) return pills.length + added.length
      if (position <= start) return position + added.length
      return position >= end ? position + added.length - (end - start) : start + added.length
    },
  }
}

/**
 * The draft with a pill for some of its words (`text`, where it first is by itself), as a link
 * made a connection is: the words go, with one of the spaces they were between, and the pill
 * joins those at the start. Undefined where the words are not there, as when they were deleted
 * meanwhile.
 */
export const withPillForWords = (draft: DraftDocument, pill: DraftPill, text: string): DraftChange | undefined => {
  const words = wordsOf(draft)
  // On their own, not the start of longer ones: one link is often the start of another.
  const alone = (found: number) => !/\S/.test(words[found - 1] ?? ' ') && !/\S/.test(words[found + text.length] ?? ' ')
  let found = text ? words.indexOf(text) : -1
  while (found >= 0 && !alone(found)) found = words.indexOf(text, found + 1)
  return found < 0 ? undefined : cut(draft, found, text.length, [pill])
}

/**
 * The draft without `text` where it was written (`at`, a place in the draft), such as the slash
 * that opened the menu once something was chosen from it. Undefined where that is not what is
 * there any more.
 */
export const withoutWordsAt = (draft: DraftDocument, at: number, text: string): DraftChange | undefined => {
  const found = at - draftPills(draft).length
  return found >= 0 && text && wordsOf(draft).startsWith(text, found) ? cut(draft, found, text.length) : undefined
}

/**
 * What is left of a draft once the message it was sent as (`sent`) has gone: the format it
 * starts with, which is its keeper's to take off, and whatever it was given since. Undefined
 * where its words are no longer the ones that went, as when stopping the agent has put what was
 * waiting for it in the draft meanwhile: it then stays as it is.
 */
export const draftAfterSent = (draft: DraftDocument, sent: DraftDocument): DraftDocument | undefined => {
  if (wordsOf(draft) !== wordsOf(sent)) return undefined
  const went = new Set(draftPills(sent).map(({ id }) => id))
  return draftPills(draft).filter((pill) => pill.itemType === 'format' || !went.has(pill.id))
}

/**
 * The `/` or `@` just typed that opens the add menu: one that starts a word and has nothing
 * after it, where the cursor is (`offset` into `text`). Not one in the middle of a word, so that
 * a path, a fraction or an address is written as it is.
 */
export const menuOpenerAt = (text: string, offset: number): '/' | '@' | undefined => {
  const typed = text[offset - 1]
  if (typed !== '/' && typed !== '@') return undefined
  const starts = offset === 1 || /\s/.test(text[offset - 2] ?? '')
  return starts && !/^\S/.test(text.slice(offset)) ? typed : undefined
}

/**
 * A draft that opens with something in it: the format it starts with, the skill or command it
 * goes with, then its words. `id` names each pill, as the draft's editor would.
 */
export const draftOf = ({ text = '', command, format }: { text?: string; command?: ComposerCommand; format?: DraftFormat }, id: () => string): DraftDocument =>
  made([
    ...(format ? [{ type: 'item', id: id(), itemType: 'format', data: format } as const] : []),
    ...(command ? [{ type: 'item', id: id(), itemType: 'command', data: command } as const] : []),
  ], text)

/**
 * The draft's words and how far into them a place in the draft is: what a link being typed is
 * read from.
 */
export const wordsAround = (draft: DraftDocument, position: number): { text: string; offset: number } =>
  ({ text: wordsOf(draft), offset: Math.max(position - draftPills(draft).length, 0) })

/**
 * What adding `text` to the end of the draft changes: it goes after the words that are there as
 * a paragraph of its own, in place of any space they ended with, or is all the words of a draft
 * that had none.
 */
export const appendedText = (draft: DraftDocument, text: string): { range: ModelRange; replacement: DraftDocument } => {
  const end = documentLength(draft)
  const words = wordsOf(draft)
  if (words.trim() === '') return { range: { anchor: end - words.length, focus: end }, replacement: [text] }
  return { range: { anchor: end - (words.length - words.trimEnd().length), focus: end }, replacement: [`\n\n${text}`] }
}

/** How one pill reads where only text can be had: on the clipboard, and to a screen reader. */
export const pillText = (pill: NewDraftPill) =>
  pill.itemType === 'command' ? `/${pill.data.name}` : pill.itemType === 'format' ? pill.data.noun : pill.data.title

/** What a pill is, said to whoever cannot see it. */
export const pillLabel = (pill: NewDraftPill) => {
  if (pill.itemType === 'command') return `${pill.data.kind === 'skill' ? 'Skill' : 'Command'}: ${pill.data.title}`
  if (pill.itemType === 'format') return pill.data.template ? `Start with the ${pill.data.noun} template` : `Start with ${pill.data.noun}`
  return `Connection: ${pill.data.title}`
}
