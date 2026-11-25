import { createContext } from 'react'

/** What the message list lets what is in it ask of the view. */
export type MessageScroll = {
  /**
   * The height of something at `at` has changed by `change`: keeps the reader's place. At the end of the
   * conversation that is following it; elsewhere, if what `at` pushed was what the reader can see or is
   * beyond it, the view goes with it, so that it stays where it was looked at.
   */
  keepPlace: (change: number, at: Element) => void
}

/** Outside a message list there is nothing to keep the place of. */
export const MessageScrollContext = createContext<MessageScroll | undefined>(undefined)
