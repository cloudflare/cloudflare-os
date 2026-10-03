import { describe, expect, it } from 'vitest'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { isImeComposing } from './keyboardEvent'

function keyboardEvent(isComposing: boolean, keyCode: number): ReactKeyboardEvent {
  return { nativeEvent: { isComposing, keyCode } } as ReactKeyboardEvent
}

describe('isImeComposing', () => {
  it('detects standard composition events', () => {
    expect(isImeComposing(keyboardEvent(true, 13))).toBe(true)
  })

  it('detects the legacy Safari key code', () => {
    expect(isImeComposing(keyboardEvent(false, 229))).toBe(true)
  })

  it('allows ordinary keyboard events', () => {
    expect(isImeComposing(keyboardEvent(false, 13))).toBe(false)
  })
})
