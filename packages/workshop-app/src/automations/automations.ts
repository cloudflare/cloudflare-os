import type { ManagementSchedule } from '@gadgets/gatekeeper-scheduler/src/management-types'
import type { BoundHookInfo } from '@gadgets/workshop-shared/api'

/** The scheduler gatekeeper's vendor id: a hook it delivers is a scheduled task. */
export const SCHEDULER = 'scheduler'

/**
 * Something set up to run by itself: a hook of a workspace's (`BoundHookInfo`), with, for a
 * scheduled task that is on, its schedule as the scheduler keeps it. A paused schedule has none,
 * as the scheduler forgets a schedule while it is off.
 */
export type Automation = {
  /** Unique across workspaces. */
  key: string
  workspaceId: string
  hook: BoundHookInfo
  /** A scheduled task, or an event a service delivers (a new email, a GitHub push). */
  kind: 'schedule' | 'event'
  schedule?: ManagementSchedule
}

/** Where an automation reports: the chat its agent runs in, or else the gadget whose code it wakes. */
export type AutomationPlace = { type: 'chat'; chatId: number } | { type: 'gadget'; gadgetId: number }

export const placeOf = ({ hook }: Automation): AutomationPlace =>
  hook.chatId !== undefined ? { type: 'chat', chatId: hook.chatId } : { type: 'gadget', gadgetId: hook.gadgetId }

/**
 * A workspace's hooks as automations, each scheduled task with its schedule from `schedules` (the
 * account's, across workspaces): by the hook's id, or for a schedule enabled before the scheduler
 * kept that, by the title, description and gadget it was enabled with. Newest first.
 */
export const automationsOf = (workspaceId: string, hooks: readonly BoundHookInfo[], schedules: readonly ManagementSchedule[]): Automation[] => {
  const own = schedules.filter((schedule) => schedule.workspaceId === workspaceId)
  const byHook = new Map(own.flatMap((schedule) => (schedule.hookId === undefined ? [] : [[schedule.hookId, schedule] as const])))
  const unclaimed = own.filter((schedule) => schedule.hookId === undefined)
  return hooks.toSorted((a, b) => b.id - a.id).map((hook) => {
    let schedule = byHook.get(hook.id)
    if (!schedule && hook.enabled) {
      const at = unclaimed.findIndex(({ title, description, gadgetId }) =>
        title === hook.description.title && description === hook.description.description && (gadgetId ?? hook.gadgetId) === hook.gadgetId)
      if (at >= 0) schedule = unclaimed.splice(at, 1)[0]
    }
    return {
      key: `${workspaceId}/${hook.id}`,
      workspaceId,
      hook,
      kind: schedule || hook.vendorId === SCHEDULER ? 'schedule' : 'event',
      // What the scheduler keeps of a paused one is left over from when it was on.
      schedule: hook.enabled ? schedule : undefined,
    }
  })
}

/**
 * Which of a workspace's automations a chat has: those that run in it, a firing being a turn of
 * its agent there, and those it set up for a gadget (`setUpHere`, the hooks its cards show).
 */
export const inChat = (chatId: number, setUpHere: ReadonlySet<number> = new Set()) => ({ hook }: Automation) =>
  hook.chatId === chatId || setUpHere.has(hook.id)

/** Which of a workspace's automations run a gadget's code (not a chat that only names it). */
export const ofGadget = (gadgetId: number) => ({ hook }: Automation) => hook.chatId === undefined && hook.gadgetId === gadgetId
