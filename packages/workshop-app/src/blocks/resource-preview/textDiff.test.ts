import { describe, expect, it } from 'vitest'
import { diffWords, type DiffSegment } from './textDiff'

const side = (segments: DiffSegment[], keep: 'removed' | 'added') =>
  segments.filter(segment => segment.kind === 'same' || segment.kind === keep).map(segment => segment.text).join('')

describe('diffWords', () => {
  it('gives back each text exactly, whitespace and all', () => {
    const before = 'Off the court,  LeBron is also known\nfor his school.'
    const after = 'Off the court,  LeBron founded\nhis school, in Akron.'
    const segments = diffWords(before, after)!
    expect(side(segments, 'removed')).toBe(before)
    expect(side(segments, 'added')).toBe(after)
  })

  it('reads a rewritten phrase as one struck run, then one new run', () => {
    expect(diffWords('LeBron is also known for his school', 'LeBron founded the school')).toEqual([
      { kind: 'same', text: 'LeBron ' },
      { kind: 'removed', text: 'is also known for his' },
      { kind: 'added', text: 'founded the' },
      { kind: 'same', text: ' school' },
    ])
  })

  it('has nothing to strike for an unchanged text', () => {
    expect(diffWords('same words', 'same words')).toEqual([{ kind: 'same', text: 'same words' }])
  })

  it('declines texts too large to compare in a card', () => {
    const many = (word: string) => Array.from({ length: 2100 }, (_, i) => `${word}${i}`).join(' ')
    expect(diffWords(many('a'), many('b'))).toBeNull()
  })
})
