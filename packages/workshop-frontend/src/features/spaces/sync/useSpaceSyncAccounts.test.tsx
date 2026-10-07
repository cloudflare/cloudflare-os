// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

// The `spaces` flag as the provider reads it, unless a test switches it by hand.
const flag = vi.hoisted(() => ({ override: undefined as boolean | undefined }))
vi.mock('../../../FeatureFlagsContext', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../FeatureFlagsContext')>()
  return {
    ...original,
    useUiFeatureFlag: (name: Parameters<typeof original.useUiFeatureFlag>[0]) => {
      const read = original.useUiFeatureFlag(name)
      return flag.override === undefined ? read : { ...read, enabled: flag.override }
    },
  }
})

import { fakeApi, mount, settle, unmountAll } from '../spacesTestUtils'
import { syncSourceName, useSpaceSyncAccounts, type SpaceSyncAccount } from './useSpaceSyncAccounts'

const DOCS: VendorDescription = { displayName: 'Docs Hub', url: 'https://docs.example.com/' }
const TRACKER: VendorDescription = { displayName: 'Tracker', url: 'https://tracker.example.com/' }

const TREE: SupportedResource = { urlPattern: 'https://docs.example.com/tree/*', title: 'Document tree', description: 'A tree', grantable: true }
const SINGLE: SupportedResource = { urlPattern: 'https://docs.example.com/doc/*', title: 'Document', description: 'One' }
const FILES: SupportedResource = { urlPattern: 'https://docs.example.com/files/*', title: 'Files', description: 'Files', grantable: true }

const SYNC = { blueprintId: 'document', importMethods: ['importSnapshot'] }

const description = (fields: Partial<AccountDescription> = {}): AccountDescription => ({
  displayName: 'Work account',
  avatar: { url: 'https://docs.example.com/avatar' },
  ...fields,
})

// A subscription whose subscriber the test drives, as the backend does.
function subscriptionApi() {
  let subscriber: ConnectedAccountsSubscriber | undefined
  const dispose = vi.fn<() => void>()
  const subscribeConnectedAccounts = vi.fn<(given: ConnectedAccountsSubscriber) => unknown>((given) => {
    subscriber = given
    return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]: dispose })
  })
  return {
    api: fakeApi({ subscribeConnectedAccounts }),
    subscribeConnectedAccounts,
    dispose,
    send: (change: (subscriber: ConnectedAccountsSubscriber) => void) =>
      act(async () => change(subscriber!)),
  }
}

// A subscription the backend refuses. Made on the call, so that its rejection is handled at once.
const failingSubscription = () =>
  Object.assign(Promise.reject(new Error('boom')), { [Symbol.dispose]() {} })

const syncAccount = (id: number, vendorName: string): SpaceSyncAccount =>
  ({ id, label: `Account ${id}`, vendorName, vendorId: 'docs', blueprintId: 'document', credentialsValid: true, resources: [] })

describe('useSpaceSyncAccounts', () => {
  let current: ReturnType<typeof useSpaceSyncAccounts>
  const Probe = () => {
    current = useSpaceSyncAccounts()
    return null
  }

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
    flag.override = undefined
  })

  it('lists only the accounts that declare space sync, with the resources they may use', async () => {
    const { api, send } = subscriptionApi()
    await mount(<Probe />, api)
    await settle()
    expect(current).toEqual({ accounts: [], ready: false })

    await send((subscriber) => {
      subscriber.add(1, description({ providesSpaceSync: SYNC, grantedResourceUrlPatterns: [TREE.urlPattern] }),
        DOCS, [TREE, SINGLE, FILES], true, 'docs')
      subscriber.add(2, description({ displayName: 'Tracker account' }), TRACKER, [], true, 'tracker')
      subscriber.ready()
    })

    expect(current.ready).toBe(true)
    expect(current.accounts).toEqual([{
      id: 1,
      label: 'Work account',
      vendorName: 'Docs Hub',
      vendorId: 'docs',
      blueprintId: 'document',
      credentialsValid: true,
      // FILES is grantable and was not granted; SINGLE is not separately grantable.
      resources: [TREE, SINGLE],
    }])
  })

  it('treats an account that predates grant tracking as granted everything, and names it by its vendor when it has no name', async () => {
    const { api, send } = subscriptionApi()
    await mount(<Probe />, api)
    await send((subscriber) => {
      subscriber.add(3, { avatar: { url: 'https://docs.example.com/a' }, providesSpaceSync: SYNC },
        DOCS, [TREE, FILES], false, 'docs')
    })

    expect(current.accounts).toEqual([{
      id: 3, label: 'Docs Hub', vendorName: 'Docs Hub', vendorId: 'docs', blueprintId: 'document', credentialsValid: false, resources: [TREE, FILES],
    }])
  })

  it('drops an account that is removed, or replayed without the capability', async () => {
    const { api, send } = subscriptionApi()
    await mount(<Probe />, api)
    await send((subscriber) => {
      subscriber.add(1, description({ providesSpaceSync: SYNC }), DOCS, [TREE], true, 'docs')
      subscriber.add(2, description({ providesSpaceSync: SYNC }), DOCS, [TREE], true, 'docs')
    })
    expect(current.accounts.map(account => account.id)).toEqual([1, 2])

    await send((subscriber) => subscriber.add(1, description(), DOCS, [TREE], true, 'docs'))
    await send((subscriber) => subscriber.remove(2))

    expect(current.accounts).toEqual([])
  })

  it('subscribes nothing while the spaces flag is off', async () => {
    const { subscribeConnectedAccounts } = subscriptionApi()
    await mount(<Probe />, fakeApi({ subscribeConnectedAccounts }, { spacesFlag: false }))
    await settle()

    expect(subscribeConnectedAccounts).not.toHaveBeenCalled()
    expect(current).toEqual({ accounts: [], ready: false })
  })

  it('disposes its subscription on unmount', async () => {
    const { api, dispose } = subscriptionApi()
    const { unmount } = await mount(<Probe />, api)
    await settle()
    await unmount()

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('is ready with what it has when the subscription fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await mount(<Probe />, fakeApi({ subscribeConnectedAccounts: failingSubscription }))
    await settle()

    expect(current).toEqual({ accounts: [], ready: true })
  })

  it('starts afresh when the flag comes back on, keeping no account removed while it was off', async () => {
    const { api, send, subscribeConnectedAccounts, dispose } = subscriptionApi()
    const { rerender } = await mount(<Probe />, api)
    await send((subscriber) => {
      subscriber.add(1, description({ providesSpaceSync: SYNC }), DOCS, [TREE], true, 'docs')
      subscriber.ready()
    })
    expect(current.accounts).toHaveLength(1)

    flag.override = false
    await rerender(<Probe />)
    expect(dispose).toHaveBeenCalledOnce()
    flag.override = true
    await rerender(<Probe />)
    await settle()

    expect(subscribeConnectedAccounts).toHaveBeenCalledTimes(2)
    expect(current).toEqual({ accounts: [], ready: false })
    await send((subscriber) => {
      subscriber.add(2, description({ providesSpaceSync: SYNC }), DOCS, [TREE], true, 'docs')
      subscriber.ready()
    })
    expect(current.accounts.map(account => account.id)).toEqual([2])
  })

  it('starts afresh for a new session, showing none of the previous session’s accounts', async () => {
    const first = subscriptionApi()
    const second = subscriptionApi()
    const { rerender } = await mount(<Probe />, first.api)
    await first.send((subscriber) => {
      subscriber.add(1, description({ providesSpaceSync: SYNC }), DOCS, [TREE], true, 'docs')
      subscriber.ready()
    })
    expect(current.accounts).toHaveLength(1)

    await rerender(<Probe />, second.api)
    await settle()

    expect(first.dispose).toHaveBeenCalledOnce()
    expect(current).toEqual({ accounts: [], ready: false })
  })
})

describe('syncSourceName', () => {
  it('names the one vendor the accounts share, and something generic for several', () => {
    expect(syncSourceName([syncAccount(1, 'Docs Hub'), syncAccount(2, 'Docs Hub')])).toBe('Docs Hub')
    expect(syncSourceName([syncAccount(1, 'Docs Hub'), syncAccount(2, 'Tracker')])).toBe('a connected account')
  })
})
