import { describe, expect, it } from 'vitest'
import { couldBeSpaceId } from './spaceIds'

const ID = '0123456789abcdef'.repeat(4)

describe('couldBeSpaceId', () => {
  it.each([
    ['a'.repeat(64)],
    [ID],
    ['A'.repeat(64)],
    ['0123456789ABCDEF'.repeat(2) + '0123456789abcdef'.repeat(2)],
  ])('takes 64 hex digits, in either case: %s', (text) => {
    expect(couldBeSpaceId(text)).toBe(true)
  })

  it.each([
    ['nothing', ''],
    ['63 hex digits', 'a'.repeat(63)],
    ['65 hex digits', 'a'.repeat(65)],
    ['64 characters, one of them no hex digit', `${'a'.repeat(63)}g`],
    ['a word', 'platform'],
    ['an id after a space', ` ${ID}`],
    ['an id before a space', `${ID} `],
    ['an id before a line break', `${ID}\n`],
  ])('refuses every other shape: %s', (_shape, text) => {
    expect(couldBeSpaceId(text)).toBe(false)
  })
})
