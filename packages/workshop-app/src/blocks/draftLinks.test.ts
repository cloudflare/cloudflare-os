import { describe, expect, it } from 'vitest'
import { linkEndedAt, linksIn } from './draftLinks'

describe('linksIn', () => {
  it('finds each link once, without what ends it in prose', () => {
    expect(linksIn('See https://a.example/x, then (https://b.example/y). And https://a.example/x again.'))
      .toEqual(['https://a.example/x', 'https://b.example/y'])
    expect(linksIn('nothing here, nor http://plain.example')).toEqual([])
  })
})

const typed = (text: string) => linkEndedAt(text, text.length)

describe('linkEndedAt', () => {
  it('is the link a space or a new line was just typed after', () => {
    expect(typed('Look at https://a.example/x ')).toBe('https://a.example/x')
    expect(typed('https://a.example/x\n')).toBe('https://a.example/x')
    expect(typed('Is it https://a.example/x? ')).toBe('https://a.example/x')
  })

  it('is nothing while a link is being typed, or where a word that is not one ended', () => {
    expect(typed('Look at https://a.example/x')).toBeUndefined()
    expect(typed('https://a.example/x and ')).toBeUndefined()
    expect(typed('https:// ')).toBeUndefined()
    expect(linkEndedAt('https://a.example/x  more', 20)).toBe('https://a.example/x')
  })
})
