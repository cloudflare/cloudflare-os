import type { SearchEntry } from '@/blocks/SearchDialog'
import { ServiceLogo } from '@/components/ServiceLogo'
import { accountLabel, connectionName, connectionStatus, type Connection } from './connectionList'
import type { ListedAccount, OfferedService } from './connectionProps'

const GROUP = 'Connections'

const byName = (a: Connection, b: Connection) => connectionName(a).localeCompare(connectionName(b))

const logoOf = (connection: Connection) => (
  <ServiceLogo tiny name={connectionName(connection)} src={connection.vendor.logo?.url} color={connection.vendor.color} />
)

// What a service is for, so that "mail" finds the services that do it.
const aboutOf = (connection: Connection) => [connection.vendor.tagline ?? '']

/**
 * Search's way to the connections, one entry for each as the Connections page lists them: the
 * accounts the user has, then the services that could be connected, each titled "Connections ›
 * Google" and saying at its end whether it is connected. Choosing one hands its key to `onOpen`,
 * which is to show its own dialog on the Connections page: Manage for an account, which is also
 * where another account of its service is added, and Connect for a service. Nothing is connected
 * or changed from search itself, as what is given access to is chosen in the dialog.
 *
 * Each is found by its service's name, what it is for, whose account it is, and the word for what
 * choosing it does ("manage", "add"), so that "manage" lists what is connected and "add google"
 * finds Google only if it is not.
 */
export const connectionEntries = (connections: readonly Connection[], onOpen: (key: string) => void): SearchEntry[] => {
  const accounts = connections.filter((connection): connection is ListedAccount => connection.kind === 'account').toSorted(byName)
  // A service with an account is Managed, which adds another account too.
  const connected = new Set(accounts.map(({ vendorId }) => vendorId))
  const services = connections.filter((connection): connection is OfferedService => connection.kind === 'service' && !connected.has(connection.vendorId)).toSorted(byName)

  const account = (listed: ListedAccount): SearchEntry => {
    const name = connectionName(listed)
    const whose = accountLabel(listed.account.description)
    // Accounts of one service are told apart by whose they are.
    const several = accounts.filter(({ vendorId }) => vendorId === listed.vendorId).length > 1
    return {
      key: `connection:${listed.key}`,
      group: GROUP,
      title: `Connections › ${several && whose ? `${name} · ${whose}` : name}`,
      keywords: ['manage', 'disconnect', 'reconnect', 'connected', ...aboutOf(listed), whose ?? ''],
      detail: connectionStatus(listed) === 'expired' ? 'Needs sign-in' : 'Connected',
      icon: logoOf(listed),
      onSelect: () => onOpen(listed.key),
    }
  }
  const service = (offered: OfferedService): SearchEntry => ({
    key: `connection:${offered.key}`,
    group: GROUP,
    title: `Connections › ${connectionName(offered)}`,
    keywords: ['add', 'connect', 'new', 'sign in', ...aboutOf(offered)],
    detail: 'Not connected',
    icon: logoOf(offered),
    onSelect: () => onOpen(offered.key),
  })

  return [...accounts.map(account), ...services.map(service)]
}
