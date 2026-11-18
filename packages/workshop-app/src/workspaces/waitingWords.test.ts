import { describe, expect, it } from 'vitest'
import { gadgetsWaitingIn, waitingWords } from './waitingWords'

describe('waitingWords', () => {
  it('names the one kind that waits, and only how many where several do', () => {
    expect(waitingWords({ runs: 0, gadgets: 0, chats: 0 })).toBeUndefined()
    expect(waitingWords({ runs: 1, gadgets: 0, chats: 0 })).toBe('An agent needs you')
    expect(waitingWords({ runs: 2, gadgets: 0, chats: 0 })).toBe('2 agent runs need you')
    expect(waitingWords({ runs: 0, gadgets: 1, chats: 0 })).toBe('A gadget needs you')
    expect(waitingWords({ runs: 0, gadgets: 0, chats: 3 })).toBe('3 chats need you')
    expect(waitingWords({ runs: 1, gadgets: 1, chats: 1 })).toBe('3 things need you')
  })

  it('counts the gadgets of one workspace that wait', () => {
    expect(gadgetsWaitingIn('a', new Map([['a/1', 2], ['a/2', 0], ['ab/3', 1], ['a/4', 1]]))).toBe(2)
  })
})
