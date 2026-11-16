import { matchesResourceUrlPattern, type SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import type { ConnectedAccount } from './ConnectedAccounts'
import { withGrouped } from './connectionGroups'

/** The account a link can be connected through, and the kind of resource it is there. */
export type LinkAccount = { account: ConnectedAccount; resource: SupportedResource }

/**
 * The one account of the user's that a link can be connected through, as pasting it into a draft
 * connects it: of those that know the link as a kind of resource of their own (not merely any web
 * page, `https://*`), signed in, that the user set up rather than the deployment, the one given
 * access to that kind, or the only one at all, whose refusal then says what it lacks. None where
 * no account, or more than one, could: the link then stays as it was written.
 */
export const linkAccount = (accounts: readonly ConnectedAccount[], url: string): LinkAccount | undefined => {
  const candidates = accounts.flatMap((account): LinkAccount[] => {
    if (!account.credentialsValid || account.vendor.autoProvisionsAccount) return []
    const resource = account.supportedResources.find(({ urlPattern, connectable }) =>
      connectable !== false && urlPattern !== 'https://*' && matchesResourceUrlPattern(urlPattern, url))
    return resource ? [{ account, resource }] : []
  })
  const granted = candidates.filter(({ account, resource }) => {
    const patterns = account.description.grantedResourceUrlPatterns
    return !patterns || withGrouped(account.supportedResources, [resource.urlPattern]).every((pattern) => patterns.includes(pattern))
  })
  if (granted.length === 1) return granted[0]
  return granted.length === 0 && candidates.length === 1 ? candidates[0] : undefined
}
