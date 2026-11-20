import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { findResourceType, getResourceTypeId, matchesResourceUrlPattern, type AccountDescription, type SupportedResource, type VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import type { ArrangedGroup, ListFilter, ListOrder, ListViewSpec } from '@gadgets/ui'

/** An account of the user's on a service, as the backend says it is connected. */
export type ConnectedAccount = {
  id: number
  vendorId: string
  vendor: VendorDescription
  description: AccountDescription
  supportedResources: SupportedResource[]
  /** False once its sign-in has run out, until it is signed in to again. */
  credentialsValid: boolean
}

/** What the Connections page lists: an account that is connected, or a service that could be. */
export type Connection = {
  /** Tells it from every other listed. */
  key: string
  vendorId: string
  vendor: VendorDescription
  /** The kinds of thing the service gives access to. */
  resources: SupportedResource[]
} & (
  | {
      kind: 'account'
      account: ConnectedAccount
      /** Whether another account of the service can be connected beside this one. */
      takesAnother: boolean
    }
  | { kind: 'service' }
)

/**
 * What there is to list: each connected account, then each service on offer that could be
 * connected: one that has no account yet, and one that is signed in to, which takes another
 * beside those it has. A service is on offer when it can be signed in to (`vendors`) or added as
 * it is (`addable`), and can be reached. One that is added as it is has the one account. An
 * account is listed whether or not its service still is, as its own record says it, and as the
 * service is offered now where it is.
 */
export const connectionsOf = ({ vendors, addable, accounts }: {
  vendors: GatekeeperVendorInfo[]
  addable: GatekeeperVendorInfo[]
  accounts: ConnectedAccount[]
}): Connection[] => {
  const offered = new Map<string, GatekeeperVendorInfo>()
  for (const vendor of [...vendors, ...addable]) {
    if (!vendor.unavailable && !offered.has(vendor.id)) offered.set(vendor.id, vendor)
  }
  const connected = new Set(accounts.map(({ vendorId }) => vendorId))
  return [
    ...accounts.map((account): Connection => {
      const listed = offered.get(account.vendorId)
      return {
        kind: 'account',
        key: `account:${account.id}`,
        vendorId: account.vendorId,
        vendor: listed?.description ?? account.vendor,
        resources: listed?.supportedResources ?? account.supportedResources,
        account,
        // One that is added as it is has nobody else to sign in as.
        takesAnother: listed !== undefined && !listed.description.autoProvisionsAccount,
      }
    }),
    ...[...offered.values()]
      .filter(({ id, description }) => !connected.has(id) || !description.autoProvisionsAccount)
      .map((vendor): Connection => ({ kind: 'service', key: `service:${vendor.id}`, vendorId: vendor.id, vendor: vendor.description, resources: vendor.supportedResources })),
  ]
}

/** The services that could not be asked what they offer, by name, which are not listed. */
export const unreachableServices = (vendors: GatekeeperVendorInfo[]) =>
  vendors.filter(({ unavailable }) => unavailable).map(({ id, description }) => description.displayName || id)

/** What a connection is called where it is listed: its service's name. */
export const connectionName = ({ vendor }: Connection) => vendor.displayName

/** Whose account it is, as the service knows them: their name and what they sign in as, or whichever there is. */
export const accountLabel = ({ displayName, uniqueName }: AccountDescription) =>
  displayName && uniqueName && displayName !== uniqueName ? `${displayName} · ${uniqueName}` : displayName || uniqueName || undefined

/** Where a connection stands: `expired` is an account that has to be signed in to again. */
export const connectionStatus = (connection: Connection) =>
  connection.kind === 'service' ? 'available' : connection.account.credentialsValid ? 'connected' : 'expired'

/** A kind of access a service gives that is granted on its own, such as its mail or its calendar. */
export type ConnectionAccess = { id: string; title: string }

/** The kinds of access a service gives one by one, to choose between when connecting it. */
export const accessChoices = ({ resources }: Connection): ConnectionAccess[] =>
  resources.filter(({ grantable }) => grantable).map(({ urlPattern, title }) => ({ id: urlPattern, title }))

/**
 * The kinds of access a connected account could be given and has not been. None for an account
 * that does not say what it was given, which is taken to have it all.
 */
export const missingAccess = (connection: Connection & { kind: 'account' }): ConnectionAccess[] => {
  const granted = connection.account.description.grantedResourceUrlPatterns
  return granted === undefined ? [] : accessChoices(connection).filter(({ id }) => !granted.includes(id))
}

/** Whether an account may reach a kind of resource, by what it was given; one that does not say has everything. */
export const isGranted = (granted: readonly string[] | undefined, urlPattern: string) =>
  granted === undefined || granted.includes(urlPattern)

/** Whether a kind is offered to connect one that exists (`SupportedResource.connectable`), rather than only made. */
export const isConnectable = (resource: SupportedResource) => resource.connectable !== false

// The kind a kind of resource is shown with, by its type's id (`groupedWith` names one): itself,
// unless it is shown with another.
const leadOf = (resource: SupportedResource) => resource.groupedWith ?? getResourceTypeId(resource)

/**
 * The kinds of resource a service shows as one with `urlPattern` (`SupportedResource.groupedWith`),
 * as Google Drive shows a folder, a file and a Doc: one form chooses among them all, and giving
 * access to one asks for all of them. Just `urlPattern` for a kind shown on its own.
 */
export const groupedKinds = (resources: readonly SupportedResource[], urlPattern: string) => {
  const resource = resources.find((candidate) => candidate.urlPattern === urlPattern)
  if (!resource) return [urlPattern]
  const lead = leadOf(resource)
  return resources.filter((candidate) => leadOf(candidate) === lead && (candidate === resource || isConnectable(candidate))).map((candidate) => candidate.urlPattern)
}

/**
 * The account of `vendorId` that was not among `before`, the ids of those there were when another
 * was asked for: the one a connect flow made. One signed in to again keeps its id, so is not it.
 */
export const newAccountOf = (accounts: readonly ConnectedAccount[], vendorId: string, before: ReadonlySet<number>) =>
  accounts.find((account) => account.vendorId === vendorId && !before.has(account.id))

/**
 * A service's kinds of resource that can be connected, a group each, as it shows them (`SupportedResource.groupedWith`):
 * Google Drive, with a folder, a file and a Doc in it, which one form chooses among. In the order
 * of each group's first kind, each led by the kind it is named after.
 */
export const resourceGroups = (resources: readonly SupportedResource[]) => {
  const groups = new Map<string, SupportedResource[]>()
  for (const resource of resources.filter(isConnectable)) {
    const members = groups.get(leadOf(resource))
    if (members) members.push(resource)
    else groups.set(leadOf(resource), [resource])
  }
  return Array.from(groups, ([lead, members]) => ({ lead: members.find((member) => getResourceTypeId(member) === lead) ?? members[0]!, members }))
}

/** The kind among `resources` that `url` is: one of its own before any web page (`https://*`). */
export const resourceOfUrl = (all: readonly SupportedResource[], url: string) => {
  const resources = all.filter(isConnectable)
  return resources.find(({ urlPattern }) => urlPattern !== 'https://*' && matchesResourceUrlPattern(urlPattern, url))
    ?? resources.find(({ urlPattern }) => urlPattern === 'https://*')
}

/**
 * The kind a creation makes (its creation spec's `resourceTypeId`): by its id, or, for one queued
 * before stable ids, which names it by its pattern (`typeUrlPattern`), by that pattern exactly.
 */
export const creationKindOf = (resources: readonly SupportedResource[], resourceTypeId: string) =>
  findResourceType(resources, resourceTypeId) ?? findResourceType(resources, undefined, resourceTypeId)

/**
 * The account to create a resource of `resourceTypeId` in without asking: the user's only one on
 * `vendorId` that can, signed in and with access to the kind. Undefined when there is a choice to
 * make, or none to make it with, which the creation dialog then asks.
 */
export const creationAccountOf = (accounts: readonly ConnectedAccount[], vendorId: string, resourceTypeId: string) => {
  const usable = accounts.filter((account) => {
    if (account.vendorId !== vendorId || !account.credentialsValid) return false
    const kind = creationKindOf(account.supportedResources, resourceTypeId)
    return kind?.grantable !== true || isGranted(account.description.grantedResourceUrlPatterns, kind.urlPattern)
  })
  return usable.length === 1 ? usable[0].id : undefined
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

// By service, A to Z, and a service's accounts by whose they are.
const byName = (a: Connection, b: Connection) =>
  collator.compare(connectionName(a), connectionName(b))
  || collator.compare((a.kind === 'account' && accountLabel(a.account.description)) || '', (b.kind === 'account' && accountLabel(b.account.description)) || '')

const group = (key: string, label: string, connections: Connection[]): ArrangedGroup<Connection> => ({ key, label, entries: connections.map((value) => ({ value })) })

/**
 * What the user has to see to first, then what they have, each a group of its own however few it
 * has, as each asks something else of them; then what they could have.
 */
const BY_STANDING: ListOrder<Connection> = {
  id: 'standing',
  label: 'Status',
  arrange: (connections) => {
    const standing = (status: ReturnType<typeof connectionStatus>) => connections.filter((connection) => connectionStatus(connection) === status).toSorted(byName)
    return [
      group('expired', 'Needs attention', standing('expired')),
      group('connected', 'Connected', standing('connected')),
      group('available', 'Available', standing('available')),
    ].filter(({ entries }) => entries.length > 0)
  },
}

const STATUS_FILTERS: ListFilter<Connection>[] = [
  { id: 'connected', label: 'Connected', facet: 'status', test: ({ kind }) => kind === 'account' },
  { id: 'expired', label: 'Needs attention', facet: 'status', test: (connection) => connectionStatus(connection) === 'expired' },
  { id: 'available', label: 'Not connected', facet: 'status', test: ({ kind }) => kind === 'service' },
]

/**
 * How the Connections page is ordered, narrowed and searched: by where each connection stands,
 * narrowed by that, and found by its service's name, what that says of itself, what it gives access to, and whose account it is. It starts as
 * cards, as a store's apps are shown.
 */
export const connectionList = (): ListViewSpec<Connection, ListOrder<Connection>> => ({
  orders: [BY_STANDING],
  filters: STATUS_FILTERS,
  startsAs: 'cards',
  searchText: (connection) => {
    const { vendor, resources } = connection
    const account = connection.kind === 'account' ? connection.account.description : undefined
    return [vendor.displayName, vendor.tagline, vendor.description, ...resources.map(({ title }) => title), account?.displayName, account?.uniqueName]
      .filter(Boolean)
      .join(' ')
  },
})
