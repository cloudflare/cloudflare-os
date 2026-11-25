import { DashboardCircleIcon, SecurityCheckIcon } from '@/components/icons'
import { StatusPill } from '@/blocks/StatusPill'
import { formatActivity, LinkButton } from '@gadgets/ui'
import type { ActionEntry } from '@/workspaces/activity/activityEntries'
import { approvalsWords } from './automationAsks'

export type OutsideAsksRowProps = {
  /** What waits outside any chat that no one automation is known to have asked, oldest first. */
  asks: readonly ActionEntry[]
  /** Goes to where it is decided: the workspace's apps, each of which asks what it asked. */
  onOpen: () => void
  href?: string
}

/**
 * What waits on someone outside any chat that is not put down to one automation (`asksOfAutomations`),
 * as a row among them: in an automation's frame, with the apps' icon, what the first asks and how
 * many more, where it goes through and since when, and a pill. It opens where it is decided.
 */
export const OutsideAsksRow = ({ asks, onOpen, href }: OutsideAsksRowProps) => {
  const [first] = asks
  if (!first) return null
  const more = asks.length > 1 ? ` and ${asks.length - 1} more` : ''
  const line = ['Asked outside a chat', first.resourceTitle || undefined, formatActivity(first.createdAt)].filter(Boolean).join(' · ')
  return (
    <LinkButton href={href} onClick={onOpen} className="flex items-start gap-3 rounded-2xl p-3 text-left text-base hover:bg-kumo-contrast/5">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill text-kumo-default">
        <DashboardCircleIcon aria-hidden="true" className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
        <span className="truncate font-medium text-kumo-default">{first.description.title}{more}</span>
        <span className="truncate text-kumo-subtle">{line}</span>
      </span>
      <StatusPill words={approvalsWords(asks.length)} tone="warning" icon={SecurityCheckIcon} count={asks.length > 1 ? asks.length : undefined} className="mt-px" />
    </LinkButton>
  )
}
