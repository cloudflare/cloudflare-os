// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatGptSignInStatus } from '@gadgets/workshop-shared/api'

const api = vi.hoisted(() => ({
  completeChatGptSignIn: vi.fn<(callbackUrl: string) => Promise<ChatGptSignInStatus>>(),
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: api }),
}))

import { ChatGptCallbackPage } from './ChatGptCallbackPage'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
testGlobal.IS_REACT_ACT_ENVIRONMENT = true

const CALLBACK = '/connect/chatgpt?code=xyz&state=abc&client_id=issued'

describe('ChatGptCallbackPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let announced: unknown[]
  let channel: BroadcastChannel

  beforeEach(() => {
    window.history.replaceState(null, '', CALLBACK)
    announced = []
    channel = new BroadcastChannel('chatgpt-sign-in')
    channel.addEventListener('message', (event) => announced.push(event.data))
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    channel.close()
    api.completeChatGptSignIn.mockReset()
  })

  async function renderPage() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<StrictMode><ChatGptCallbackPage /></StrictMode>))
  }

  it('finishes the sign-in once, hides the code, and tells the tab that started it', async () => {
    api.completeChatGptSignIn.mockResolvedValue({ state: 'signedIn' })
    await renderPage()

    expect(api.completeChatGptSignIn).toHaveBeenCalledExactlyOnceWith(
        `${window.location.origin}${CALLBACK}`)
    expect(window.location.search).toBe('')
    await vi.waitFor(() => expect(container!.textContent).toContain('You can close this tab'))
    await vi.waitFor(() => expect(announced).toEqual(['signedIn']))
  })

  it('says why the sign-in failed, and tells no one', async () => {
    api.completeChatGptSignIn.mockRejectedValue(new Error('This sign-in has expired.'))
    await renderPage()

    await vi.waitFor(() => expect(container!.textContent).toContain('This sign-in has expired.'))
    expect(announced).toEqual([])
  })
})
