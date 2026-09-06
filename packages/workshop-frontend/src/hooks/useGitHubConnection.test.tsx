// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type { AccountDescription, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

const testState = vi.hoisted(() => ({
  authenticatedApi: undefined as unknown as ReturnType<typeof createApi>,
}))

vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

import { useGitHubConnection, type GitHubConnectionState } from './useGitHubConnection'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DESCRIPTION = { uniqueName: 'octo@example.com', displayName: 'Octo' } as AccountDescription
const VENDOR = { displayName: 'GitHub' } as VendorDescription

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve })
  return { promise, resolve }
}

function createApi() {
  const subscribers: ConnectedAccountsSubscriber[] = []
  const subscriptions: Array<{ [Symbol.dispose]: () => void }> = []
  return {
    subscribers,
    subscriptions,
    subscribeConnectedAccounts: vi.fn<(subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose]: () => void }>>((subscriber) => {
      subscribers.push(subscriber)
      const subscription = { [Symbol.dispose]: vi.fn<() => void>() }
      subscriptions.push(subscription)
      return Promise.resolve(subscription)
    }),
  }
}

async function renderHook() {
  let latest: GitHubConnectionState | undefined
  let root: Root | undefined
  const container = document.createElement('div')
  document.body.append(container)
  function Probe() {
    latest = useGitHubConnection()
    return null
  }
  root = createRoot(container)
  await act(async () => root!.render(<Probe />))
  return {
    get value() {
      if (!latest) throw new Error('hook not rendered')
      return latest
    },
    rerender: async () => act(async () => root!.render(<Probe />)),
    unmount: async () => {
      await act(async () => root?.unmount())
      container.remove()
    },
  }
}

describe('useGitHubConnection', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('treats add as an upsert and waits for ready before reporting missing', async () => {
    const api = createApi()
    testState.authenticatedApi = api
    const rendered = await renderHook()

    expect(rendered.value).toEqual({ state: 'loading' })
    await act(async () => api.subscribers[0].add(42, DESCRIPTION, VENDOR, [], false, 'github'))
    expect(rendered.value).toEqual({ state: 'expired', accountId: 42, label: 'octo@example.com' })

    await act(async () => api.subscribers[0].add(42, DESCRIPTION, VENDOR, [], true, 'github'))
    expect(rendered.value).toEqual({ state: 'connected', accountId: 42, label: 'octo@example.com' })

    await act(async () => api.subscribers[0].remove(42))
    expect(rendered.value).toEqual({ state: 'missing' })

    await rendered.unmount()
  })

  it('does not expose the previous API connected state after an API replacement', async () => {
    const firstApi = createApi()
    testState.authenticatedApi = firstApi
    const rendered = await renderHook()
    await act(async () => firstApi.subscribers[0].add(42, DESCRIPTION, VENDOR, [], true, 'github'))
    expect(rendered.value.state).toBe('connected')

    const secondApi = createApi()
    testState.authenticatedApi = secondApi
    await rendered.rerender()

    expect(rendered.value).toEqual({ state: 'loading' })
    await act(async () => secondApi.subscribers[0].ready())
    expect(rendered.value).toEqual({ state: 'missing' })

    await rendered.unmount()
  })

  it('disposes subscriptions resolved after unmount and ignores old subscriber events', async () => {
    const api = createApi()
    const pending = deferred<Awaited<ReturnType<typeof api.subscribeConnectedAccounts>>>()
    const dispose = vi.fn<() => void>()
    api.subscribeConnectedAccounts.mockImplementationOnce((subscriber: ConnectedAccountsSubscriber) => {
      api.subscribers.push(subscriber)
      return pending.promise
    })
    testState.authenticatedApi = api
    const rendered = await renderHook()

    await rendered.unmount()
    await act(async () => pending.resolve({ [Symbol.dispose]: dispose }))
    expect(dispose).toHaveBeenCalledOnce()

    await act(async () => api.subscribers[0].add(42, DESCRIPTION, VENDOR, [], true, 'github'))
    expect(api.subscribers).toHaveLength(1)
  })
})
