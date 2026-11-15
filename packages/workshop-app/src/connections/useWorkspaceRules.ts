import { useEffect, useState } from 'react'
import type { PreApprovableAction } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A kind of change one workspace lets one of its connections make without asking. */
export type WorkspaceRule = { workspaceId: string; workspaceTitle: string; gatekeeperId: number; tag: string }

/**
 * The rules in a workspace's catalog for a service's connections, which "Always approve" on a
 * request makes: those switched on, once each.
 */
export const rulesOf = (catalog: readonly PreApprovableAction[], vendorId: string, workspace: { id: string; title: string }): WorkspaceRule[] => {
  const wanted = vendorId.toLowerCase()
  const seen = new Set<string>()
  return catalog.flatMap(({ gatekeeperId, vendorId: vendor, actionKind: { tag }, alreadyEnabled }) => {
    const key = `${gatekeeperId}:${tag}`
    if (!alreadyEnabled || vendor?.toLowerCase() !== wanted || seen.has(key)) return []
    seen.add(key)
    return [{ workspaceId: workspace.id, workspaceTitle: workspace.title, gatekeeperId, tag }]
  })
}

/**
 * The rules the user's own workspaces keep for a service's connections, which go ahead in that one
 * workspace whatever the service's default is (`Overseer.listPreApprovableActions`), and a way to
 * clear every one for a kind of change, so that it follows the default again. A workspace shared
 * with the user is not theirs to change, so it is not read. `rules` is undefined until read; a
 * workspace that cannot be read is left out. A clear shows at once, and comes back, saying why in
 * `problem`, for whichever the server refuses.
 */
export const useWorkspaceRules = (vendorId: string | undefined) => {
  const { api, reconnecting } = useApi()
  const connection = useConnectionNotice()
  const workspaces = useWorkspaces()
  const [rules, setRules] = useState<WorkspaceRule[]>()
  const [problem, setProblem] = useState<string>()
  const owned = workspaces.status === 'ready' ? workspaces.workspaces.filter(({ owner }) => owner === undefined) : undefined
  // Read again only when which workspaces there are changes, not on every snapshot of them.
  const key = owned?.map(({ id, title }) => `${id}:${title}`).join('|')

  useEffect(() => {
    if (!owned || !vendorId || reconnecting) return
    let cancelled = false
    const opened = owned.map(({ id }) => api.openWorkspace(id))
    void Promise.allSettled(opened.map((overseer) => overseer.listPreApprovableActions())).then((results) => {
      if (cancelled) return
      setRules(results.flatMap((result, index) => result.status === 'fulfilled' ? rulesOf(result.value, vendorId, owned[index]) : []))
    })
    return () => {
      cancelled = true
      for (const overseer of opened) overseer[Symbol.dispose]()
    }
    // `owned` is read through `key`, which says all of it that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, reconnecting, vendorId, key])

  const clear = (tag: string, label: string) => {
    setProblem(undefined)
    const clearing = rules?.filter((rule) => rule.tag === tag) ?? []
    if (!clearing.length || connection?.blocked()) return
    setRules((current) => current?.filter((rule) => rule.tag !== tag))
    for (const rule of clearing) {
      const overseer = api.openWorkspace(rule.workspaceId)
      overseer.removeAutoApprovedActionKind(rule.gatekeeperId, tag).then(
        () => overseer[Symbol.dispose](),
        (error: unknown) => {
          overseer[Symbol.dispose]()
          setRules((current) => current && [...current, rule])
          setProblem(`Couldn’t make “${label}” ask first in ${rule.workspaceTitle}: ${messageOf(error)}`)
        },
      )
    }
  }

  return { rules, clear, problem }
}
