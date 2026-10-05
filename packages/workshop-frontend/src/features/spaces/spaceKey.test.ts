import { describe, expect, it } from 'vitest'
import { isValidSpaceKey, isValidTeamSpaceKey } from '@gadgets/workshop-shared/api'
import { spaceKeyFromSearch, suggestSpaceKey } from './spaceKey'

describe('suggestSpaceKey', () => {
  it('derives a key from the letters and digits of a name', () => {
    expect(suggestSpaceKey('Platform Team')).toBe('platform-team')
    expect(suggestSpaceKey('  R&D / 2026 plans!  ')).toBe('r-d-2026-plans')
    expect(suggestSpaceKey('Café Zürich')).toBe('cafe-zurich')
  })

  it('never suggests a key the server would refuse', () => {
    // Too short, nothing in the key alphabet, or nothing at all.
    expect(suggestSpaceKey('A')).toBe('')
    expect(suggestSpaceKey('日本語')).toBe('')
    expect(suggestSpaceKey('---')).toBe('')
    expect(suggestSpaceKey('')).toBe('')

    // Cut to the longest key allowed, without leaving a dash at the cut.
    const long = suggestSpaceKey(`${'a'.repeat(31)} bcd`)
    expect(long).toBe('a'.repeat(31))
    expect(suggestSpaceKey('x'.repeat(80))).toBe('x'.repeat(32))
    expect(isValidTeamSpaceKey(long)).toBe(true)
  })
})

describe('spaceKeyFromSearch', () => {
  it('takes a key of the kind the route accepts, and nothing else', () => {
    expect(spaceKeyFromSearch('platform', isValidTeamSpaceKey)).toBe('platform')
    expect(spaceKeyFromSearch('~ada', isValidSpaceKey)).toBe('~ada')

    // A personal key where only a team space will do, a malformed key, and not a string at all.
    expect(spaceKeyFromSearch('~ada', isValidTeamSpaceKey)).toBeUndefined()
    expect(spaceKeyFromSearch('Not A Key', isValidSpaceKey)).toBeUndefined()
    expect(spaceKeyFromSearch(['platform'], isValidSpaceKey)).toBeUndefined()
    expect(spaceKeyFromSearch(undefined, isValidSpaceKey)).toBeUndefined()
  })
})
