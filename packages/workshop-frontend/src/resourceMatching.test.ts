import { describe, expect, it } from 'vitest'
import { normalizeResourceUrl } from './resourceMatching'

describe('resource URL normalization', () => {
  it('preserves custom schemes while supplying HTTPS for bare hosts', () => {
    expect(normalizeResourceUrl('gitlab://inspekter-estate/*')).toBe('gitlab://inspekter-estate')
    expect(normalizeResourceUrl('inspekter-estate/*')).toBe('https://inspekter-estate')
  })
})
