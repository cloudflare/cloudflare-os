import type { SidebarConnection } from '@/blocks/Sidebar'
import type { Connection } from './connectionList'

/** How many logos the button has room for. */
const SHOWN = 3

// Offered in this order to someone who has connected nothing yet, as what is most worth connecting first.
const STARTERS = ['google', 'cloudflare', 'github', 'slack', 'notion', 'linear']

// Added as they are, or the deployment's own, rather than something the user connected.
const isFirstParty = ({ vendorId, vendor }: Connection) => vendor.autoProvisionsAccount === true || vendorId === 'http'

// Logos much wider than they are tall, among the squarer ones (Google's, GitHub's): a service does
// not say its logo's shape, so this does, by id.
const WIDE = new Set(['cloudflare'])

const toLogo = ({ vendorId, vendor }: Connection): SidebarConnection => ({
  name: vendor.displayName,
  logoUrl: vendor.logo?.url,
  ...(WIDE.has(vendorId) && { wide: true }),
})

/**
 * The logos the sidebar's connect button shows: the services the user has connected, each once,
 * leaving out the ones that come with the app (Scheduled Tasks, skills, Web Search, HTTP); or, while
 * they have connected none, a few of the best known to connect first.
 */
export const sidebarConnections = (connections: Connection[]): SidebarConnection[] => {
  const connected = new Map<string, Connection>()
  for (const connection of connections) {
    if (connection.kind === 'account' && !isFirstParty(connection) && !connected.has(connection.vendorId)) connected.set(connection.vendorId, connection)
  }
  if (connected.size > 0) return [...connected.values()].slice(0, SHOWN).map(toLogo)

  const offered = new Map(connections.filter(({ kind }) => kind === 'service').map((connection) => [connection.vendorId, connection]))
  return STARTERS.flatMap((id) => offered.get(id) ?? []).slice(0, SHOWN).map(toLogo)
}
