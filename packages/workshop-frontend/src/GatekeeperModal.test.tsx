// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
  readinessEvents: [] as (boolean | null)[],
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('./ResourceConfiguratorHost', async () => {
  const { useEffect } = await import('react')

  const ResourceConfiguratorHost = ({
    frame,
    loading,
    disabled,
    onCollectResourceUrlChange,
    onSelectionReadyChange,
  }: {
    frame: object | null
    loading: boolean
    disabled: boolean
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
  }) => {
    const mounted = Boolean(frame && !loading && !disabled)
    useEffect(() => {
      if (!mounted) return
      onCollectResourceUrlChange?.(() => Promise.resolve('https://catalog.example.com/'))
      testState.readinessEvents.push(null)
      onSelectionReadyChange?.(null)
      return () => onCollectResourceUrlChange?.(null)
    }, [mounted, onCollectResourceUrlChange, onSelectionReadyChange])
    return mounted ? <div data-testid="resource-configurator" /> : null
  }

  return { default: ResourceConfiguratorHost }
})

import GatekeeperModal from './GatekeeperModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESOURCE = {
  urlPattern: 'https://catalog.example.com/*',
  title: 'Service catalog',
  description: 'Example service catalog',
}

function subscription() {
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
    [Symbol.dispose]() {},
  })
}

const CHAT_MODEL: AiChatAuthorInfo = { type: 'agent', id: 'chat-model', name: 'Chat model' }
const CLASSIFIER_MODEL: AiChatAuthorInfo = { type: 'agent', id: 'classifier-model', name: 'Classifier model' }

function authenticatedApi(): RpcStub<AuthenticatedApi> {
  const vendor = { displayName: 'Service catalog', url: 'https://catalog.example.com/' }
  return {
    listModels: async () => [CHAT_MODEL],
    listClassifierModels: async () => [CLASSIFIER_MODEL],
    listGatekeeperVendors: async () => [{
      id: 'catalog',
      description: vendor,
      supportedResources: [RESOURCE],
    }],
    subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
      subscriber.add(1, {
        displayName: 'Catalog account',
        avatar: { url: 'https://catalog.example.com/avatar' },
      }, vendor, [RESOURCE], true, 'catalog')
      subscriber.ready()
      return subscription()
    },
    startResourceConfigurator: async () => ({
      iframeHtml: '<!doctype html>',
      ui: { [Symbol.dispose]() {} },
    }),
  } as unknown as RpcStub<AuthenticatedApi>
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  testState.authenticatedApi = null
  testState.readinessEvents = []
  vi.unstubAllGlobals()
})

async function renderModal(props: { initialVendorId?: string, initialResourceUrlPattern?: string } = {}) {
  testState.authenticatedApi = authenticatedApi()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => root!.render(<GatekeeperModal
    open
    onClose={() => {}}
    getOverseer={() => { throw new Error('not called') }}
    onCreated={() => Promise.resolve()}
    {...props}
  />))
}

describe('GatekeeperModal configurator readiness', () => {
  it('keeps Add connection disabled for a lifecycle null readiness event', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    await renderModal({ initialVendorId: 'catalog', initialResourceUrlPattern: RESOURCE.urlPattern })

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="resource-configurator"]')).not.toBeNull()
      expect(testState.readinessEvents).toEqual([null])
    })

    const addConnection = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Add connection')!
    expect(addConnection.disabled).toBe(true)
  })
})

describe('GatekeeperModal model pickers', () => {
  // A classifier can back an AI Model binding but can't run an agent. The AI Model picker labels
  // each model with its kind.
  it.each([
    { groupKey: 'platform:ai-model', picker: 'Select an AI model',
      options: ['Chat models: Chat model', 'Classifier models: Classifier model'] },
    { groupKey: 'platform:agent-spawner', picker: 'Agent model', options: ['None (no agent)', 'Chat model'] },
  ])('offers $options in the $groupKey picker', async ({ groupKey, picker, options }) => {
    await renderModal()

    const group = document.body.querySelector<HTMLButtonElement>(
      `[aria-controls="connection-group-panel-${groupKey}"]`)!
    await act(async () => group.click())
    await act(async () => document.getElementById(`connection-group-panel-${groupKey}`)!
      .querySelector('button')!.click())
    await act(async () => document.body.querySelector<HTMLButtonElement>(`[aria-label="${picker}"]`)!.click())

    expect(Array.from(document.body.querySelectorAll('[role="option"]'), option => {
      const heading = option.closest('[role="group"]')?.getAttribute('aria-labelledby')
      return heading ? `${document.getElementById(heading)!.textContent}: ${option.textContent}` : option.textContent
    })).toEqual(options)
  })
})
