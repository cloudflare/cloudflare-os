import { cn } from '@cloudflare/kumo/utils'

export type ConnectionStatusProps = {
  /** Whether the account can still be used, or has to be signed in to again first. */
  status: 'connected' | 'expired'
}

/**
 * Whether a connected account can be used, as a dot on the corner of its service's logo, which is
 * what it is placed against. It stands clear of the logo by the room the logo leaves round it
 * (`ServiceLogo`'s `notched`), which shows what is behind, as a card that is pointed at darkens.
 * Only for the eye: whatever shows it says so in words too.
 */
export const ConnectionStatus = ({ status }: ConnectionStatusProps) => (
  <span
    aria-hidden="true"
    className={cn('absolute -right-0.5 -bottom-0.5 size-3 rounded-full', status === 'expired' ? 'bg-kumo-danger' : 'bg-(--color-live)')}
  />
)
