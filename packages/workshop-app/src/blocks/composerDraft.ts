import { documentLength, type BillowDocument, type ItemDefinition, type ItemNode, type ModelRange } from '@gadgets/billow'
import type { FormatIconName } from '@/components/FormatIcon'
import type { ComposerCommand } from './composerCommand'
import type { ComposerConnection } from './ComposerConnectionLines'
import { linksIn } from './draftLinks'

/**
 * What a draft asks for something as: a format by its name, or a template (`template`) by its
 * title; with what it is for, where whoever chose it knows.
 */
export type DraftFormat = { noun: string; icon: FormatIconName; template?: true; description?: string }

/** A link written in a draft, drawn as a pill where it was written and sent as the link it is. */
export type DraftLink = { url: string }

/**
 * What a draft holds besides its words, each a pill at its start, ahead of them, that is deleted
 * as one character is: the skill or command it goes with, the format or template it starts with,
 * and the connections it gives the chat. And among its words, the links written in it, each a
 * pill where it was written, which is one of its words.
 */
export type DraftRegistry = {
  command: ItemDefinition<ComposerCommand, { key: string }>
  format: ItemDefinition<DraftFormat, null>
  connection: ItemDefinition<ComposerConnection, { key: string }>
  link: ItemDefinition<DraftLink, DraftLink>
}

/** A draft: its pills, then its words. */
export type DraftDocument = BillowDocument<DraftRegistry>
export type DraftPill = ItemNode<DraftRegistry>
/** A link's pill, among the words. */
export type DraftLinkPill = Extract<DraftPill, { itemType: 'link' }>
/** A pill before it is in a draft, which gives it its id. */
export type NewDraftPill = { [Type in DraftPill['itemType']]: Pick<Extract<DraftPill, { itemType: Type }>, 'itemType' | 'data'> }[DraftPill['itemType']]

const isLink = (node: DraftDocument[number]): node is DraftLinkPill => typeof node !== 'string' && node.itemType === 'link'
const isPill = (node: DraftDocument[number]): node is DraftPill => typeof node !== 'string' && !isLink(node)

/** The pills a draft has, which are all at its start, in the order they were added. Not its links, which are among its words. */
export const draftPills = (draft: DraftDocument) => draft.filter(isPill)

// What stands for a link's pill in the words, where they are read as text: one character, as
// the pill is one place in the draft, so that a place in the words is one in the draft.
const LINK = '\uFFFC'

// What is written after them, as it is, with each link one character.
const wordsOf = (draft: DraftDocument) => draft.filter((node) => !isPill(node)).map((node) => (typeof node === 'string' ? node : LINK)).join('')

// The links among the words, in the order they are written.
const linksOf = (draft: DraftDocument) => draft.filter(isLink)

// A draft of these pills and these words, with `links` where the words have one, in order.
const made = (pills: readonly DraftPill[], words: string, links: readonly DraftLinkPill[] = []): DraftDocument => {
  const pieces = words.split(LINK)
  return [...pills, ...pieces.flatMap((piece, index) => [...(piece ? [piece] : []), ...(links[index] && index < pieces.length - 1 ? [links[index]] : [])])]
}

// Where each link is in the words.
const linkPlaces = (words: string) => [...words.matchAll(new RegExp(LINK, 'g'))].map(({ index }) => index)

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
export const draftWords = (draft: DraftDocument) => textOf(draft).trim()

// The words as they are sent, each link written out. A link's pill is drawn apart from what comes
// after it, so it is sent apart from it too where that would otherwise run on into the link.
const textOf = (draft: DraftDocument) => draft.map((node, index) => {
  if (typeof node === 'string') return node
  if (!isLink(node)) return ''
  const { url } = node.data
  const next = draft[index + 1]
  const after = typeof next === 'string' ? next : next && isLink(next) ? next.data.url : ''
  return after && linksIn(url + after)[0] !== url ? `${url} ` : url
}).join('')

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
  return { draft: made(next, wordsOf(draft), linksOf(draft)), move: (position) => Math.max(position + next.length - pills.length, next.length) }
}

/** The draft without one of its pills. */
export const withoutPill = (draft: DraftDocument, id: string): DraftChange => {
  const pills = draftPills(draft)
  const next = pills.filter((each) => each.id !== id)
  return { draft: made(next, wordsOf(draft), linksOf(draft)), move: (position) => Math.max(position + next.length - pills.length, next.length) }
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
  // Those links not among what goes.
  const places = linkPlaces(words)
  const links = linksOf(draft).filter((_, index) => places[index] < found || places[index] >= found + length)
  return {
    draft: made([...pills, ...added], before + after.slice(closed), links),
    move: (position) => {
      if (position < pills.length) return pills.length + added.length
      if (position <= start) return position + added.length
      return position >= end ? position + added.length - (end - start) : start + added.length
    },
  }
}

// Where `text` first is by itself in the words, not the start of longer ones: one link is often
// the start of another.
const aloneIn = (words: string, text: string) => {
  const alone = (found: number) => !/\S/.test(words[found - 1] ?? ' ') && !/\S/.test(words[found + text.length] ?? ' ')
  let found = text ? words.indexOf(text) : -1
  while (found >= 0 && !alone(found)) found = words.indexOf(text, found + 1)
  return found
}

/**
 * The draft with a pill for some of its words (`text`, where it first is by itself, or the pill
 * of a link that is it), as a link made a connection is: the words go, with one of the spaces
 * they were between, and the pill joins those at the start. Undefined where the words are not
 * there, as when they were deleted meanwhile.
 */
export const withPillForWords = (draft: DraftDocument, pill: DraftPill, text: string): DraftChange | undefined => {
  const words = wordsOf(draft)
  const link = linksOf(draft).findIndex(({ data }) => data.url === text)
  if (link >= 0) return cut(draft, linkPlaces(words)[link], 1, [pill])
  const found = aloneIn(words, text)
  return found < 0 ? undefined : cut(draft, found, text.length, [pill])
}

/**
 * The draft with a link that is written out in its words (where it first is by itself) as its
 * pill, `link`, where it was written, and a space after it where it ends them, as one pasted
 * does, for the next word to be written after. Undefined where it is not written out there.
 */
export const withLinkForWords = (draft: DraftDocument, link: DraftLinkPill): DraftChange | undefined => {
  const words = wordsOf(draft)
  const found = aloneIn(words, link.data.url)
  if (found < 0) return undefined
  const { length } = link.data.url
  const places = linkPlaces(words)
  const links = linksOf(draft)
  const before = places.filter((place) => place < found).length
  const pills = draftPills(draft)
  const start = pills.length + found
  const rest = words.slice(found + length)
  const spaced = rest ? 0 : 1
  return {
    draft: made(pills, words.slice(0, found) + LINK + (rest || ' '), [...links.slice(0, before), link, ...links.slice(before)]),
    move: (position) => (position <= start ? position : position >= start + length ? position - length + 1 + spaced : start + 1),
  }
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
  if (textOf(draft) !== textOf(sent)) return undefined
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
  pill.itemType === 'command' ? `/${pill.data.name}` : pill.itemType === 'format' ? pill.data.noun : pill.itemType === 'link' ? pill.data.url : pill.data.title

/** The site a link is on, which its pill is called by: its host, without a leading `www.`. */
export const linkSite = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** What a pill is, said to whoever cannot see it. */
export const pillLabel = (pill: NewDraftPill) => {
  if (pill.itemType === 'command') return `${pill.data.kind === 'skill' ? 'Skill' : 'Command'}: ${pill.data.title}`
  if (pill.itemType === 'format') return pill.data.template ? `Start with the ${pill.data.noun} template` : `Start with ${pill.data.noun}`
  if (pill.itemType === 'link') return `Link: ${pill.data.url}`
  return `Connection: ${pill.data.title}`
}
