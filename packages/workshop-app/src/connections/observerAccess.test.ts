import { describe, expect, it } from 'vitest'
import type { GatekeeperVendorInfo, ObserverBindingNeed } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { protectedResources } from '@/workspaces/sharingRules'
import type { ConnectedAccount } from './connectionList'
import { accountChoices, accountWillDo, defaultChoices, missingAccess, requiredAccess } from './observerAccess'

const DOCS: SupportedResource = { id: 'docs', urlPattern: 'https://docs.google.com/*', grantable: true } as SupportedResource
const google = { id: 'google', description: { displayName: 'Google' }, supportedResources: [DOCS] } as unknown as GatekeeperVendorInfo
const need = (gatekeeperId: number, more: Partial<ObserverBindingNeed> = {}): ObserverBindingNeed =>
  ({ gatekeeperId, vendorId: 'google', resourceTitle: 'Plan', resourceUrl: 'https://docs.google.com/d/1', ...more })
const account = (id: number, more: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id,
  vendorId: 'google',
  vendor: google.description,
  description: { displayName: `Account ${id}`, grantedResourceTypeIds: ['docs'] },
  supportedResources: [DOCS],
  credentialsValid: true,
  ...more,
} as ConnectedAccount)

describe('confirming access to protected resources', () => {
  it('answers every connection that reads a resource with the one account chosen for it', () => {
    const resources = protectedResources([need(1), need(2), need(3, { resourceUrl: undefined, resourceTitle: 'Notes' })], [google])!
    expect(resources.map(({ needs }) => needs.length)).toEqual([2, 1])
    const chosen = defaultChoices(resources, [account(7), account(8)], new Map())
    expect(accountChoices(resources, chosen)).toEqual([
      { gatekeeperId: 1, accountId: 7 },
      { gatekeeperId: 2, accountId: 7 },
      { gatekeeperId: 3, accountId: 7 },
    ])
    expect(accountChoices(resources, new Map([[resources[0]!.key, 8]]))).toBeUndefined()
  })

  it('keeps what was chosen while it is there, and prefers the account just refused', () => {
    const [resource] = protectedResources([need(1, { failure: { accountId: 8, reason: 'No access' } })], [google])!
    expect(defaultChoices([resource!], [account(7), account(8)], new Map()).get(resource!.key)).toBe(8)
    expect(defaultChoices([resource!], [account(7), account(8)], new Map([[resource!.key, 7]])).get(resource!.key)).toBe(7)
    expect(defaultChoices([resource!], [account(7)], new Map([[resource!.key, 9]])).get(resource!.key)).toBe(7)
  })

  it('will do with an account that is signed in and given the kind of access the resource is', () => {
    const [resource] = protectedResources([need(1)], [google])!
    expect(requiredAccess(resource!, google)).toEqual(['docs'])
    expect(accountWillDo(resource!, google, account(7))).toBe(true)
    expect(accountWillDo(resource!, google, account(7, { credentialsValid: false }))).toBe(false)
    const ungranted = account(7, { description: { displayName: 'Ada', grantedResourceTypeIds: [] } as unknown as ConnectedAccount['description'] })
    expect(missingAccess(ungranted, ['docs'])).toEqual(['docs'])
    expect(accountWillDo(resource!, google, ungranted)).toBe(false)
  })
})
