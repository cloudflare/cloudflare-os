import { Badge } from '@cloudflare/kumo'
import { ServiceLogo } from '@/components/ServiceLogo'
import { ConnectionMark } from './ConnectionMark'
import type { ConnectionState } from './connectionState'
import { ConnectionStatus } from './ConnectionStatus'

export type ConnectionCardProps = {
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
 * One service on the Connections page, as a card laid out the way a store lists an app: its logo,
 * with a dot on it for whether a connected account can be used, then its name over whose account
 * it is, or over what it is for where that is not said, and at the far end a mark of what the
 * card does, after a badge on an account that has to be signed in to again. The logo and those
 * stay at the top, and what is said grows down from there.
 *
 * All of the card is a button, which shows what there is to know of the service: the way to
 * connect one that could be, and what can be done with an account that is.
 */
export const ConnectionCard = ({ name, logoUrl, color, tagline, connection }: ConnectionCardProps) => {
  const { status } = connection
  const account = status === 'available' ? undefined : connection.account

  return (
    <div className="relative flex items-start rounded-3xl bg-kumo-tint text-base">
      <button
        type="button"
        onClick={connection.onOpen}
        // What shows it is pointed at is laid over all of the card, which the button may not fill.
        className="group flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-3xl p-4 text-left after:absolute after:inset-0 after:rounded-3xl hover:after:bg-kumo-contrast/5 focus-visible:after:bg-kumo-contrast/5"
      >
        <span className="relative shrink-0">
          <ServiceLogo name={name} src={logoUrl} color={color} notched={status !== 'available'} />
          {status !== 'available' && <ConnectionStatus status={status} />}
        </span>
        {/* As tall as the logo at least, and in the middle of that: a name over one line is level with the logo, and more starts at its top. */}
        <span className="flex min-h-12 min-w-0 flex-1 flex-col justify-center gap-0.5 leading-snug">
          <span className="line-clamp-2 font-medium wrap-anywhere text-kumo-default">
            <span className="sr-only">{status === 'available' ? (connection.instant ? 'Add' : 'Connect') : 'Manage'} </span>
            {name}
            {status === 'connected' && <span className="sr-only">, connected</span>}
          </span>
          {/* Whose account it is says more of one that is connected than what its service is for, which whoever connected it knows. */}
          {(account ?? tagline) && <span className="line-clamp-2 text-sm wrap-anywhere text-kumo-subtle">{account ?? tagline}</span>}
        </span>
        {/* Level with the logo, which is taller. */}
        <span className="flex h-12 shrink-0 items-center gap-1">
          {status === 'expired' && <Badge variant="error">Sign-in expired</Badge>}
          <ConnectionMark connected={status !== 'available'} />
        </span>
      </button>
    </div>
  )
}
