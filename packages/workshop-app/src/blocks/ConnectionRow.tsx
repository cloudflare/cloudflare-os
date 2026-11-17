import { Badge } from '@cloudflare/kumo'
import { ServiceLogo } from '@/components/ServiceLogo'
import { ConnectionMark } from './ConnectionMark'
import type { ConnectionState } from './connectionState'
import { ConnectionStatus } from './ConnectionStatus'

export type ConnectionRowProps = {
  /** What the service is called. */
  name: string
  logoUrl?: string
  /** The service's own colour, for behind its logo. */
  color?: string
  /** What it is for, in a few words. */
  tagline?: string
  connection: ConnectionState
}

/**
 * One service on the Connections page, on one line: its logo, with a dot on it for whether a
 * connected account can be used, its name over whose account it is, or over what it is for where
 * that is not said, and at the far end a mark of what the row does, after a badge on an account
 * that has to be signed in to again.
 *
 * All of the row is a button, which shows what there is to know of the service: the way to
 * connect one that could be, and what can be done with an account that is.
 */
export const ConnectionRow = ({ name, logoUrl, color, tagline, connection }: ConnectionRowProps) => {
  const { status } = connection
  const detail = (status === 'available' ? undefined : connection.account) ?? tagline

  return (
    <button
      type="button"
      onClick={connection.onOpen}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl p-3 text-left text-base hover:bg-kumo-contrast/5 focus-visible:bg-kumo-contrast/5"
    >
      <span className="relative shrink-0">
        <ServiceLogo name={name} src={logoUrl} color={color} small notched={status !== 'available'} />
        {status !== 'available' && <ConnectionStatus status={status} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-snug">
        <span className="truncate font-medium text-kumo-default">
          <span className="sr-only">{status === 'available' ? (connection.instant ? 'Add' : 'Connect') : 'Manage'} </span>
          {name}
          {status === 'connected' && <span className="sr-only">, connected</span>}
        </span>
        {detail && <span className="truncate text-kumo-subtle">{detail}</span>}
      </span>
      {status === 'expired' && <Badge variant="error">Sign-in expired</Badge>}
      <ConnectionMark connected={status !== 'available'} />
    </button>
  )
}
