import type { CloudflareUsageInfo, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

/** What the user's AI has cost, from what each workspace says it has (`totalCost`). */
export type SpendSummary = {
  /** In dollars, across every workspace the user builds in. */
  total: number
  /** How many of them have cost anything. */
  workspaces: number
  /** The one that cost most, when one has. */
  most?: { title: string; cost: number }
}

/** Dollars as a price is written: "$0.42", "$12.30", and less than a cent as "<$0.01". */
export const formatCost = (dollars: number) =>
  dollars > 0 && dollars < 0.01 ? '<$0.01' : `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** What the AI in the user's workspaces has cost, leaving out those they were only given an app from. */
export const spendSummary = (workspaces: readonly WorkspaceMetadataWithTimestamps[]): SpendSummary => {
  const costing = workspaces.filter(({ role, totalCost }) => role !== 'use' && (totalCost ?? 0) > 0)
  const most = costing.reduce<WorkspaceMetadataWithTimestamps | undefined>((top, each) => ((each.totalCost ?? 0) > (top?.totalCost ?? 0) ? each : top), undefined)
  return {
    total: costing.reduce((sum, { totalCost }) => sum + (totalCost ?? 0), 0),
    workspaces: costing.length,
    most: most && { title: most.title, cost: most.totalCost ?? 0 },
  }
}

/** What the spend row says under its title. */
export const spendDetail = ({ total, workspaces, most }: SpendSummary) =>
  total === 0
    ? 'Nothing yet. What the AI costs in your workspaces adds up here.'
    : workspaces === 1 || !most
      ? `All in ${most?.title ?? 'one workspace'}.`
      : `Across ${workspaces} workspaces, most in ${most.title} (${formatCost(most.cost)}).`

/**
 * What the free allowance row says, where the deployment limits use (`getCloudflareUsage`): how
 * much of today's is used and when it starts again, and the balance of a Cloudflare account that
 * pays for more. Nothing where use is not limited.
 */
export const allowanceOf = (usage: CloudflareUsageInfo, now = new Date()) => {
  if (!usage.cloudflareLimitsEnabled || usage.unlimited) return undefined
  const reset = usage.resetAt ? new Date(usage.resetAt) : undefined
  const resets = reset && reset > now ? ` Starts again at ${reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''
  return {
    used: usage.dailyUsed,
    limit: usage.dailyLimit,
    detail: `${usage.dailyUsed} of ${usage.dailyLimit} free today.${resets}`,
    account: usage.connected
      ? usage.needsAccountSelection
        ? 'A Cloudflare account is connected. Choose which of its accounts pays in the classic Workshop.'
        : `${usage.accountName ?? 'Your Cloudflare account'} pays for more${usage.balance === null ? '' : `, with ${formatCost(usage.balance)} left`}.`
      : undefined,
  }
}
