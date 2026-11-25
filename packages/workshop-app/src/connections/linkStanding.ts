import { matchesResourceUrlPattern, type SupportedResource, type VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { groupedKinds, isConnectable, isGranted, type ConnectedAccount, type Connection } from './connectionList'

/** One of the user's accounts a link could be connected through, and what stands in the way of that. */
export type LinkAccount = {
  account: ConnectedAccount
  /**
   * What it needs first: to be signed in to again, or to be given access to the kinds named
   * (`ensureAccountResources`). Nothing, when the link can be connected through it as it is.
   */
  needs?: { kind: 'signIn' } | { kind: 'access'; patterns: string[] }
}

/** How a link stands with what the user has connected: the service it is on, and their accounts there. */
export type LinkStanding = {
  vendorId: string
  vendor: VendorDescription
  /** The kind of resource it is on that service: a Google Doc, a GitHub repository. */
  resource: SupportedResource
  /** The kinds a new account is asked access to for it, where the service gives each on its own. */
  asks: string[]
  /** The user's accounts on the service, those it can go through as they are first; none, where they have none. */
  accounts: LinkAccount[]
  /** Whether an account can be connected on it beside those there are, as it can where there is none. */
  takesAnother: boolean
}

// The kind `url` is among `resources`: one of the service's own, not merely any web page.
const kindOf = (resources: readonly SupportedResource[], url: string) =>
  resources.find((kind) => isConnectable(kind) && kind.urlPattern !== 'https://*' && matchesResourceUrlPattern(kind.urlPattern, url))

// The kinds shown as one with `pattern` that are given access to one by one: access to one asks for them all.
const grantedTogether = (resources: readonly SupportedResource[], pattern: string) =>
  groupedKinds(resources, pattern).filter((each) => resources.some(({ urlPattern, grantable }) => urlPattern === each && grantable))

/**
 * How `url` stands with `connections`, the user's accounts and the services they could connect:
 * the service that knows it as a kind of resource of its own, and their accounts on it, each with
 * what it needs before the link can go through it. Nothing for a link no service knows, which
 * stays as it was written, or one whose service the deployment sets up itself, as every chat has
 * that already. Where more than one service knows it, the one the user can use soonest.
 */
export const linkStanding = (connections: readonly Connection[], url: string): LinkStanding | undefined => {
  const services = new Map<string, LinkStanding>()
  for (const connection of connections) {
    if (connection.vendor.autoProvisionsAccount) continue
    // An account knows its own kinds, which may be fewer than the service offers now.
    const resources = connection.kind === 'account' ? connection.account.supportedResources : connection.resources
    const resource = kindOf(resources, url)
    if (!resource) continue
    const standing = services.get(connection.vendorId)
      ?? { vendorId: connection.vendorId, vendor: connection.vendor, resource, asks: grantedTogether(connection.resources, resource.urlPattern), accounts: [], takesAnother: false }
    services.set(connection.vendorId, standing)
    standing.takesAnother ||= connection.kind === 'service' || connection.takesAnother
    if (connection.kind !== 'account') continue
    const { account } = connection
    const missing = grantedTogether(resources, resource.urlPattern).filter((pattern) => !isGranted(account.description.grantedResourceUrlPatterns, pattern))
    standing.accounts.push({
      account,
      needs: !account.credentialsValid ? { kind: 'signIn' } : missing.length > 0 ? { kind: 'access', patterns: missing } : undefined,
    })
  }
  const soonest = (standing: LinkStanding) => (standing.accounts.some(({ needs }) => !needs) ? 0 : standing.accounts.length > 0 ? 1 : 2)
  const [first] = [...services.values()].toSorted((a, b) => soonest(a) - soonest(b))
  return first && { ...first, accounts: first.accounts.toSorted((a, b) => Number(Boolean(a.needs)) - Number(Boolean(b.needs))) }
}

/**
 * The account a link goes through: the one `chosen`, or with none chosen, the only one it can go
 * through as it is, or the only one there is, which then says what it needs. Nothing where there
 * is a choice to make, or no account to make it with.
 */
export const linkAccountOf = ({ accounts }: LinkStanding, chosen?: number): LinkAccount | undefined => {
  const picked = accounts.find(({ account }) => account.id === chosen)
  if (picked) return picked
  const usable = accounts.filter(({ needs }) => !needs)
  return usable.length === 1 ? usable[0] : accounts.length === 1 ? accounts[0] : undefined
}
