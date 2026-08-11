import { describe, expect, it } from 'vitest'
import type { MessageFormatRef } from '@gadgets/workshop-shared/api'
import { locateMessageFormatRefs } from '../messageFormatRefs'

function format(noun: string): Pick<MessageFormatRef, 'noun' | 'icon'> {
  return { noun, icon: 'fileText' }
}

const doc = format('Doc')
const slides = format('Slides')

describe('locateMessageFormatRefs', () => {
  it('finds each noun where it ended up in the sent text', () => {
    const text = 'create a Doc for homework and Slides for the presentation'
    const refs = locateMessageFormatRefs(text, [doc, slides])
    expect(refs).toHaveLength(2)
    expect(text.slice(refs![0].position, refs![0].position + refs![0].length)).toBe('Doc')
    expect(text.slice(refs![1].position, refs![1].position + refs![1].length)).toBe('Slides')
  })

  it('gives each of two identical formats its own occurrence', () => {
    // Searching from the previous match is what keeps the second ref off the first "Doc".
    const text = 'a Doc for homework and a Doc for the essay'
    const refs = locateMessageFormatRefs(text, [doc, doc])
    expect(refs).toHaveLength(2)
    expect(refs![0].position).toBe(text.indexOf('Doc'))
    expect(refs![1].position).toBe(text.lastIndexOf('Doc'))
  })

  it('carries the noun and icon through for rendering', () => {
    const refs = locateMessageFormatRefs('make Slides', [slides])
    expect(refs![0]).toMatchObject({ noun: 'Slides', icon: 'fileText' })
  })

  it('drops a format whose noun did not survive into the sent text', () => {
    // A slash command's arguments may not include the part of the line the format was in.
    expect(locateMessageFormatRefs('nothing here', [doc])).toBeUndefined()
  })

  it('keeps the formats it can find when another is missing', () => {
    const refs = locateMessageFormatRefs('only Slides made it', [doc, slides])
    expect(refs).toHaveLength(1)
    expect(refs![0].noun).toBe('Slides')
  })

  it('returns undefined when no formats were named', () => {
    expect(locateMessageFormatRefs('plain message', [])).toBeUndefined()
  })
})
