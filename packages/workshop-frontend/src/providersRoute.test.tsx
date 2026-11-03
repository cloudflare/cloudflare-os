// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type { AiChatAuthorInfo, ChatGptSignInStart, ChatGptSignInStatus, ModelKind } from '@gadgets/workshop-shared/api'

const api = vi.hoisted(() => ({
  listModels: vi.fn<(kind?: ModelKind) => Promise<AiChatAuthorInfo[]>>(async (kind) => kind === 'decision'
    ? [{ type: 'agent', id: 'decision-model', name: 'Decision model' }]
    : [{ type: 'agent', id: 'chat-model', name: 'Chat model' }]),
  getQuickModel: async () => null,
  getAiConfig: async () => ({ enabled: false }),
  setQuickModel: vi.fn<(modelId: string | null) => Promise<void>>(async () => {}),
  getChatGptSignIn: vi.fn<() => Promise<ChatGptSignInStatus>>(async () => ({ state: 'unavailable' })),
  beginChatGptSignIn: vi.fn<() => Promise<ChatGptSignInStart>>(),
  completeChatGptSignIn: vi.fn<(callbackUrl: string) => Promise<ChatGptSignInStatus>>(),
  signOutChatGpt: vi.fn<() => Promise<void>>(async () => {}),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof Kumo>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: api }),
}))

import { Route } from './routes/providers'

// The route's component is code-split; load its chunk while collecting, outside the test timeout.
const ProvidersPage = Route.options.component!
await ProvidersPage.preload?.()

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
testGlobal.IS_REACT_ACT_ENVIRONMENT = true

async function menuItems(trigger: HTMLElement) {
  await act(async () => trigger.click())
  const items = Array.from(document.body.querySelectorAll('[role="menuitem"]'), item => item.textContent)
  await act(async () => trigger.click())
  return items
}

function nameOf(text: string) {
  return Array.from(document.body.querySelectorAll('span')).find(span => span.textContent === text)!
}

describe('ProvidersPage quick model', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    api.setQuickModel.mockClear()
  })

  async function renderPage() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<ProvidersPage />))
    await vi.waitFor(() => expect(document.body.textContent).toContain('Decision model'))
  }

  // A decision model as quick model would fail every title and binding-name request it was given.
  it('can be any language model but never a decision model', async () => {
    await renderPage()
    expect(document.body.textContent).toContain('Quick model:')

    expect(nameOf('Decision model').closest('[role="button"]')).toBeNull()
    await act(async () => nameOf('Decision model').click())
    expect(api.setQuickModel).not.toHaveBeenCalled()
    await act(async () => nameOf('Chat model').closest<HTMLElement>('[role="button"]')!.click())
    expect(api.setQuickModel).toHaveBeenCalledWith('chat-model')

    const [chatMenu, decisionMenu] = document.body.querySelectorAll<HTMLElement>('[aria-label="Provider actions"]')
    expect(await menuItems(chatMenu)).toContain('Clear quick model')
    expect(await menuItems(decisionMenu)).not.toContainEqual(expect.stringContaining('quick model'))
  })

  // Reachable by finishing onboarding without a model, then adding Clef for a blueprint.
  it('offers no quick model when only decision models are configured', async () => {
    api.listModels.mockResolvedValueOnce([])
    await renderPage()
    expect(document.body.textContent).not.toContain('Quick model:')
  })
})

// A stand-in for the tab the page opens, recording where it was sent.
function stubTab() {
  const tab = { opener: {} as unknown, location: { replace: vi.fn<(url: string) => void>() }, close: vi.fn<() => void>() }
  const open = vi.fn<(url: string, target: string) => typeof tab | null>(() => tab)
  vi.stubGlobal('open', open)
  return { tab, open }
}

function button(name: string) {
  const found = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent === name)
  if (!found) throw new Error(`No button ${name}`)
  return found
}

async function pasteAddress(address: string) {
  const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, address)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Connect').click())
}

describe('ProvidersPage Sign in with ChatGPT', () => {
  const START: ChatGptSignInStart = {
    authorizeUrl: 'https://auth.openai.com/oauth/authorize?state=abc',
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
  }
  const CALLBACK = 'http://127.0.0.1:1455/auth/callback?code=xyz&state=abc'

  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    api.getChatGptSignIn.mockReset().mockResolvedValue({ state: 'unavailable' })
    api.beginChatGptSignIn.mockReset()
    api.completeChatGptSignIn.mockReset()
    api.signOutChatGpt.mockClear()
  })

  async function renderPage(status: ChatGptSignInStatus) {
    api.getChatGptSignIn.mockResolvedValue(status)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<ProvidersPage />))
    await vi.waitFor(() => expect(document.body.textContent).toContain('Decision model'))
  }

  it('offers nothing while the deployment does not offer signing in', async () => {
    await renderPage({ state: 'unavailable' })
    expect(document.body.textContent).not.toContain('ChatGPT')
  })

  // A tab opened once the RPC has answered is no longer the click's, and the browser blocks it.
  it('opens the sign-in tab within the click, then finishes with the address the tab ends at', async () => {
    await renderPage({ state: 'signedOut' })
    const { tab, open } = stubTab()
    let answer!: (start: ChatGptSignInStart) => void
    api.beginChatGptSignIn.mockReturnValue(new Promise(resolve => { answer = resolve }))

    await act(async () => button('Sign in with ChatGPT').click())
    expect(open).toHaveBeenCalledOnce()
    expect(tab.opener).toBeNull()
    expect(tab.location.replace).not.toHaveBeenCalled()

    await act(async () => answer(START))
    expect(tab.location.replace).toHaveBeenCalledWith(START.authorizeUrl)
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('the tab will show an error page')
    expect(dialog.textContent).toContain('This site can’t be reached')
    expect(dialog.textContent).toContain('127.0.0.1:1455/auth/callback?code=')

    api.completeChatGptSignIn.mockResolvedValue({ state: 'signedIn', email: 'dan@example.com' })
    await pasteAddress(` ${CALLBACK} `)

    expect(api.completeChatGptSignIn).toHaveBeenCalledExactlyOnceWith(CALLBACK)
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull())
    expect(document.body.textContent).toContain('Signed in as dan@example.com')
  })

  it('shows why an address did not finish the sign-in, and lets the user try another', async () => {
    await renderPage({ state: 'signedOut' })
    stubTab()
    api.beginChatGptSignIn.mockResolvedValue(START)
    await act(async () => button('Sign in with ChatGPT').click())

    api.completeChatGptSignIn.mockRejectedValueOnce(new Error('This sign-in has expired. Start again.'))
    await pasteAddress(CALLBACK)

    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('This sign-in has expired. Start again.')
    expect(button('Connect').disabled).toBe(false)
    expect(document.body.textContent).not.toContain('Signed in as')
  })

  it('connects as soon as the sign-in address is pasted, and reloads the models', async () => {
    await renderPage({ state: 'signedOut' })
    stubTab()
    api.beginChatGptSignIn.mockResolvedValue(START)
    await act(async () => button('Sign in with ChatGPT').click())
    api.listModels.mockClear()
    api.completeChatGptSignIn.mockResolvedValue({ state: 'signedIn' })

    const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(paste, { clipboardData: { getData: () => ` ${CALLBACK}\n` } })
    await act(async () => input.dispatchEvent(paste))

    expect(api.completeChatGptSignIn).toHaveBeenCalledExactlyOnceWith(CALLBACK)
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull())
    // The sign-in added the subscription's models.
    expect(api.listModels).toHaveBeenCalled()
  })

  it('leaves other pasted text to be edited', async () => {
    await renderPage({ state: 'signedOut' })
    stubTab()
    api.beginChatGptSignIn.mockResolvedValue(START)
    await act(async () => button('Sign in with ChatGPT').click())

    const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(paste, { clipboardData: { getData: () => 'https://chatgpt.com/' } })
    await act(async () => input.dispatchEvent(paste))

    expect(paste.defaultPrevented).toBe(false)
    expect(api.completeChatGptSignIn).not.toHaveBeenCalled()
  })

  // OpenAI accepts the Workshop's own address there, so nothing has to be pasted.
  it('waits for the Workshop\'s own callback page when the sign-in returns here', async () => {
    await renderPage({ state: 'signedOut' })
    stubTab()
    api.beginChatGptSignIn.mockResolvedValue(
        { ...START, redirectUri: `${window.location.origin}/connect/chatgpt` })
    await act(async () => button('Sign in with ChatGPT').click())

    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Waiting for you to sign in')
    expect(dialog.querySelector('input')).toBeNull()

    api.getChatGptSignIn.mockResolvedValue({ state: 'signedIn', email: 'dan@example.com' })
    api.listModels.mockClear()
    const channel = new BroadcastChannel('chatgpt-sign-in')
    // oxlint-disable-next-line require-post-message-target-origin -- a BroadcastChannel takes no origin.
    await act(async () => channel.postMessage('signedIn'))
    channel.close()

    await vi.waitFor(() => expect(document.body.textContent).toContain('Signed in as dan@example.com'))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(api.listModels).toHaveBeenCalled()
  })

  it('links to the sign-in page when the browser blocked the tab', async () => {
    await renderPage({ state: 'signedOut' })
    vi.stubGlobal('open', vi.fn<() => null>(() => null))
    api.beginChatGptSignIn.mockResolvedValue(START)

    await act(async () => button('Sign in with ChatGPT').click())

    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('blocked the sign-in tab')
    expect(dialog.querySelector<HTMLAnchorElement>(`a[href="${START.authorizeUrl}"]`)).not.toBeNull()
  })

  it('shows who is signed in, and signs out', async () => {
    await renderPage({ state: 'signedIn' })
    expect(document.body.textContent).toContain('Signed in with ChatGPT')

    await act(async () => button('Sign out').click())

    expect(api.signOutChatGpt).toHaveBeenCalledOnce()
    expect(button('Sign in with ChatGPT')).toBeTruthy()
  })
})
