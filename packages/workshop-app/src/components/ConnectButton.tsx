import type { ReactNode } from 'react'
import { PlusIcon } from '@phosphor-icons/react'
import { Button } from './Button'

export type ConnectButtonProps = {
  /** The logos of the apps already connected, shown after the add control. */
  children?: ReactNode
  onConnect?: () => void
}

/** A pill with a round add control, followed by the logos of the apps already connected. */
export const ConnectButton = ({ children, onConnect }: ConnectButtonProps) => (
  <Button
    aria-label="Connect an app"
    onClick={onConnect}
    // With logos the add control sits flush in the left end; alone, Button's circle applies.
    className={children ? 'pr-4 pl-1' : undefined}
    icon={
      <span className="grid size-7 place-items-center rounded-full bg-kumo-tint">
        <PlusIcon />
      </span>
    }
  >
    {children ? <span className="flex items-center gap-3">{children}</span> : undefined}
  </Button>
)
