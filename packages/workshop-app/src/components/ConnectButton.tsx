import { useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { PlusIcon } from '@phosphor-icons/react'
import { Button } from './Button'

export type ConnectButtonLogo = {
  key: string
  /** What it is a logo of, which its initial stands in for while it has no picture. */
  name: string
  src?: string
}

export type ConnectButtonProps = {
  /** The logos of what is connected, shown after the add control, the first on top. */
  logos?: ConnectButtonLogo[]
  /** Its page is the one showing, which it is marked as, as the sidebar's other buttons are. */
  current?: boolean
  onConnect?: () => void
}

// More than this, and the rest are counted.
const SHOWN = 3

const Logo = ({ name, src }: Omit<ConnectButtonLogo, 'key'>) => {
  const [failed, setFailed] = useState(false)
  return src && !failed
    ? <img src={src} alt="" className="size-3 object-contain" onError={() => setFailed(true)} />
    : <span aria-hidden="true" className="text-[10px]/none font-semibold text-kumo-default">{name.slice(0, 1).toUpperCase()}</span>
}

/**
 * A pill with a round add control, followed by the logos of what is already connected. They sit
 * over one another like a hand of cards, each tucked under the one before it, and fan out when the
 * pill is pointed at or focused, on the same ease as the header's crumb.
 */
export const ConnectButton = ({ logos = [], current, onConnect }: ConnectButtonProps) => {
  const shown = logos.slice(0, SHOWN)
  const more = logos.length - shown.length
  const label = logos.length ? `Connections: ${logos.map(({ name }) => name).join(', ')}` : 'Connect an app'

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
              style={{ zIndex: shown.length - index }}
              className={cn(
                // A halo in the pill's own colour keeps each apart from the one it tucks under.
                'relative grid size-[22px] shrink-0 place-items-center rounded-full bg-kumo-base shadow-[0_0_0_2px_var(--color-kumo-base)] ring-1 ring-kumo-line ring-inset',
                'transition-[margin,box-shadow] duration-300 ease-out motion-reduce:transition-none',
                'group-hover/connect:shadow-[0_0_0_2px_var(--color-kumo-tint)] group-aria-[current=page]/connect:shadow-[0_0_0_2px_var(--color-kumo-tint)]',
                index > 0 && '-ms-1 group-hover/connect:ms-1 group-focus-visible/connect:ms-1',
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
