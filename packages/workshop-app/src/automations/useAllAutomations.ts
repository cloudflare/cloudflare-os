import { useState } from 'react'
import type { WorkspaceSummary } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaceSummaries } from '@/workspaces/WorkspaceSummariesContext'
import { automationsOf, type Automation } from './automations'

/** Every workspace's automations, as far as the account knows them. */
export type AllAutomationsState = {
  /** Until the account has said, nothing is known. */
  status: 'loading' | 'ready'
  automations: Automation[]
}

// A switch turned, shown so while the workspace's summary is the one it was turned over: the next
// one says whether the workspace kept it.
type Turned = { enabled: boolean; over: WorkspaceSummary | undefined }

/**
 * Everything set up to run by itself in the workspaces the user builds in, for the Automations
 * page: each workspace's hooks, from the summaries the account keeps of them
 * (`useWorkspaceSummaries`), which opens no workspace and hears of a switch turned anywhere.
 * `setEnabled` turns one on or off as a workspace's tab does, and `remove` deletes one for good.
 */
export const useAllAutomations = () => {
  const { api } = useApi()
  const summaries = useWorkspaceSummaries()
  const [turned, setTurned] = useState<ReadonlyMap<string, Turned>>(new Map())
  // Those deleted, by key, kept out while their workspace's summary is the one they were deleted
  // over: the next one no longer has them.
  const [removed, setRemoved] = useState<ReadonlyMap<string, WorkspaceSummary | undefined>>(new Map())

  const automations = [...summaries.workspaces.values()]
    .flatMap(({ workspaceId, hooks }) => automationsOf(workspaceId, hooks))
    .filter(({ key, workspaceId }) => !removed.has(key) || removed.get(key) !== summaries.workspaces.get(workspaceId))
    .map((automation) => {
      const turn = turned.get(automation.key)
      return turn && turn.over === summaries.workspaces.get(automation.workspaceId) ? { ...automation, hook: { ...automation.hook, enabled: turn.enabled } } : automation
    })
  const state: AllAutomationsState = {
    status: summaries.known ? 'ready' : 'loading',
    automations,
  }

  const turn = (key: string, value: Turned | undefined) => setTurned((current) => {
    const next = new Map(current)
    if (value) next.set(key, value)
    else next.delete(key)
    return next
  })

  /** Turns one on or off: shown at once, and put back, rejecting with why, when its workspace refuses. */
  const setEnabled = async ({ key, workspaceId, hook }: Automation, enabled: boolean) => {
    turn(key, { enabled, over: summaries.workspaces.get(workspaceId) })
    const overseer = api.openWorkspace(workspaceId)
    try {
      await (enabled ? overseer.enableHook(hook.id) : overseer.disableHook(hook.id))
    } catch (error) {
      turn(key, undefined)
      throw error
    } finally {
      overseer[Symbol.dispose]()
    }
  }

  /** Deletes one for good: gone from the list once its workspace has done it, rejecting with why where it refuses. */
  const remove = async ({ key, workspaceId, hook }: Automation) => {
    const over = summaries.workspaces.get(workspaceId)
    const overseer = api.openWorkspace(workspaceId)
    try {
      await overseer.deleteHook(hook.id)
    } finally {
      overseer[Symbol.dispose]()
    }
    setRemoved((current) => new Map(current).set(key, over))
  }

  return { state, setEnabled, remove }
}
