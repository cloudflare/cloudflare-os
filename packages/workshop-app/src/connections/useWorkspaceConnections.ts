import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceConnectionInfo } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServices } from './useServices'
import type { ConnectionServices } from './workspaceConnections'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type WorkspaceConnectionsState =
  | { status: 'loading' }
  /** `automatic`: by connection, the kinds of change the workspace lets go ahead through it without asking. */
  | { status: 'ready'; connections: WorkspaceConnectionInfo[]; automatic: ReadonlyMap<number, readonly ActionKind[]> }
  | { status: 'failed'; message: string; retry: () => void }

/**
 * A workspace's connections (`listConnections()`) and what it lets go ahead through each without
 * asking (`listAutoApprovedActionKinds()`, a rule per connection and kind of change): read when
 * mounted, if `wanted`, and over each new connection, keeping what was read meanwhile. `change`
 * makes a kind automatic or ask first, shown at once and put back, saying why in `problem`, if the
 * server refuses it. Give the calling component a `key` of the workspace.
 */
export const useWorkspaceConnections = (workspaceId: string, wanted = true) => {
  const { api, reconnecting } = useApi()
  const connection = useConnectionNotice()
  const [state, setState] = useState<WorkspaceConnectionsState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [problem, setProblem] = useState<string>()

  useEffect(() => {
    if (!wanted || reconnecting) return
    let current = true
    // Disposed by hand: `using` is not lowered for every browser this runs in.
    const overseer = api.openWorkspace(workspaceId)
    Promise.all([overseer.listConnections(), overseer.listAutoApprovedActionKinds()]).then(
      ([connections, rules]) => {
        if (!current) return
        const automatic = new Map<number, ActionKind[]>()
        for (const { gatekeeperId, actionKind } of rules) automatic.set(gatekeeperId, [...automatic.get(gatekeeperId) ?? [], actionKind])
        setState({ status: 'ready', connections, automatic })
      },
      (error: unknown) => {
        if (!current) return
        const retry = () => {
          setState({ status: 'loading' })
          setAttempt((count) => count + 1)
        }
        setState((was) => (was.status === 'ready' ? was : { status: 'failed', message: messageOf(error), retry }))
      },
    ).finally(() => overseer[Symbol.dispose]())
    return () => {
      current = false
    }
  }, [api, reconnecting, workspaceId, wanted, attempt])

  const set = (gatekeeperId: number, kind: ActionKind, on: boolean) => setState((was) => {
    if (was.status !== 'ready') return was
    const kinds = (was.automatic.get(gatekeeperId) ?? []).filter(({ tag }) => tag !== kind.tag)
    const automatic = new Map(was.automatic)
    automatic.set(gatekeeperId, on ? [...kinds, kind] : kinds)
    return { ...was, automatic }
  })

  const change = (gatekeeperId: number, kind: ActionKind, on: boolean) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    set(gatekeeperId, kind, on)
    const overseer = api.openWorkspace(workspaceId)
    const asked = on ? overseer.setAutoApprovedActionKind(gatekeeperId, kind) : overseer.removeAutoApprovedActionKind(gatekeeperId, kind.tag)
    asked.catch((error: unknown) => {
      set(gatekeeperId, kind, !on)
      setProblem(`Couldn’t change “${kind.label}”: ${messageOf(error)}`)
    }).finally(() => overseer[Symbol.dispose]())
  }

  return { state, change, problem }
}

export type WorkspaceConnections = ReturnType<typeof useWorkspaceConnections>

/** The services this deployment offers, by vendor, as a workspace's connections are drawn: built-in ones too. */
export const useConnectionServices = (): ConnectionServices => {
  const { services } = useServices()
  return useMemo(() => {
    const vendors = services.status === 'ready' ? [...services.vendors, ...services.addable] : []
    return new Map(vendors.map(({ id, description, supportedResources }) => [id.toLowerCase(), {
      name: description.displayName,
      logoUrl: description.logo?.url,
      color: description.color,
      resources: supportedResources,
    }]))
  }, [services])
}
