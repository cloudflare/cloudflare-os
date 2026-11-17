import { useEffect, useState } from 'react'
import type { RpcPromise } from 'capnweb'
import type { ManagementListOptions, ManagementSchedule, ManagementSchedulePage } from '@gadgets/gatekeeper-scheduler/src/management-types'
import { useApi } from '@/rpc/ApiContext'
import { automationsOf, SCHEDULER, type Automation } from './automations'

export type AutomationsState =
  | { status: 'loading' }
  | { status: 'ready'; automations: Automation[] }
  | { status: 'failed'; message: string; retry: () => void }

// What the scheduler's management app gives its frame (`ScheduleManagementApi`). The Workshop's
// API types a frame's `ui` as any target, and the class itself is the worker's, which the app
// cannot import, so the one call read here is said again.
type ScheduleManagement = { list(options?: ManagementListOptions): Promise<ManagementSchedulePage> }

// Pages of the account's schedules read at most, of 100 each.
const PAGES = 10
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The account's schedules, across its workspaces, from the scheduler's management app. None when
 * there is no scheduler or it cannot be read: the automations still show, without when they run.
 */
const readSchedules = async (open: () => RpcPromise<unknown>): Promise<ManagementSchedule[]> => {
  let frame: (RpcPromise<unknown> & Partial<Disposable>) | undefined
  try {
    // Pipelined, so the frame's HTML, which is not wanted, never comes.
    frame = open()
    const { ui } = frame as unknown as { ui: ScheduleManagement }
    const schedules: ManagementSchedule[] = []
    let cursor: string | undefined
    for (let page = 0; page < PAGES; page++) {
      const read = await ui.list(cursor === undefined ? undefined : { cursor })
      schedules.push(...read.schedules)
      cursor = read.cursor
      if (cursor === undefined) break
    }
    return schedules
  } catch {
    return []
  } finally {
    frame?.[Symbol.dispose]?.()
  }
}

/**
 * One workspace's automations (`listHooks()`), each scheduled task with when it runs, read once
 * mounted and again on a new connection, keeping what is shown meanwhile. `setEnabled` turns one
 * on or off: it shows at once, and is put back, rejecting with why, when the workspace refuses.
 * Give the calling component a `key` of the workspace.
 */
export const useAutomations = (workspaceId: string) => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<AutomationsState>({ status: 'loading' })
  // Bumped to read again: after a failure, or once a schedule is turned on, which makes it again.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (reconnecting) return
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    Promise.all([overseer.listHooks(), readSchedules(() => api.getGatekeeperApp(SCHEDULER))]).then(
      ([hooks, schedules]) => {
        if (!cancelled) setState({ status: 'ready', automations: automationsOf(workspaceId, hooks, schedules) })
      },
      (error: unknown) => {
        if (cancelled) return
        const retry = () => {
          setState({ status: 'loading' })
          setAttempt((current) => current + 1)
        }
        setState((current) => (current.status === 'ready' ? current : { status: 'failed', message: messageOf(error), retry }))
      },
    )
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [api, reconnecting, workspaceId, attempt])

  const patch = (hookId: number, enabled: boolean) =>
    setState((current) => current.status !== 'ready' ? current : {
      status: 'ready',
      automations: current.automations.map((each) => (each.hook.id === hookId ? { ...each, hook: { ...each.hook, enabled } } : each)),
    })

  const setEnabled = async ({ hook, kind }: Automation, enabled: boolean) => {
    patch(hook.id, enabled)
    const overseer = api.openWorkspace(workspaceId)
    try {
      await (enabled ? overseer.enableHook(hook.id) : overseer.disableHook(hook.id))
    } catch (error) {
      patch(hook.id, hook.enabled)
      throw error
    } finally {
      overseer[Symbol.dispose]()
    }
    // Turning a schedule on makes it again, with its next time; off, the scheduler forgets it.
    if (kind === 'schedule') setAttempt((current) => current + 1)
  }

  return { state, setEnabled }
}
