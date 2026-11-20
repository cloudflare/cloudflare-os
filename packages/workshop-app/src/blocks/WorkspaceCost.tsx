import { Tooltip } from '@gadgets/ui'
import { formatExactCost, formatTotalCost } from '@/components/usageFormat'

export type WorkspaceCostProps = {
  /** What the workspace has cost so far, in dollars. */
  cost: number
}

/** What a workspace has cost in all, in the header: a figure to read at a glance, exact when pointed at. */
export const WorkspaceCost = ({ cost }: WorkspaceCostProps) => (
  <Tooltip content={`Spent on AI in this workspace so far: ${formatExactCost(cost)}. May include estimates.`}>
    <span tabIndex={0} className="rounded-md px-1.5 py-0.5 font-mono text-sm text-kumo-subtle focus-visible:bg-kumo-contrast/5 focus-visible:outline-none">
      {formatTotalCost(cost)}
    </span>
  </Tooltip>
)
