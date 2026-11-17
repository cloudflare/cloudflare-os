import { describe, expect, it } from 'vitest'
import { clampText } from './clampText'

describe('clampText', () => {
  const text = 'Search, browse and edit the pages and files of a site, its lists and their items.'

  it('shows a text whole that is within its limit, or only a few words past it', () => {
    expect(clampText(text, 200)).toBeUndefined()
    expect(clampText(text, text.length - 10)).toBeUndefined()
  })

  it('cuts a longer one where a word ends, at or before the limit', () => {
    expect(clampText(text, 30)).toBe('Search, browse and edit the')
    expect(clampText(text, 27)).toBe('Search, browse and edit the')
  })

  it('leaves no punctuation at the end of what is kept', () => {
    expect(clampText(text, 55)).toBe('Search, browse and edit the pages and files of a site')
  })

  it('cuts a word longer than the limit where the limit falls', () => {
    expect(clampText('a'.repeat(100), 30)).toBe('a'.repeat(30))
  })
})
