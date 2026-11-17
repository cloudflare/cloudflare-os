import { createElement } from 'react'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import type { ArrangedGroup, ListFilter, ListOrder } from '@/components/listView'
import type { ListViewSpec } from '@/hooks/useListView'
import { primaryCategory, SERVICE_CATEGORIES, serviceCategories } from './serviceCategories'

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

// The kind a kind of resource is shown with: itself, unless it is shown with another.
const leadOf = (resource: SupportedResource) => resource.groupedWith ?? resource.urlPattern

/**
 * The kinds of resource a service shows as one with `urlPattern` (`SupportedResource.groupedWith`),
 * as Google Drive shows a folder, a file and a Doc: one form chooses among them all, and giving
 * access to one asks for all of them. Just `urlPattern` for a kind shown on its own.
 */
export const groupedKinds = (resources: readonly SupportedResource[], urlPattern: string) => {
  const resource = resources.find((candidate) => candidate.urlPattern === urlPattern)
  if (!resource) return [urlPattern]
  const lead = leadOf(resource)
  return resources.filter((candidate) => leadOf(candidate) === lead).map((candidate) => candidate.urlPattern)
}

/**
 * The account of `vendorId` that was not among `before`, the ids of those there were when another
 * was asked for: the one a connect flow made. One signed in to again keeps its id, so is not it.
 */
export const newAccountOf = (accounts: readonly ConnectedAccount[], vendorId: string, before: ReadonlySet<number>) =>
  accounts.find((account) => account.vendorId === vendorId && !before.has(account.id))

/**
 * The account to create a resource of `typeUrlPattern` in without asking: the user's only one on
 * `vendorId` that can, signed in and with access to the kind. Undefined when there is a choice to
 * make, or none to make it with, which the creation dialog then asks.
 */
export const creationAccountOf = (accounts: readonly ConnectedAccount[], vendorId: string, typeUrlPattern: string) => {
  const usable = accounts.filter((account) => {
    if (account.vendorId !== vendorId || !account.credentialsValid) return false
    const kind = account.supportedResources.find(({ urlPattern }) => urlPattern === typeUrlPattern)
    return kind?.grantable !== true || isGranted(account.description.grantedResourceUrlPatterns, typeUrlPattern)
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
 * The services that could be connected, under the kind of service each is most, as fine as there are
 * enough of them for: a category with `enough` of them is a group of its own, and the rest, with
 * those that have no category, are gathered after them. While no category has enough, they are all
 * one group, under what they all are.
 */
const byCategory = (available: Connection[], enough: number): ArrangedGroup<Connection>[] => {
  const categories = SERVICE_CATEGORIES
    .map((category) => ({ category, within: available.filter(({ vendorId }) => primaryCategory(vendorId) === category) }))
    .filter(({ within }) => within.length >= enough)
  const grouped = new Set(categories.flatMap(({ within }) => within))
  return [
    ...categories.map(({ category, within }) => group(`category:${category.id}`, category.label, within)),
    group('available', categories.length > 0 ? 'More' : 'Available', available.filter((connection) => !grouped.has(connection))),
  ]
}

/**
 * What the user has to see to first, then what they have, each a group of its own however few it
 * has, as each asks something else of them; then what they could have, by category.
 */
const BY_STANDING: ListOrder<Connection> = {
  id: 'standing',
  label: 'Status',
  arrange: (connections, enough) => {
    const standing = (status: ReturnType<typeof connectionStatus>) => connections.filter((connection) => connectionStatus(connection) === status).toSorted(byName)
    return [
      group('expired', 'Needs attention', standing('expired')),
      group('connected', 'Connected', standing('connected')),
      ...byCategory(standing('available'), enough),
    ].filter(({ entries }) => entries.length > 0)
  },
}

const STATUS_FILTERS: ListFilter<Connection>[] = [
  { id: 'connected', label: 'Connected', facet: 'status', test: ({ kind }) => kind === 'account' },
  { id: 'expired', label: 'Needs attention', facet: 'status', test: (connection) => connectionStatus(connection) === 'expired' },
  { id: 'available', label: 'Not connected', facet: 'status', test: ({ kind }) => kind === 'service' },
]

/**
 * A filter for each kind of service that one of `connections` is, any of the kinds it is and not
 * only the one it is listed under, once there is more than one kind to choose between.
 */
const categoryFilters = (connections: Connection[]): ListFilter<Connection>[] => {
  const present = new Set(connections.flatMap(({ vendorId }) => serviceCategories(vendorId)))
  return present.size < 2
    ? []
    : SERVICE_CATEGORIES.filter((category) => present.has(category)).map(({ id, label, icon }) => ({
        id: `category:${id}`,
        label,
        facet: 'category',
        icon: createElement(icon, { className: 'size-4' }),
        test: ({ vendorId }) => serviceCategories(vendorId).some((category) => category.id === id),
      }))
}

/**
 * How the Connections page is ordered, narrowed and searched: by where each connection stands,
 * narrowed by that and by the kinds of service it is, and found by its service's name, what that
 * says of itself, its categories, what it gives access to, and whose account it is. It starts as
 * cards, as a store's apps are shown.
 */
export const connectionList = (connections: Connection[]): ListViewSpec<Connection, ListOrder<Connection>> => ({
  orders: [BY_STANDING],
  filters: [...STATUS_FILTERS, ...categoryFilters(connections)],
  facetMenus: { category: 'Category' },
  startsAs: 'cards',
  searchText: (connection) => {
    const { vendor, resources } = connection
    const account = connection.kind === 'account' ? connection.account.description : undefined
    return [vendor.displayName, vendor.tagline, vendor.description, ...serviceCategories(connection.vendorId).map(({ label }) => label), ...resources.map(({ title }) => title), account?.displayName, account?.uniqueName]
      .filter(Boolean)
      .join(' ')
  },
})
