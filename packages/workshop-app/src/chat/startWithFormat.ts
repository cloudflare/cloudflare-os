import type { MessageFormatRef, OutputIcon } from '@gadgets/workshop-shared/api'

/**
 * What a message asks for something as: a format, by the name the deployment offers it under, or
 * a template (`template`), by its title.
 */
export type StartFormat = { noun: string; icon: OutputIcon; template?: true }

/**
 * The message that asks for `format`, with whatever `text` says of it: the format's name, then the
 * text; or, for a template, a sentence that names it, then the text. The agent reads the name as
 * anyone would, as when it is typed, and finds a template among those it can list by its title.
 * The message says where the name is, so that it is drawn as the format (`MessageFormatRef`).
 * Exactly the name, or the server drops it.
 */
export const startWithFormat = ({ noun, icon, template }: StartFormat, text: string): { text: string; formats: MessageFormatRef[] } => {
  const before = template ? 'Use the ' : ''
  const named = `${before}${noun}${template ? ' template.' : ''}`
  return {
    text: text ? `${named} ${text}` : named,
    formats: [{ position: before.length, length: noun.length, noun, icon }],
  }
}
