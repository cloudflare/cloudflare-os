import type { ConnectDialogProps } from '@/blocks/ConnectDialog'
import type { ConnectionCardProps } from '@/blocks/ConnectionCard'
import type { ManageConnectionDialogProps } from '@/blocks/ManageConnectionDialog'
import type { ActionResult } from '@/blocks/usePending'
import { accountLabel, connectionName, connectionStatus, missingAccess, type Connection } from './connectionList'

/** A service that could be connected, as it is listed. */
export type OfferedService = Connection & { kind: 'service' }

/** An account that is connected, as it is listed. */
export type ListedAccount = Connection & { kind: 'account' }

/** What can be asked for of a connection from where it is listed, and from its dialog. */
export type ConnectionActions = {
  /** Shows what there is to know of a connection: the way to connect a service, or what can be done with an account. */
  open: (connection: Connection) => void
  /** Connects the service, with the kinds of access chosen, or all it has. For one with an account, another. */
  connect: (connection: Connection, access?: string[]) => ActionResult
  /** Signs in again to an account whose sign-in has run out. */
  reconnect: (connection: ListedAccount) => ActionResult
  /** Gives an account kinds of access it does not have. */
  addAccess: (connection: ListedAccount, access: string[]) => ActionResult
  disconnect: (connection: ListedAccount) => ActionResult
}

const serviceProps = (connection: Connection) => ({
  name: connectionName(connection),
  logoUrl: connection.vendor.logo?.url,
  color: connection.vendor.color,
})

// Whose account it is, where that says more than what the service is called: one that is added as
// it is has nobody's name but the service's own.
const whose = (connection: ListedAccount) => {
  const label = accountLabel(connection.account.description)
  return label === connectionName(connection) ? undefined : label
}

/** What a connection's row and its card are both given: how it is drawn, and what it opens. */
export const connectionProps = (connection: Connection, actions: ConnectionActions): ConnectionCardProps => {
  const onOpen = () => actions.open(connection)
  const state: ConnectionCardProps['connection'] = connection.kind === 'service'
    ? { status: 'available', instant: connection.vendor.autoProvisionsAccount, onOpen }
    : { status: connectionStatus(connection) === 'expired' ? 'expired' : 'connected', account: whose(connection), onOpen }
  return { ...serviceProps(connection), tagline: connection.vendor.tagline, connection: state }
}

/** What the dialog of a service that could be connected says of it: what it is for, and what it gives access to. */
export const connectDialogProps = (connection: OfferedService): Pick<ConnectDialogProps, 'name' | 'logoUrl' | 'color' | 'tagline' | 'description' | 'resources' | 'instant'> => ({
  ...serviceProps(connection),
  tagline: connection.vendor.tagline,
  description: connection.vendor.description,
  resources: connection.resources.map(({ urlPattern, title, description, grantable }) => ({ id: urlPattern, title, description, choice: grantable })),
  instant: connection.vendor.autoProvisionsAccount,
})

/** What the dialog of a connected account says of it, and what is done from there. */
export const manageDialogProps = (connection: ListedAccount, actions: ConnectionActions): Omit<ManageConnectionDialogProps, 'open' | 'onOpenChange' | 'problem'> => {
  const missing = missingAccess(connection).map(({ id }) => id)
  return {
    ...serviceProps(connection),
    tagline: connection.vendor.tagline,
    description: connection.vendor.description,
    status: connectionStatus(connection) === 'expired' ? 'expired' : 'connected',
    account: whose(connection),
    resources: connection.resources.map(({ urlPattern, title, description, grantable }) => ({ id: urlPattern, title, description, choice: grantable, granted: !missing.includes(urlPattern) })),
    onAddAccess: (access) => actions.addAccess(connection, access),
    onReconnect: () => actions.reconnect(connection),
    onConnectAnother: connection.takesAnother ? () => actions.connect(connection) : undefined,
    onDisconnect: () => actions.disconnect(connection),
  }
}
