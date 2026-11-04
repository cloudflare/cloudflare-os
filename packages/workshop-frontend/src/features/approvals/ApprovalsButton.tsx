import { Pulse } from '@phosphor-icons/react'
import { CountBadge } from '../../components/CountBadge'

type ApprovalsButtonProps = {
  pendingCount: number
  // Whether the approval dock is showing; only meaningful while requests are pending.
  dockShown: boolean
  onClick: () => void
}

/** The header's Activity button: shows and hides the approval dock while requests are pending. */
export const ApprovalsButton = ({ pendingCount, dockShown, onClick }: ApprovalsButtonProps) => (
  <button
    type="button"
    aria-label={pendingCount > 0
      ? `Activity — ${pendingCount} ${pendingCount === 1 ? 'request needs' : 'requests need'} review`
      : 'Activity'}
    aria-pressed={pendingCount > 0 ? dockShown : undefined}
    onClick={onClick}
    className={`relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
      pendingCount > 0 ? 'text-kumo-strong' : 'text-kumo-subtle hover:text-kumo-default'
    }`}
  >
    <Pulse size={16} weight={pendingCount > 0 ? 'bold' : 'regular'} />
    <CountBadge count={pendingCount} tone="solid" className="absolute -right-0.5 -top-0.5" />
  </button>
)
