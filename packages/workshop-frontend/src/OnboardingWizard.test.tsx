// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AiModelConfig, AiModelProvider, AuthenticatedApi } from '@gadgets/workshop-shared/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Lets tests drive what the mocked SeatSignInButtons hands back to onEnrolled without going
// through the real OAuth walkthrough — that flow is covered by SeatSignInButtons.test.tsx.
// Declared with vi.hoisted so the vi.mock factory below (hoisted above imports) can see it.
const seatSignIn = vi.hoisted(() => ({
  provider: 'anthropic' as AiModelProvider,
  handle: 'seat-handle-super-secret',
  models: ['claude-opus-5', 'claude-sonnet-5'] as string[],
  apiUrl: 'https://seat-proxy.example/anthropic',
}))

const toastAdd = vi.fn<(toast: { title: string, variant?: string }) => void>()
let currentApi: RpcStub<AuthenticatedApi>

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: toastAdd }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: currentApi,
    currentUser: { type: 'user', id: 'dan@example.com', name: 'Dan' },
    logout: vi.fn(),
    isAdmin: false,
  }),
}))

vi.mock('./ThemeContext', () => ({
  useTheme: () => ({ resolvedThemeMode: 'light' }),
}))

vi.mock('./ServerConfigContext', () => ({
  useSiteName: () => 'Gadgets',
  useServerConfig: () => null,
}))

vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

vi.mock('./AddModelModal', () => ({ default: () => null }))

vi.mock('./SeatSignInButtons', () => ({
  default: (
    { onEnrolled }: {
      onEnrolled: (provider: AiModelProvider, handle: string, models: string[], apiUrl: string) => void,
    },
  ) => (
    <button
      type="button"
      onClick={() => onEnrolled(seatSignIn.provider, seatSignIn.handle, seatSignIn.models, seatSignIn.apiUrl)}
    >
      Sign in with Claude subscription
    </button>
  ),
}))

import OnboardingWizard from './OnboardingWizard'

function fakeApi(addModel: RpcStub<AuthenticatedApi>['addModel']): RpcStub<AuthenticatedApi> {
  return {
    listModels: async () => [],
    getAiConfig: async () => ({ enabled: false }),
    listGatekeeperVendors: async () => [],
    subscribeConnectedAccounts: async () => ({ [Symbol.dispose]() {} }),
    addModel,
  } as unknown as RpcStub<AuthenticatedApi>
}

function click(element: Element) {
  return act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function button(rendered: HTMLElement, label: string): HTMLButtonElement {
  const found = [...rendered.querySelectorAll('button')].find(candidate =>
    candidate.textContent?.trim() === label)
  if (!found) throw new Error(`No button labelled "${label}"`)
  return found
}

describe('OnboardingWizard seat enrollment', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    toastAdd.mockClear()
    seatSignIn.models = ['claude-opus-5', 'claude-sonnet-5']
  })

  async function render(addModel: RpcStub<AuthenticatedApi>['addModel']) {
    currentApi = fakeApi(addModel)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<OnboardingWizard onComplete={vi.fn()} />)
    })
    return { rendered: container }
  }

  it('adds every model the seat returned', async () => {
    const calls: [AiChatAuthorInfo, AiModelConfig][] = []
    const addModel = vi.fn(async (profile: AiChatAuthorInfo, config: AiModelConfig) => {
      calls.push([profile, config])
    })
    const { rendered } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    await click(button(rendered, 'Sign in with Claude subscription'))

    expect(addModel).toHaveBeenCalledTimes(2)
    expect(calls[0]).toEqual([
      { type: 'agent', id: 'claude-opus-5', name: 'Claude Opus 5' },
      { provider: 'anthropic', model: 'claude-opus-5', apiToken: 'seat-handle-super-secret', apiUrl: 'https://seat-proxy.example/anthropic' },
    ])
    expect(calls[1]).toEqual([
      { type: 'agent', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { provider: 'anthropic', model: 'claude-sonnet-5', apiToken: 'seat-handle-super-secret', apiUrl: 'https://seat-proxy.example/anthropic' },
    ])
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: '2 AI models added successfully', variant: 'success' }),
    )

    // The handle is a bearer credential and must never reach the DOM.
    expect(rendered.textContent).not.toContain('seat-handle-super-secret')
    expect(rendered.innerHTML).not.toContain('seat-handle-super-secret')
  })

  it('reports a partial failure and still selects the first model that succeeded', async () => {
    const addModel = vi.fn(async (_profile: AiChatAuthorInfo, config: AiModelConfig) => {
      if (config.model === 'claude-opus-5') throw new Error('upstream rejected')
    })
    const { rendered } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    await click(button(rendered, 'Sign in with Claude subscription'))

    expect(addModel).toHaveBeenCalledTimes(2)
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Added 1 of 2 models from your subscription — some failed.',
        variant: 'error',
      }),
    )
    expect(toastAdd).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }))
  })

  it('shows the existing empty-list error toast and adds nothing when the seat has no models', async () => {
    seatSignIn.models = []
    const addModel = vi.fn(async () => {})
    const { rendered } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    await click(button(rendered, 'Sign in with Claude subscription'))

    expect(addModel).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Signed in, but no models were found for this subscription. Add one manually below.',
        variant: 'error',
      }),
    )
  })
})
