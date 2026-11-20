import { useEffect, useMemo, useRef, useState } from 'react'
import type { ManagementSchedule } from '@gadgets/gatekeeper-scheduler/src/management-types'
import type { BoundHookInfo } from '@gadgets/workshop-shared/api'
import { accessNotConfirmed } from '@/connections/ObserverAccessProvider'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { automationsOf, SCHEDULER, type Automation } from './automations'
import { readSchedules } from './useAutomations'

/** Every workspace's automations, as far as they have been read. */
export type AllAutomationsState = {
  /** Until the workspaces are listed and the schedules read, nothing is known. */
  status: 'loading' | 'ready'
  automations: Automation[]
  /** How many workspaces are still to be read. */
  reading: number
  /** The workspaces that could not be read, by their ids. */
  unreachable: string[]
}

// Workspaces read at once: each is woken to say what it has (see the port's log).
const AT_ONCE = 3
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Everything set up to run by itself in the workspaces the user builds in, for the Automations
 * page: the account's schedules, read once from the scheduler, and each workspace's hooks
 * (`listHooks()`), a few workspaces at a time, the most recently active first, each shown as it
 * answers. Nothing lists hooks across workspaces, so each is opened to ask. A workspace shared with
 * the user whose access they have not confirmed is left out, as it is not on screen to ask.
 * Read again on a new connection. `setEnabled` turns one on or off as a workspace's tab does, and
 * `remove` deletes one for good.
 */
export const useAllAutomations = () => {
  const { api, reconnecting } = useApi()
  const workspaces = useWorkspaces()
  // The workspaces to read, the most recently active first, and as one key of which they are, so
  // that the list being read again, its times moved on, starts nothing over.
  const order = workspaces.status === 'ready'
    ? workspaces.workspaces
        .filter(({ role }) => role !== 'use')
        .toSorted((a, b) => (b.lastActive?.getTime() ?? 0) - (a.lastActive?.getTime() ?? 0))
        .map(({ id }) => id)
    : undefined
  const ids = order?.toSorted().join(',')
  const latestOrder = useRef(order)
  latestOrder.current = order
  const [hooks, setHooks] = useState<ReadonlyMap<string, BoundHookInfo[]>>(new Map())
  const [schedules, setSchedules] = useState<ManagementSchedule[]>()
  const [unreachable, setUnreachable] = useState<string[]>([])
  // Bumped to read the schedules again, once one is turned on, which makes it again.
  const [scheduleRead, setScheduleRead] = useState(0)

  useEffect(() => {
    if (reconnecting) return
    let cancelled = false
    void readSchedules(() => api.getGatekeeperApp(SCHEDULER)).then((read) => {
      if (!cancelled) setSchedules(read)
    })
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, scheduleRead])

  useEffect(() => {
    if (reconnecting || ids === undefined) return
    let cancelled = false
    const queue = [...(latestOrder.current ?? [])]
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (cancelled) return
        const overseer = api.openWorkspace(id)
        try {
          const listed = await overseer.listHooks()
          if (!cancelled) setHooks((current) => new Map(current).set(id, listed))
        } catch (error) {
          if (cancelled) continue
          // Not asked, as it is not on screen: there is nothing of it to say.
          if (accessNotConfirmed(messageOf(error))) setHooks((current) => new Map(current).set(id, []))
          else setUnreachable((current) => [...current, id])
        } finally {
          overseer[Symbol.dispose]()
        }
      }
    }
    void Promise.all(Array.from({ length: AT_ONCE }, worker))
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, ids])

  const state = useMemo((): AllAutomationsState => {
    const all = ids ? ids.split(',') : []
    const read = all.filter((id) => hooks.has(id))
    return {
      status: ids === undefined || schedules === undefined ? 'loading' : 'ready',
      automations: read.flatMap((id) => automationsOf(id, hooks.get(id)!, schedules ?? [])),
      reading: all.length - read.length - unreachable.filter((id) => all.includes(id)).length,
      unreachable,
    }
  }, [ids, hooks, schedules, unreachable])

  const patch = (workspaceId: string, hookId: number, enabled: boolean) =>
    setHooks((current) => {
      const listed = current.get(workspaceId)
      return listed ? new Map(current).set(workspaceId, listed.map((hook) => (hook.id === hookId ? { ...hook, enabled } : hook))) : current
    })

  /** Turns one on or off: shown at once, and put back, rejecting with why, when its workspace refuses. */
  const setEnabled = async ({ workspaceId, hook, kind }: Automation, enabled: boolean) => {
    patch(workspaceId, hook.id, enabled)
    const overseer = api.openWorkspace(workspaceId)
    try {
      await (enabled ? overseer.enableHook(hook.id) : overseer.disableHook(hook.id))
    } catch (error) {
      patch(workspaceId, hook.id, hook.enabled)
      throw error
    } finally {
      overseer[Symbol.dispose]()
    }
    // Turning a schedule on makes it again, with its next time; off, the scheduler forgets it.
    if (kind === 'schedule') setScheduleRead((current) => current + 1)
  }

  /** Deletes one for good: gone from the list once its workspace has done it, rejecting with why where it refuses. */
  const remove = async ({ workspaceId, hook, kind }: Automation) => {
    const overseer = api.openWorkspace(workspaceId)
    try {
      await overseer.deleteHook(hook.id)
    } finally {
      overseer[Symbol.dispose]()
    }
    setHooks((current) => {
      const listed = current.get(workspaceId)
      return listed ? new Map(current).set(workspaceId, listed.filter(({ id }) => id !== hook.id)) : current
    })
    // Its schedule went with it, and would otherwise be matched to another of the same name.
    if (kind === 'schedule') setScheduleRead((current) => current + 1)
  }

  return { state, setEnabled, remove }
}
