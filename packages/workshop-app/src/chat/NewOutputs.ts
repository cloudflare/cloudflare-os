import type { ChatFeed, OutputItem } from './chatItems'

const isOutput = (item: { kind: string }): item is OutputItem => item.kind === 'output'

/**
 * Tells what a chat makes while it is open from what it had made by then, so that only the first
 * is shown without being asked for. What was there when the chat was opened is not, nor is what
 * comes in with its earlier history: only an output that turns up at the end of the conversation
 * (`pinned`), once.
 */
export class NewOutputs {
  #seen?: Set<string>

  /** The output made since this was last asked, the latest of several. None the first time, when all of them are what the chat had. */
  take({ items, pinned }: Pick<ChatFeed, 'items' | 'pinned'>): OutputItem | undefined {
    const first = this.#seen === undefined
    const seen = (this.#seen ??= new Set())
    const made = pinned.filter(isOutput).filter(({ key }) => !seen.has(key))
    for (const { key } of [...items, ...pinned].filter(isOutput)) seen.add(key)
    return first ? undefined : made.at(-1)
  }
}
