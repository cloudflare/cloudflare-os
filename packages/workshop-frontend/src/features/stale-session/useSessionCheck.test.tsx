// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_CHECK_INTERVAL_MS, useSessionCheck } from './useSessionCheck'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

let visibility: DocumentVisibilityState = 'visible'
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useSessionCheck', () => {
  let root: Root
  const check = vi.fn<() => void>()

  const Checker = () => {
    useSessionCheck(check)
    return null
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    check.mockReset()
    root = createRoot(document.createElement('div'))
    await act(async () => { root.render(<Checker />) })
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('checks when the tab becomes visible, and not when it is hidden', () => {
    setVisibility('hidden')
    expect(check).not.toHaveBeenCalled()
    setVisibility('visible')
    expect(check).toHaveBeenCalledOnce()
  })

  it('checks when the network comes back while visible', () => {
    window.dispatchEvent(new Event('online'))
    expect(check).toHaveBeenCalledOnce()
    visibility = 'hidden'
    window.dispatchEvent(new Event('online'))
    expect(check).toHaveBeenCalledOnce()
  })

  it('checks on the interval only while visible', () => {
    vi.advanceTimersByTime(SESSION_CHECK_INTERVAL_MS - 1)
    expect(check).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(check).toHaveBeenCalledOnce()
    visibility = 'hidden'
    vi.advanceTimersByTime(SESSION_CHECK_INTERVAL_MS)
    expect(check).toHaveBeenCalledOnce()
  })

  it('stops checking once unmounted', () => {
    act(() => root.unmount())
    setVisibility('visible')
    window.dispatchEvent(new Event('online'))
    vi.advanceTimersByTime(SESSION_CHECK_INTERVAL_MS)
    expect(check).not.toHaveBeenCalled()
    root = createRoot(document.createElement('div'))
  })
})
