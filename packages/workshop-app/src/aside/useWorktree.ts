import { useCallback, useEffect, useMemo, useState } from 'react'
import { RpcTarget } from 'capnweb'
import type { CommitInfo, WorkpieceSummary, WorkpiecesSubscriber, WorktreeSummary } from '@gadgets/workshop-shared/api'
import { commitsSince, withChanged, type CodeFile } from '@/gadgets/gadgetCode'
import { useGadgetCode } from '@/gadgets/useGadgetCode'
import { useApi } from '@/rpc/ApiContext'

/** Hears of one worktree's summary as it changes. */
class WorktreeListener extends RpcTarget implements WorkpiecesSubscriber {
  constructor(private readonly id: number, private readonly changed: (summary: WorktreeSummary) => void) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (summary.id === this.id && summary.type === 'worktree') this.changed(summary)
  }

  removed() {}

  ready() {}
}

/** What a worktree's agent has done to it since it was made, once read. */
export type WorktreeChanges =
  | { status: 'loading' }
  | { status: 'ready'; changed: ReadonlySet<string>; commits: CommitInfo[] }

const NONE: ReadonlySet<string> = new Set()

// How many of its commits are listed; a worktree's are its agent's, a handful at most.
const COMMITS = 50

/**
 * A worktree beside a chat (`WorktreeSummary`), as kept: its code at its accepted commit
 * (`pinBase`, through `useGadgetCode`), the files changed since it was made (`listChangedPaths`
 * from `baseCommit`) marked and first, and the commits its agent made since (`getCommitLog` from
 * `headCommit`). Kept current as its summary changes. Nothing is read while `worktree` is absent.
 */
export const useWorktree = (worktree: { workspaceId: string; workpieceId: number } | undefined) => {
  const { api, reconnecting } = useApi()
  const workspaceId = worktree?.workspaceId
  const workpieceId = worktree?.workpieceId
  const [summary, setSummary] = useState<WorktreeSummary>()
  const [changes, setChanges] = useState<{ pinBase: string; changed: ReadonlySet<string>; commits: CommitInfo[] }>()
  const [asked, setAsked] = useState<string>()

  useEffect(() => {
    if (workspaceId === undefined || workpieceId === undefined || reconnecting) return
    let current = true
    const overseer = api.openWorkspace(workspaceId)
    const lease = overseer.subscribeToWorkpieces(new WorktreeListener(workpieceId, (found) => { if (current) setSummary(found) }))
    return () => {
      current = false
      void lease.then((held) => held[Symbol.dispose](), () => {})
      overseer[Symbol.dispose]()
    }
  }, [api, reconnecting, workspaceId, workpieceId])

  const pinBase = summary?.id === workpieceId ? summary?.pinBase : undefined
  const baseCommit = summary?.baseCommit
  const headCommit = summary?.headCommit
  useEffect(() => {
    if (workspaceId === undefined || !pinBase || !baseCommit || !headCommit || reconnecting) return
    let current = true
    const overseer = api.openWorkspace(workspaceId)
    Promise.all([
      baseCommit === pinBase ? Promise.resolve([]) : overseer.listChangedPaths(baseCommit, pinBase),
      overseer.getCommitLog(headCommit, COMMITS),
    ]).then(([paths, log]) => {
      if (current) setChanges({ pinBase, changed: new Set(paths), commits: commitsSince(log, baseCommit) })
    }, () => {
      // What changed only marks the files; the code still shows without it.
      if (current) setChanges({ pinBase, changed: NONE, commits: [] })
    }).finally(() => overseer[Symbol.dispose]())
    return () => { current = false }
  }, [api, reconnecting, workspaceId, pinBase, baseCommit, headCommit])

  const read = changes?.pinBase === pinBase ? changes : undefined
  const changed = read?.changed ?? NONE
  // A repository's client.ts is not a gadget's screen: no roles, and what changed first.
  const arrange = useCallback(
    (files: CodeFile[]) => withChanged(files.map(({ role: _, ...file }) => file), changed),
    [changed],
  )
  const code = useGadgetCode(workspaceId ?? '', pinBase, asked, worktree !== undefined, arrange)
  const state: WorktreeChanges = useMemo(
    () => (read ? { status: 'ready', changed: read.changed, commits: read.commits } : { status: 'loading' }),
    [read],
  )
  return { title: summary?.title, changes: state, code, show: setAsked }
}
