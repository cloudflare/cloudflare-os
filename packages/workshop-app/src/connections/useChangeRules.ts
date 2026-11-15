import { useEffect, useState } from 'react'
import type { PreApprovableAction } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import type { ChangeRulesConnection } from '@/blocks/ChangeRulesGroup'
import type { ChangeRulesState, WorkspaceChangeRules } from '@/blocks/ConnectionAccountView'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { workspaceLabel } from '@/workspaces/workspaceLabel'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A workspace's catalog, as its connections through the service, in the order it lists them. */
export const connectionsOf = (catalog: readonly PreApprovableAction[], vendorId: string): ChangeRulesConnection[] => {
  const connections = new Map<number, ChangeRulesConnection>()
  for (const { gatekeeperId, resourceTitle, vendorId: vendor, actionKind, alreadyEnabled } of catalog) {
    if (vendor?.toLowerCase() !== vendorId.toLowerCase()) continue
    const connection = connections.get(gatekeeperId) ?? { gatekeeperId, title: resourceTitle, kinds: [] }
    if (!connection.kinds.some(({ tag }) => tag === actionKind.tag)) {
      connection.kinds.push({ tag: actionKind.tag, label: actionKind.label, automatic: alreadyEnabled })
    }
    connections.set(gatekeeperId, connection)
  }
  return [...connections.values()]
}

/** `rules` with one kind of change on one connection made automatic or not. */
const withRule = (rules: ChangeRulesState, workspaceId: string, gatekeeperId: number, tag: string, automatic: boolean): ChangeRulesState =>
  rules.status !== 'ready' ? rules : {
    ...rules,
    workspaces: rules.workspaces.map((workspace) => workspace.id !== workspaceId ? workspace : {
      ...workspace,
      connections: workspace.connections.map((held) => held.gatekeeperId !== gatekeeperId ? held : {
        ...held,
        kinds: held.kinds.map((kind) => (kind.tag === tag ? { ...kind, automatic } : kind)),
      }),
    }),
  }

/**
 * The kinds of change a service's connections can make without asking, in each workspace the user
 * owns that holds one, and whether each does (`Overseer.listPreApprovableActions`), and a way to
 * change one. Rules are the workspace's, not the account's: a workspace does not record which of
 * the user's accounts on a service it reached it through, and one shared with them may hold
 * someone else's, so only the user's own are read. Changing a rule shows at once, and goes back,
 * saying why in `problem`, if the server refuses it. Nothing is read until the service is known.
 */
export const useChangeRules = (vendorId: string | undefined) => {
  const { api, reconnecting } = useApi()
  const connection = useConnectionNotice()
  const workspaces = useWorkspaces()
  const [rules, setRules] = useState<ChangeRulesState>({ status: 'loading' })
  const [problem, setProblem] = useState<string>()
  const owned = workspaces.status === 'ready' ? workspaces.workspaces.filter(({ owner }) => owner === undefined) : undefined
  // Read again only when which workspaces there are changes, not on every snapshot of them.
  const key = owned?.map(({ id, title, containsRestrictedData }) => `${id}:${title}:${containsRestrictedData ? 1 : 0}`).join('|')

  useEffect(() => {
    if (!owned || !vendorId || reconnecting) return
    let cancelled = false
    const opened = owned.map(({ id }) => api.openWorkspace(id))
    void Promise.allSettled(opened.map((overseer) => overseer.listPreApprovableActions())).then((results) => {
      if (cancelled) return
      const failed: string[] = []
      const found: WorkspaceChangeRules[] = []
      results.forEach((result, index) => {
        const { id, title, containsRestrictedData } = owned[index]
        if (result.status === 'rejected') return void failed.push(title)
        const connections = connectionsOf(result.value, vendorId)
        if (connections.length) found.push({ id, title, label: workspaceLabel(title), restricted: containsRestrictedData === true, connections })
      })
      setRules({ status: 'ready', workspaces: found, failed })
    })
    return () => {
      cancelled = true
      for (const overseer of opened) overseer[Symbol.dispose]()
    }
    // `owned` is read through `key`, which says all of it that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, reconnecting, vendorId, key])

  const change = (workspaceId: string, gatekeeperId: number, tag: string, automatic: boolean) => {
    setProblem(undefined)
    const held = rules.status === 'ready' ? rules.workspaces.find(({ id }) => id === workspaceId)?.connections.find((one) => one.gatekeeperId === gatekeeperId) : undefined
    const found = held?.kinds.find((one) => one.tag === tag)
    if (!found || connection?.blocked()) return
    const kind: ActionKind = { tag, label: found.label }
    setRules((current) => withRule(current, workspaceId, gatekeeperId, kind.tag, automatic))
    const overseer = api.openWorkspace(workspaceId)
    const asked = automatic
      ? overseer.setAutoApprovedActionKind(gatekeeperId, kind)
      : overseer.removeAutoApprovedActionKind(gatekeeperId, kind.tag)
    asked.then(
      () => overseer[Symbol.dispose](),
      (error: unknown) => {
        overseer[Symbol.dispose]()
        setRules((current) => withRule(current, workspaceId, gatekeeperId, kind.tag, !automatic))
        setProblem(`Couldn’t change “${kind.label}”: ${messageOf(error)}`)
      },
    )
  }

  return { rules, change, problem }
}
