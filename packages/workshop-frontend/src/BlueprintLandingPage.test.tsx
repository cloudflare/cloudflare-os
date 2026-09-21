// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  BlueprintPublicInfo,
  PublicApi,
} from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn<() => void>(),
  useParams: () => ({ id: 'blueprint-one' }),
  useRouter: () => ({ history: { back: vi.fn<() => void>(), canGoBack: () => false } }),
}))

vi.mock('./useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    authenticatedApi: testState.authenticatedApi,
    isLoading: false,
    login: vi.fn<(token: string) => void>(),
  }),
}))

import BlueprintLandingPage from './BlueprintLandingPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const originalInnerWidth = window.innerWidth

const MODEL: AiChatAuthorInfo = {
  type: 'agent',
  id: 'model-one',
  name: 'Model one',
}

const BLUEPRINT: BlueprintPublicInfo = {
  id: 'blueprint-one',
  metadata: {
    title: 'Model blueprint',
    description: 'Requires an AI model.',
    author: { type: 'user', id: 'author', name: 'Author' },
    created: new Date('2026-08-24T00:00:00Z'),
    version: 1,
    lastUpdated: new Date('2026-08-24T00:00:00Z'),
    bindings: {
      AI: {
        type: 'aiModel',
        title: 'Claude Sonnet 5',
        description: '',
      },
    },
  },
}

function subscription() {
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
    [Symbol.dispose]() {},
  })
}

function authenticatedApi(): RpcStub<AuthenticatedApi> {
  return {
    listModels: async () => [MODEL],
    listGatekeeperVendors: async () => [],
    subscribeConnectedAccounts: subscription,
    getAdminApi: async () => null,
    isBlueprintInLibrary: async () => null,
    isBlueprintPinned: async () => false,
    getOwnBlueprint: async () => null,
  } as unknown as RpcStub<AuthenticatedApi>
}

function publicApi(): RpcStub<PublicApi> {
  return {
    getBlueprint: async () => BLUEPRINT,
  } as unknown as RpcStub<PublicApi>
}

describe('BlueprintLandingPage model configuration', () => {
  let root: Root | undefined
  let rootContainer: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    rootContainer?.remove()
    testState.authenticatedApi = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  })

  it('portals model options above the configure dialog and accepts a selection', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    testState.authenticatedApi = authenticatedApi()
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)

    await act(async () => root!.render(<BlueprintLandingPage rpcStub={publicApi()} />))
    await act(async () => { await Promise.resolve() })

    const configure = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent === 'Configure')!
    await act(async () => configure.click())

    const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Choose an AI model"]')!
    await act(async () => trigger.click())

    const option = document.body.querySelector<HTMLElement>('[role="option"]')!
    const portalHost = option.closest('[data-base-ui-portal]')!.parentElement!
    expect(portalHost.parentElement).toBe(document.body)
    expect(portalHost.style.position).toBe('relative')
    expect(portalHost.style.zIndex).toBe('1100')

    await act(async () => option.click())
    expect(trigger.textContent).toContain('Model one')

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Save connection')!
    expect(save.disabled).toBe(false)
  })
})
