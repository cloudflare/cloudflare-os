import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { isGranted } from '@/blocks/resourceGrants'
import type { ConnectedAccount } from './ConnectedAccounts'

/** What an agent asked to be created (`GatekeeperCreationSpec` of a creation's gatekeeper). */
export type CreationTarget = {
  vendorId: string
  /** The kind of resource (`SupportedResource.urlPattern`). */
  typeUrlPattern: string
  /** Where or how the agent suggested it be made, which the user then looks over. */
  configuration?: string
}

/**
 * The account to create `target` in without asking: the user's only one on the service that can,
 * signed in and with access to the kind, when the agent suggested nothing to look over. Undefined
 * when there is a choice to make, or none to make it with, which the creation dialog then asks.
 */
export const creationAccountOf = (
  accounts: readonly ConnectedAccount[],
  target: CreationTarget,
  resources: readonly SupportedResource[],
) => {
  if (target.configuration !== undefined) return undefined
  const resource = resources.find(({ urlPattern }) => urlPattern === target.typeUrlPattern)
  const usable = accounts.filter((account) => account.vendorId === target.vendorId && account.credentialsValid &&
    (resource?.grantable !== true || isGranted(account.description.grantedResourceUrlPatterns, target.typeUrlPattern)))
  return usable.length === 1 ? usable[0].id : undefined
}
