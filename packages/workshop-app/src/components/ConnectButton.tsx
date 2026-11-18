import type { ReactNode } from 'react'
import { PlusIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from './Button'

export type ConnectButtonProps = {
  /** The logos of the apps already connected, shown after the add control. */
  children?: ReactNode
  onConnect?: () => void
  /** The page it goes to is the one showing. */
  current?: boolean
}

/** A pill with a round add control, followed by the logos of the apps already connected. */
export const ConnectButton = ({ children, onConnect, current }: ConnectButtonProps) => (
  <Button
    aria-label="Connect an app"
    aria-current={current ? 'page' : undefined}
    onClick={onConnect}
    // With logos the add control sits flush in the left end; alone, Button's circle applies.
    className={cn(
      'aria-[current=page]:bg-kumo-tint',
      children && 'pr-(--control-pad) pl-[calc((var(--control-size)-1.75rem)/2)]',
    )}
    icon={
      <span className="grid size-7 place-items-center rounded-full bg-kumo-tint">
        <PlusIcon />
      </span>
    }
  >
    {children ? <span className="flex items-center gap-2">{children}</span> : undefined}
  </Button>
)
