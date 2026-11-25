import { describe, expect, it } from 'vitest'
import { greeting } from './greeting'

describe('greeting', () => {
  it('greets by display name, and by what the chat is started beside when it is', () => {
    expect(greeting('Ada Lovelace')).toBe('Hello Ada Lovelace, what should we do today?')
    expect(greeting('Ada Lovelace', 'Slides')).toBe('Hello Ada Lovelace, what should we do with Slides?')
    expect(greeting('  ')).toBe('Hello, what should we do today?')
  })
})
