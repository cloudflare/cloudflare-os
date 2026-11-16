import type { MessageFormatRef, OutputIcon } from '@gadgets/workshop-shared/api'

/** A format a message asks for something as, by the name the deployment offers it under. */
export type StartFormat = { noun: string; icon: OutputIcon }

/**
 * The message that asks for `format`, with whatever `text` says of it: the format's name, then the
 * text. The agent reads the name as anyone would, as when it is typed, and the message says where
 * the name is, so that it is drawn as the format (`MessageFormatRef`). Exactly the name, or the
 * server drops it.
 */
export const startWithFormat = ({ noun, icon }: StartFormat, text: string): { text: string; formats: MessageFormatRef[] } => ({
  text: text ? `${noun} ${text}` : noun,
  formats: [{ position: 0, length: noun.length, noun, icon }],
})
