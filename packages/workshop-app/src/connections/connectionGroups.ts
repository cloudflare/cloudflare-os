import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { matchesResourceUrlPattern, type SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import type { ConnectionDialogResource, ConnectionDialogService } from '@/blocks/ConnectionDialog'
import type { ConnectedAccount } from './ConnectedAccounts'

/** What the Connections page lists, in its three groups. */
export type ConnectionGroups = {
  /** The accounts the user signed in to, on services of their own choosing. */
  connected: ConnectedAccount[]
  /** What comes with the deployment (`autoProvisionsAccount`): the accounts it made, then those it offers to add. */
  builtIn: { accounts: ConnectedAccount[]; addable: GatekeeperVendorInfo[] }
  /** Services that can be connected, again for another account of one already connected. */
  available: GatekeeperVendorInfo[]
}

const ambient = ({ description }: GatekeeperVendorInfo) => description.autoProvisionsAccount === true

/**
 * The accounts and services, grouped as the Connections page lists them. A service that could not
 * be asked (`unavailable`) is left out, and so is a built-in one already added, which the list of
 * what can be added may still have while it is read again.
 */
export const groupConnections = (
  accounts: readonly ConnectedAccount[],
  vendors: readonly GatekeeperVendorInfo[],
  addable: readonly GatekeeperVendorInfo[],
): ConnectionGroups => {
  const added = new Set(accounts.map(({ vendorId }) => vendorId))
  const offered = new Map<string, GatekeeperVendorInfo>()
  for (const vendor of [...vendors, ...addable]) {
    if (!vendor.unavailable && !offered.has(vendor.id)) offered.set(vendor.id, vendor)
  }
  const all = [...offered.values()]
  return {
    connected: accounts.filter(({ vendor }) => !vendor.autoProvisionsAccount),
    builtIn: {
      accounts: accounts.filter(({ vendor }) => vendor.autoProvisionsAccount),
      addable: all.filter((vendor) => ambient(vendor) && !added.has(vendor.id)),
    },
    available: all.filter((vendor) => !ambient(vendor)),
  }
}

/** Which of its service's accounts it is, as the user would know it, or nothing if it is only the service's. */
export const accountName = ({ description, vendor }: ConnectedAccount): string | undefined => {
  const name = description.uniqueName ?? description.displayName
  return name === vendor.displayName ? undefined : name
}

/**
 * The account of `vendorId` that was not among `before`, the ids of those there were when it was
 * asked for: the one a connect flow made. A reconnected account keeps its id, so is not one.
 */
export const newAccountOf = (accounts: readonly ConnectedAccount[], vendorId: string, before: ReadonlySet<number>) =>
  accounts.find((account) => account.vendorId === vendorId && !before.has(account.id))

/** A service as the Connections blocks show it. */
export const serviceOf = ({ displayName, tagline, description, logo, color }: GatekeeperVendorInfo['description']): ConnectionDialogService =>
  ({ name: displayName, tagline, description, logoUrl: logo?.url, color })

/**
 * Kinds of resource shown as one (`SupportedResource.groupedWith`): Google Drive, with a folder, a
 * file, a Doc, a sheet and slides in it. They share one form, which may choose any of them, and
 * connecting one asks for them all.
 */
export type ResourceGroup = {
  /** The kind the group is named after, or its first other one if an admin turned that one off. */
  lead: SupportedResource
  /** Every kind in it, the lead among them, in the service's order. */
  members: SupportedResource[]
}

// The kind a kind is shown as. Keyed by `urlPattern`, as `groupedWith` is on this branch.
const groupKey = (resource: SupportedResource) => resource.groupedWith ?? resource.urlPattern

/** A service's kinds of resource, a group each, in the order of each group's first kind. */
export const resourceGroups = (resources: readonly SupportedResource[]): ResourceGroup[] => {
  const groups = new Map<string, SupportedResource[]>()
  for (const resource of resources) {
    const members = groups.get(groupKey(resource))
    if (members) members.push(resource)
    else groups.set(groupKey(resource), [resource])
  }
  return Array.from(groups, ([key, members]) => ({ lead: members.find(({ urlPattern }) => urlPattern === key) ?? members[0]!, members }))
}

/** The group the kind `urlPattern` is in, if the service has it. */
export const groupOf = (resources: readonly SupportedResource[], urlPattern: string) =>
  resourceGroups(resources).find(({ members }) => members.some((member) => member.urlPattern === urlPattern))

const grantablePatterns = (members: readonly SupportedResource[]) => members.filter(({ grantable }) => grantable).map(({ urlPattern }) => urlPattern)

/** The kinds `urlPatterns`, groups by their leads, stand for: every grantable kind in each group. */
export const withGrouped = (resources: readonly SupportedResource[], urlPatterns: readonly string[]) =>
  [...new Set(urlPatterns.flatMap((urlPattern) => {
    const group = groupOf(resources, urlPattern)
    return group ? grantablePatterns(group.members) : [urlPattern]
  }))]

/**
 * The groups granted, by their leads, of the kinds `granted` (none given: all of them): those whose
 * every grantable kind is.
 */
export const grantedGroups = (resources: readonly SupportedResource[], granted: readonly string[] | undefined) =>
  granted && resourceGroups(resources)
    .filter(({ members }) => grantablePatterns(members).every((urlPattern) => granted.includes(urlPattern)))
    .map(({ lead }) => lead.urlPattern)

/** The kind of `resources` a URL is of: the first to match, as the server resolves it, else the whole account's. */
export const resourceOfUrl = (resources: readonly SupportedResource[], url: string) =>
  resources.find(({ urlPattern }) => urlPattern !== 'https://*' && matchesResourceUrlPattern(urlPattern, url))
  ?? resources.find(({ urlPattern }) => urlPattern === 'https://*')

/** The kinds of thing on a service a gadget can be connected to, a group each, as the Connections blocks show them. */
export const resourcesOf = (resources: GatekeeperVendorInfo['supportedResources']): ConnectionDialogResource[] =>
  resourceGroups(resources).map(({ lead: { urlPattern, title, description, icon }, members }) =>
    ({ urlPattern, title, description, iconUrl: icon?.url, grantable: members.some(({ grantable }) => grantable) }))
