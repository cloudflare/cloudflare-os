import { useState, type CSSProperties } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { PlusIcon } from '@phosphor-icons/react'
import { Button } from './Button'
import './ConnectButton.css'

export type ConnectButtonLogo = {
  key: string
  /** What it is a logo of, which its initial stands in for while it has no picture. */
  name: string
  src?: string
}

export type ConnectButtonProps = {
  /** The logos of what is connected, shown after the add control, the first on top. */
  logos?: ConnectButtonLogo[]
  /** While nothing is connected: logos of what could be, shown in grey as an invitation. */
  suggested?: ConnectButtonLogo[]
  /** Its page is the one showing, which it is marked as, as the sidebar's other buttons are. */
  current?: boolean
  onConnect?: () => void
}

// More than this, and the rest are counted.
const SHOWN = 3
// Held as a hand: the first upright on top, the ones under it turned a little further each.
const TILTS = [0, 7, 14]

const Logo = ({ name, src }: Omit<ConnectButtonLogo, 'key'>) => {
  const [failed, setFailed] = useState(false)
  return src && !failed
    ? <img src={src} alt="" className="size-3 object-contain" onError={() => setFailed(true)} />
    : <span aria-hidden="true" className="text-[10px]/none font-semibold text-kumo-default">{name.slice(0, 1).toUpperCase()}</span>
}

const AND = new Intl.ListFormat('en', { type: 'conjunction' })

/**
 * A pill with a round add control, followed by the logos of what is already connected, or, while
 * nothing is, of what could be. They are held like a hand of cards, each tucked under the one
 * before it, and spread out when the pill is pointed at or focused (`ConnectButton.css`).
 */
export const ConnectButton = ({ logos = [], suggested = [], current, onConnect }: ConnectButtonProps) => {
  const inviting = logos.length === 0
  const all = inviting ? suggested : logos
  const shown = all.slice(0, SHOWN)
  const more = inviting ? 0 : logos.length - shown.length
  const label = !inviting
    ? `Gatekeepers: ${logos.map(({ name }) => name).join(', ')}`
    : shown.length ? `Connect ${AND.format([...shown.map(({ name }) => name), 'more'])}` : 'Connect an app'

  return (
    <Button
      aria-label={label}
      title={label}
      aria-current={current ? 'page' : undefined}
      onClick={onConnect}
      // With logos the add control sits flush in the left end; alone, Button's circle applies.
      className={cn('group/connect aria-[current=page]:bg-kumo-tint', shown.length > 0 && 'gap-2 pr-3 pl-1')}
      icon={
        <span className="grid size-7 place-items-center rounded-full bg-kumo-tint text-kumo-subtle transition-colors group-hover/connect:text-kumo-default">
          <PlusIcon />
        </span>
      }
    >
      {shown.length > 0 ? (
        <span aria-hidden="true" className="flex items-center">
          {shown.map((logo, index) => (
            <span
              key={logo.key}
              data-suggested={inviting || undefined}
              style={{ zIndex: shown.length - index, '--connect-index': index, '--connect-tilt': `${TILTS[index] ?? 0}deg` } as CSSProperties}
              className={cn(
                // A halo in the pill's own colour keeps each apart from the one it tucks under.
                'connect-logo relative grid size-[22px] shrink-0 place-items-center rounded-full bg-kumo-base shadow-[0_0_0_2px_var(--color-kumo-base)] ring-1 ring-kumo-line ring-inset',
                'group-hover/connect:shadow-[0_0_0_2px_var(--color-kumo-tint)] group-aria-[current=page]/connect:shadow-[0_0_0_2px_var(--color-kumo-tint)]',
              )}
            >
              <Logo name={logo.name} src={logo.src} />
            </span>
          ))}
          {more > 0 && <span className="ms-1.5 text-xs font-medium text-kumo-subtle tabular-nums">+{more}</span>}
        </span>
      ) : undefined}
    </Button>
  )
}
