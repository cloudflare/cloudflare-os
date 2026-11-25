import { CheckmarkCircle02Icon } from '@/components/icons'
import { Button } from '@gadgets/ui'
import { ServiceLogo } from '@/components/ServiceLogo'

export type ConnectionNeed = {
  /** Which of those needed it is. */
  key: string
  /** What the service is called. */
  name: string
  /** What is done with it. */
  description?: string
  logoUrl?: string
  /** Whether the user has an account of it connected, where that is known. */
  connected?: boolean
}

export type ConnectionNeedsProps = {
  needs: ConnectionNeed[]
  /** Connects one that is known not to be. */
  onConnect?: (need: ConnectionNeed) => void
}

/**
 * The services something has to be connected to before it can be used, on one surface: each with
 * what is done with it, and at its end whether the user has it connected, or the way to connect
 * it, where that is known.
 */
export const ConnectionNeeds = ({ needs, onConnect }: ConnectionNeedsProps) => (
  <ul className="flex flex-col rounded-3xl bg-kumo-tint p-2">
    {needs.map((need) => (
      <li key={need.key} className="flex items-start gap-3 p-2 text-base">
        <ServiceLogo name={need.name} src={need.logoUrl} small />
        <span className="flex min-h-10 min-w-0 flex-1 flex-col justify-center gap-0.5 leading-snug">
          <span className="font-medium wrap-anywhere text-kumo-default">{need.name}</span>
          {need.description && <span className="text-sm text-kumo-subtle">{need.description}</span>}
        </span>
        <span className="flex h-10 shrink-0 items-center">
          {need.connected === true && (
            <span className="flex items-center gap-1.5 pe-2 text-sm font-medium text-kumo-subtle">
              <CheckmarkCircle02Icon aria-hidden="true" weight="fill" className="size-4 text-(--color-live)" />
              Connected
            </span>
          )}
          {need.connected === false && onConnect && <Button aria-label={`Connect ${need.name}`} onClick={() => onConnect(need)}>Connect</Button>}
        </span>
      </li>
    ))}
  </ul>
)
