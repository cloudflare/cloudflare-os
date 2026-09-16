// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'

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

vi.mock('./ResourceConfiguratorHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ResourceConfiguratorHost')>()
  const { useEffect } = await import('react')

  const ResourceConfiguratorHost = ({
    state,
    loading,
    disabled,
    onCollectResourceUrlChange,
    onSelectionReadyChange,
  }: {
    state: object | null
    loading: boolean
    disabled: boolean
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
  }) => {
    const mounted = Boolean(state && !loading && !disabled)
    useEffect(() => {
      if (!mounted) return
      onCollectResourceUrlChange?.(() => Promise.resolve('https://catalog.example.com/'))
      testState.readinessEvents.push(null)
      onSelectionReadyChange?.(null)
      return () => onCollectResourceUrlChange?.(null)
    }, [mounted, onCollectResourceUrlChange, onSelectionReadyChange])
    return mounted ? <div data-testid="resource-configurator" /> : null
  }

  return { ...actual, default: ResourceConfiguratorHost }
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

function authenticatedApi(): RpcStub<AuthenticatedApi> {
  const vendor = { displayName: 'Service catalog', url: 'https://catalog.example.com/' }
  return {
    listModels: async () => [],
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

describe('GatekeeperModal configurator readiness', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    testState.authenticatedApi = null
    testState.readinessEvents = []
    vi.unstubAllGlobals()
  })

  it('keeps Add connection disabled for a lifecycle null readiness event', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    testState.authenticatedApi = authenticatedApi()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => root!.render(<GatekeeperModal
      open
      onClose={() => {}}
      getOverseer={() => { throw new Error('not called') }}
      onCreated={() => Promise.resolve()}
      initialVendorId="catalog"
      initialResourceUrlPattern={RESOURCE.urlPattern}
    />))

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="resource-configurator"]')).not.toBeNull()
      expect(testState.readinessEvents).toEqual([null])
    })

    const addConnection = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Add connection')!
    expect(addConnection.disabled).toBe(true)
  })
})
