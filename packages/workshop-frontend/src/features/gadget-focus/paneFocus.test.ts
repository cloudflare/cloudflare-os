import { describe, expect, it } from 'vitest'
import { focusForChat, focusLabel, messageFocusOf } from './paneFocus'

const budget = { gadgetId: 3, gadgetTitle: 'Budget' }
const spot = { anchor: 'sheet/q3/cell/B7', label: 'Q3 › cell B7' }

describe('focusLabel', () => {
  it('names the gadget, then the spot when there is one', () => {
    expect(focusLabel(budget)).toBe('Budget')
    expect(focusLabel({ ...budget, spot })).toBe('Budget › Q3 › cell B7')
  })
})

describe('focusForChat', () => {
  it("offers an accepted gadget's focus to any chat, and to a new one", () => {
    const pane = { focus: budget, offerId: 1, pendingChatId: undefined }
    expect(focusForChat(pane, 5)).toBe(pane)
    expect(focusForChat(pane, null)).toBe(pane)
  })

  // The server refuses the whole message otherwise.
  it("offers a pending gadget's focus only to the chat it is pending in", () => {
    const pane = { focus: budget, offerId: 1, pendingChatId: 5 }
    expect(focusForChat(pane, 5)).toBe(pane)
    expect(focusForChat(pane, 6)).toBeUndefined()
    expect(focusForChat(pane, null)).toBeUndefined()
  })

  it('offers nothing when the pane shows no gadget', () => {
    expect(focusForChat(undefined, 5)).toBeUndefined()
  })
})

describe('messageFocusOf', () => {
  it('leaves out the title, which the server stamps', () => {
    expect(messageFocusOf(budget)).toStrictEqual({ gadgetId: 3 })
    expect(messageFocusOf({ ...budget, spot })).toStrictEqual({ gadgetId: 3, spot })
  })
})
