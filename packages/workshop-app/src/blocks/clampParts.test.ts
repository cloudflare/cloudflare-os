import { describe, expect, it } from 'vitest'
import { clampParts } from './clampParts'

type Part = { type: 'text'; text: string } | { type: 'chip'; title: string }
const text = (words: string): Part => ({ type: 'text', text: words })
const chip = (title: string): Part => ({ type: 'chip', title })
const lengthOf = (part: Part) => (part.type === 'chip' ? part.title.length : part.text.length)

describe('clampParts', () => {
  it('shows a message whole where it is not much longer than the limit', () => {
    expect(clampParts([text('a'.repeat(110))], 100, lengthOf)).toBeUndefined()
  })

  it('cuts the text the limit falls in where a word ends, leaving the rest out', () => {
    const words = 'one two three four five six seven eight nine ten '.repeat(3)
    expect(clampParts([text(words), chip('Report'), text(' and more')], 24, lengthOf)).toEqual([text('one two three four five')])
  })

  it('keeps whole what it reaches before the limit, chips among it, and nothing dangling after', () => {
    const parts = [text('Look at '), chip('Q3 report'), text(', then sum up. '), text('x'.repeat(80))]
    expect(clampParts(parts, 32, lengthOf)).toEqual([text('Look at '), chip('Q3 report'), text(', then sum up')])
  })

  it('leaves out a chip the limit falls in, with the rest', () => {
    expect(clampParts([text('See '), chip('A very long attachment name indeed'), text('y'.repeat(60))], 10, lengthOf)).toEqual([text('See')])
  })
})
