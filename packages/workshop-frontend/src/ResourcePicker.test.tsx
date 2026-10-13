// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import ResourcePicker from './ResourcePicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const dispose = vi.fn<() => void>()
  const promise = Object.assign(new Promise<T>(next => { resolve = next }), {
    [Symbol.dispose]: dispose,
  })
  return { promise, resolve, dispose }
}

describe('ResourcePicker', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  it('disposes a pending connected-account subscription on unmount', async () => {
    const pendingSubscription = deferred<{ [Symbol.dispose](): void }>()
    const authenticatedApi = {
      subscribeConnectedAccounts: () => pendingSubscription.promise,
      listGatekeeperVendors: async () => [],
    } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker
        authenticatedApi={authenticatedApi}
        searchText="https://example.com"
        onSelectAccount={() => {}}
      />,
    ))

    act(() => root!.unmount())
    root = undefined

    expect(pendingSubscription.dispose).toHaveBeenCalledOnce()
  })

  it('names the placeholder still blocking an account, rather than offering to grant access', async () => {
    const thread: SupportedResource = {
      urlPattern: 'https://chat.google.com/room/:spaceId/:threadId{/:messageId}?',
      title: 'Google Chat Thread',
      description: 'One thread',
      grantable: true,
    }
    const vendor = { displayName: 'Google', url: 'https://google.com' }
    const authenticatedApi = {
      subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
        // An account that hasn't granted this resource type, so it would otherwise need access.
        const account = { displayName: 'dan@example.com', avatar: { url: '' }, grantedResourceUrlPatterns: [] }
        subscriber.add(1, account, vendor, [thread], true, 'google')
        subscriber.ready()
        return Object.assign(Promise.resolve(), { [Symbol.dispose]: () => {} })
      },
      listGatekeeperVendors: async () => [{ id: 'google', description: vendor, supportedResources: [thread] }],
    } as unknown as RpcStub<AuthenticatedApi>
    const onSelectAccount = vi.fn<() => void>()

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker
        authenticatedApi={authenticatedApi}
        searchText="https://chat.google.com/room/AAQANZZTsQ8/:threadId?cls=7"
        onSelectAccount={onSelectAccount}
      />,
    ))

    const row = [...container.querySelectorAll('div')].findLast(div => div.textContent?.includes('dan@example.com'))!
    expect(row.textContent).toContain('Fill in :threadId first')
    expect(row.textContent).not.toContain('Grant access')
    act(() => row.click())
    expect(onSelectAccount).not.toHaveBeenCalled()
  })
})
