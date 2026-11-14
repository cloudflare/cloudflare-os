import { describe, expect, it, vi } from 'vitest'
import type { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type { VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { ConnectedAccounts, connectedVendors, type ConnectedAccount } from './ConnectedAccounts'

const vendor = (displayName: string, extra: Partial<VendorDescription> = {}): VendorDescription => ({ displayName, url: 'https://example.com', ...extra })

const fakeServer = () => {
  const subscribers: ConnectedAccountsSubscriber[] = []
  const dispose = vi.fn<() => void>()
  const subscribe = vi.fn<(subscriber: ConnectedAccountsSubscriber) => Promise<Disposable>>(async (subscriber) => {
    subscribers.push(subscriber)
    return { [Symbol.dispose]: dispose }
  })
  const add = (id: number, name = 'GitHub', vendorId = name.toLowerCase(), at = subscribers.length - 1) =>
    subscribers[at].add(id, { avatar: { url: '' }, displayName: `${name} ${id}` }, vendor(name), [], true, vendorId)
  return { subscribe, subscribers, dispose, add }
}

const ids = (accounts: ConnectedAccounts) => {
  const snapshot = accounts.getSnapshot()
  return snapshot.status === 'ready' ? snapshot.accounts.map(({ id }) => id) : snapshot.status
}

describe('ConnectedAccounts', () => {
  it('is loading until the server has said of every account, then lists them in its order', () => {
    const server = fakeServer()
    const accounts = new ConnectedAccounts(server.subscribe)
    accounts.start()
    server.add(1)
    server.add(2, 'Slack')
    expect(ids(accounts)).toBe('loading')
    server.subscribers[0].ready()
    expect(ids(accounts)).toEqual([1, 2])
  })

  it('follows accounts added and removed once ready, and replaces one said again', () => {
    const server = fakeServer()
    const accounts = new ConnectedAccounts(server.subscribe)
    const listener = vi.fn<() => void>()
    accounts.subscribe(listener)
    accounts.start()
    server.subscribers[0].ready()
    server.add(3)
    server.add(3, 'GitLab', 'github')
    server.subscribers[0].remove(9)
    const snapshot = accounts.getSnapshot()
    expect(snapshot.status === 'ready' && snapshot.accounts.map(({ vendor: { displayName } }) => displayName)).toEqual(['GitLab'])
    server.subscribers[0].remove(3)
    expect(ids(accounts)).toEqual([])
    expect(listener).toHaveBeenCalled()
  })

  it('keeps what it shows over a restart until the new subscription is in, and hears nothing more of the old one', async () => {
    const server = fakeServer()
    const accounts = new ConnectedAccounts(server.subscribe)
    accounts.start()
    server.add(1)
    server.subscribers[0].ready()
    accounts.restart()
    await Promise.resolve()
    expect(server.dispose).toHaveBeenCalledOnce()
    server.add(2, 'Slack')
    server.add(7, 'Old', 'old', 0)
    expect(ids(accounts)).toEqual([1])
    server.subscribers[1].ready()
    expect(ids(accounts)).toEqual([2])
  })

  it('says why it could not subscribe while it has nothing to show', async () => {
    const accounts = new ConnectedAccounts(() => Promise.reject(new Error('Not signed in')))
    accounts.start()
    await new Promise((resolve) => setTimeout(resolve))
    expect(accounts.getSnapshot()).toEqual({ status: 'failed', message: 'Not signed in' })
  })
})

const account = (id: number, vendorId: string, description: VendorDescription): ConnectedAccount => ({
  id, vendorId, vendor: description, description: { avatar: { url: '' } }, supportedResources: [], credentialsValid: true,
})

describe('connectedVendors', () => {
  it('lists each service once, in the order its first account came, leaving out those that provision themselves', () => {
    expect(connectedVendors([
      account(1, 'github', vendor('GitHub', { logo: { url: 'gh.svg' } })),
      account(2, 'context', vendor('Skills', { autoProvisionsAccount: true })),
      account(3, 'slack', vendor('Slack')),
      account(4, 'github', vendor('GitHub')),
    ])).toEqual([
      { vendorId: 'github', name: 'GitHub', logoUrl: 'gh.svg' },
      { vendorId: 'slack', name: 'Slack', logoUrl: undefined },
    ])
  })
})
