import { describe, expect, it } from 'vitest'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { ConnectedAccount } from './ConnectedAccounts'
import { accountName, groupConnections, newAccountOf } from './connectionGroups'

const vendor = (id: string, extra: Partial<GatekeeperVendorInfo> & { ambient?: boolean } = {}): GatekeeperVendorInfo => ({
  id,
  description: { displayName: id, url: `https://${id}.example`, autoProvisionsAccount: extra.ambient },
  supportedResources: [],
  unavailable: extra.unavailable,
})

const account = (id: number, vendorId: string, { ambient = false, name }: { ambient?: boolean; name?: string } = {}): ConnectedAccount => ({
  id,
  vendorId,
  description: { avatar: { url: '' }, uniqueName: name },
  vendor: { displayName: vendorId, url: '', autoProvisionsAccount: ambient },
  supportedResources: [],
  credentialsValid: true,
})

describe('groupConnections', () => {
  it('puts what the deployment makes apart from what the user signed in to', () => {
    const groups = groupConnections(
      [account(1, 'github'), account(2, 'scheduler', { ambient: true })],
      [vendor('github'), vendor('slack')],
      [vendor('websearch', { ambient: true })],
    )
    expect(groups.connected.map(({ id }) => id)).toEqual([1])
    expect(groups.builtIn.accounts.map(({ id }) => id)).toEqual([2])
    expect(groups.builtIn.addable.map(({ id }) => id)).toEqual(['websearch'])
    // Another account of a connected service can be connected.
    expect(groups.available.map(({ id }) => id)).toEqual(['github', 'slack'])
  })

  it('leaves out a service that could not be asked, and a built-in one already added', () => {
    const groups = groupConnections(
      [account(2, 'scheduler', { ambient: true })],
      [vendor('github', { unavailable: true })],
      [vendor('scheduler', { ambient: true })],
    )
    expect(groups.available).toEqual([])
    expect(groups.builtIn.addable).toEqual([])
  })

  it('lists a service both lists have once', () => {
    const groups = groupConnections([], [vendor('context', { ambient: true })], [vendor('context', { ambient: true })])
    expect(groups.builtIn.addable.map(({ id }) => id)).toEqual(['context'])
  })
})

describe('accountName', () => {
  it('is the account’s name, unless that is only the service’s', () => {
    expect(accountName(account(1, 'github', { name: 'octocat' }))).toBe('octocat')
    expect(accountName(account(1, 'github', { name: 'github' }))).toBeUndefined()
    expect(accountName(account(1, 'github'))).toBeUndefined()
  })
})

describe('newAccountOf', () => {
  it('finds the account of the service that was not there before', () => {
    const accounts = [account(1, 'github'), account(2, 'slack'), account(3, 'github')]
    expect(newAccountOf(accounts, 'github', new Set([1, 2]))?.id).toBe(3)
    expect(newAccountOf(accounts, 'slack', new Set([1, 2]))).toBeUndefined()
  })
})
