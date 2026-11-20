import type { ActionEntry } from '@/workspaces/activity/activityEntries'
import type { Automation } from './automations'

/** What waits on a person that no chat asked, by the automation it is put down to, and the rest. */
export type AutomationAsks = {
  /** By the automation's key, oldest first. */
  byAutomation: ReadonlyMap<string, ActionEntry[]>
  /** What no one automation is known to have asked: none, or several, could have. Oldest first. */
  unmatched: ActionEntry[]
}

/**
 * Who asked what waits outside any chat, as far as can be told. An action does not say which hook
 * or gadget made it, only the connection it went through, so it is put down to the automation
 * whose gadget is bound to that connection (`connectionsOf`, its bindings' targets, as the Library
 * tells a gadget's asks from the rest, `isAskOf`) where there is exactly one; else it is left
 * unmatched, rather than guessed. Something the gadget's own page asked, clicked there outside any
 * chat, is put down to its automation too: nothing tells the two apart.
 */
export const asksOfAutomations = (
  automations: readonly Automation[],
  asks: readonly ActionEntry[],
  connectionsOf: (gadgetId: number) => ReadonlySet<number> | undefined,
): AutomationAsks => {
  const byAutomation = new Map<string, ActionEntry[]>()
  const unmatched: ActionEntry[] = []
  for (const ask of asks.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const { gatekeeperId } = ask
    const could = gatekeeperId === undefined ? [] : automations.filter(({ hook }) => connectionsOf(hook.gadgetId)?.has(gatekeeperId))
    if (could.length !== 1) unmatched.push(ask)
    else byAutomation.set(could[0].key, [...(byAutomation.get(could[0].key) ?? []), ask])
  }
  return { byAutomation, unmatched }
}

/** How a row says what waits on it: "Needs approval", "3 approvals". */
export const approvalsWords = (count: number) => (count === 1 ? 'Needs approval' : `${count} approvals`)
