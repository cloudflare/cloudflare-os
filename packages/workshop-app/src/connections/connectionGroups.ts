import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
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
