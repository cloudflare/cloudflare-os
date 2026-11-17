import type { ManagementSchedule } from '@gadgets/gatekeeper-scheduler/src/management-types'
import type { BoundHookInfo } from '@gadgets/workshop-shared/api'
import type { ChatItem } from '@/chat/chatItems'

/** The scheduler gatekeeper's id, as its management app is asked for by. */
export const SCHEDULER = 'scheduler'

// What the scheduler's ambient gatekeeper describes itself as (`scheduler://tasks`). A hook says
// nothing of the vendor that delivers it, so its resource is how a scheduled one is told apart.
const SCHEDULER_URL = 'scheduler:'

/**
 * Something set up to run by itself: one of a workspace's hooks (`BoundHookInfo`), with, for a
 * scheduled task that is on, its schedule as the scheduler keeps it. A paused one has none, as the
 * scheduler forgets a schedule while it is off.
 */
export type Automation = {
  /** Unique across workspaces. */
  key: string
  workspaceId: string
  hook: BoundHookInfo
  /** A scheduled task, or something an event a service delivers sets off (a new email, a push). */
  kind: 'schedule' | 'event'
  schedule?: ManagementSchedule
}

/**
 * A workspace's hooks as automations, newest first, each scheduled task with its schedule from
 * `schedules` (the account's, across workspaces). A schedule does not say which hook it is, so it
 * is found by the title, description and gadget it was enabled with, each schedule once.
 */
export const automationsOf = (workspaceId: string, hooks: readonly BoundHookInfo[], schedules: readonly ManagementSchedule[]): Automation[] => {
  const unclaimed = schedules.filter((schedule) => schedule.workspaceId === workspaceId)
  return hooks.toSorted((a, b) => b.id - a.id).map((hook) => {
    let schedule: ManagementSchedule | undefined
    if (hook.enabled) {
      const at = unclaimed.findIndex(({ title, description, gadgetId }) =>
        title === hook.description.title && description === hook.description.description && (gadgetId ?? hook.gadgetId) === hook.gadgetId)
      if (at >= 0) schedule = unclaimed.splice(at, 1)[0]
    }
    return {
      key: `${workspaceId}/${hook.id}`,
      workspaceId,
      hook,
      kind: schedule || hook.resourceUrl?.startsWith(SCHEDULER_URL) ? 'schedule' : 'event',
      schedule,
    }
  })
}

/**
 * The hooks a chat's cards show that were not deleted since, by id: what it set up to run by
 * itself, as far as its conversation has been loaded.
 */
export const hooksShownIn = (rows: readonly ChatItem[]): number[] =>
  rows.flatMap((row) => (row.kind === 'hook' && row.hookId !== undefined ? [row.hookId] : []))

/**
 * Which of a workspace's automations a chat set up: those its cards show (`setUpHere`, by hook).
 * A hook does not say which chat it came from, so that is all the chat can be known by.
 */
export const setUpIn = (setUpHere: ReadonlySet<number>) => ({ hook }: Automation) => setUpHere.has(hook.id)
