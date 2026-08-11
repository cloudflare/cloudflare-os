// Records where each format the user named ended up in the message that actually gets sent.
//
// The text is rewritten several times between composer and wire (logo slots removed, capsules
// replaced by `[i]`, a slash command stripped, the result trimmed). The nouns survive verbatim and
// in order, so their positions are found in the finished text rather than threaded through every
// step.
//
// Searching left to right from the previous match is what makes this exact for tokens: an
// identical earlier noun would itself have been a token, and would have consumed that occurrence
// first. A hand-typed noun can still take a chip's place, which is cosmetic -- it names the same
// format.

import type { MessageFormatRef } from '@gadgets/workshop-shared/api'

export function locateMessageFormatRefs(
  text: string,
  formats: readonly Pick<MessageFormatRef, 'noun' | 'icon'>[],
): MessageFormatRef[] | undefined {
  if (formats.length === 0) return undefined

  const refs: MessageFormatRef[] = []
  let cursor = 0
  for (const format of formats) {
    const noun = format.noun
    const position = text.indexOf(noun, cursor)
    // A noun can genuinely go missing: a slash command's arguments may not include the part of the
    // line the format was in. Dropping the ref leaves the message correct, just unadorned.
    if (position < 0) continue
    refs.push({
      position,
      length: noun.length,
      noun,
      icon: format.icon,
    })
    cursor = position + noun.length
  }
  return refs.length > 0 ? refs : undefined
}
