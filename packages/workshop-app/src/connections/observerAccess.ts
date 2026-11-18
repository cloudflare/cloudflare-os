import type { GatekeeperVendorInfo, ObserverAccountChoice } from '@gadgets/workshop-shared/api'
import { getGrantedResourceTypeIds, getResourceTypeId, resolveRequestedResource } from '@gadgets/workshop-shared/gatekeeper'
import type { ProtectedResource } from '@/workspaces/sharingRules'
import type { ConnectedAccount } from './connectionList'

/** The account chosen for each protected resource, by its key (`ProtectedResource.key`). */
export type AccessChoices = ReadonlyMap<string, number>

/** The user's accounts at the service a resource is read through. */
export const accountsFor = (resource: Pick<ProtectedResource, 'vendorId'>, accounts: readonly ConnectedAccount[]) =>
  accounts.filter(({ vendorId }) => vendorId.toLowerCase() === resource.vendorId.toLowerCase())

/** The account that was just refused for a resource, where any was and it is still the user's. */
export const refusedAccount = (resource: Pick<ProtectedResource, 'needs'>, accounts: readonly ConnectedAccount[]) => {
  const refused = resource.needs.find(({ failure }) => failure)?.failure
  return refused && accounts.some(({ id }) => id === refused.accountId) ? refused.accountId : undefined
}

/**
 * Who is chosen for each resource as the accounts come and go: what was chosen while it is still
 * there, else the account just refused for it, so that why is about the one chosen and an expired
 * one can be signed in to again in place, else the first at its service.
 */
export const defaultChoices = (resources: readonly ProtectedResource[], accounts: readonly ConnectedAccount[], chosen: AccessChoices): AccessChoices => {
  const next = new Map<string, number>()
  for (const resource of resources) {
    const current = chosen.get(resource.key)
    const preferred = current !== undefined && accounts.some(({ id }) => id === current)
      ? current
      : refusedAccount(resource, accounts) ?? accountsFor(resource, accounts)[0]?.id
    if (preferred !== undefined) next.set(resource.key, preferred)
  }
  return next
}

/**
 * The kinds of access an account must have been given to show it can see a resource: the one it is
 * of, where the service grants that kind on its own. The account's own list of what its service
 * offers is the fresher, and the service's is for before there is one.
 */
export const requiredAccess = (resource: Pick<ProtectedResource, 'needs'>, vendor: GatekeeperVendorInfo | undefined, account?: ConnectedAccount): string[] => {
  const supported = account?.supportedResources.length ? account.supportedResources : vendor?.supportedResources
  const need = resource.needs[0]
  if (!supported || !need) return []
  const resolved = resolveRequestedResource(supported, need.resourceUrl, need.resourceTypeId)
  return resolved.ok && resolved.resource.grantable ? [getResourceTypeId(resolved.resource)] : []
}

/** What of `required` an account has not been given. One that never said what it was given has to be asked. */
export const missingAccess = (account: ConnectedAccount, required: readonly string[]) => {
  const granted = getGrantedResourceTypeIds(account.description, account.supportedResources)
  return granted === undefined ? [...required] : required.filter((id) => !granted.includes(id))
}

/** Whether an account will do for a resource: signed in, and given what it needs to show it can see it. */
export const accountWillDo = (resource: Pick<ProtectedResource, 'needs'>, vendor: GatekeeperVendorInfo | undefined, account: ConnectedAccount | undefined) =>
  account !== undefined && account.credentialsValid && missingAccess(account, requiredAccess(resource, vendor, account)).length === 0

/**
 * The answer to the overseer: the account chosen for each resource, for every connection that reads
 * it, as one resource read by several connections is chosen for once. Undefined while any is not chosen.
 */
export const accountChoices = (resources: readonly ProtectedResource[], chosen: AccessChoices): ObserverAccountChoice[] | undefined => {
  const choices: ObserverAccountChoice[] = []
  for (const resource of resources) {
    const accountId = chosen.get(resource.key)
    if (accountId === undefined) return undefined
    for (const { gatekeeperId } of resource.needs) choices.push({ gatekeeperId, accountId })
  }
  return choices
}
