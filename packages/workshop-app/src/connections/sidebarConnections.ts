import type { SidebarConnection } from '@/blocks/Sidebar'
import type { Connection } from './connectionList'

/** How many logos the button has room for. */
const SHOWN = 3

// Added as they are, rather than something the user connected.
const isFirstParty = ({ vendor }: Connection) => vendor.autoProvisionsAccount === true

const toLogo = ({ vendor }: Connection): SidebarConnection => ({ name: vendor.displayName, logoUrl: vendor.logo?.url })

/**
 * The logos the sidebar's connect button shows: the services the user has connected, each once,
 * leaving out the ones added as they are (`autoProvisionsAccount`); or, while they have connected
 * none, the first few on offer that have a logo, in the order the deployment lists them.
 */
export const sidebarConnections = (connections: Connection[]): SidebarConnection[] => {
  const connected = new Map<string, Connection>()
  for (const connection of connections) {
    if (connection.kind === 'account' && !isFirstParty(connection) && !connected.has(connection.vendorId)) connected.set(connection.vendorId, connection)
  }
  if (connected.size > 0) return [...connected.values()].slice(0, SHOWN).map(toLogo)

  return connections.filter((connection) => connection.kind === 'service' && !isFirstParty(connection) && connection.vendor.logo !== undefined).slice(0, SHOWN).map(toLogo)
}
