import { useCallback, useEffect, useMemo, useState } from 'react'
import { RpcTarget } from 'capnweb'
import type { CommitInfo, WorkpieceSummary, WorkpiecesSubscriber, WorktreeSummary } from '@gadgets/workshop-shared/api'
import { readChangedPaths, readCommitLog } from '@/gadgets/codeReads'
import { commitsSince, type CodeFile } from '@/gadgets/gadgetCode'
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

/** Looks at everything its agent changed since it was made, rather than one of its commits. */
export const SINCE_MADE = 'since-made'

const NONE: ReadonlySet<string> = new Set()

// How many of its commits are listed; a worktree's are its agent's, a handful at most.
const COMMITS = 50

// A repository's client.ts is not a gadget's screen.
const withoutRoles = (files: CodeFile[]) => files.map(({ role: _, ...file }) => file)

/**
 * A worktree beside a chat (`WorktreeSummary`), as kept: its code at its accepted commit
 * (`pinBase`, through `useGadgetCode`), the files changed since it was made (`listChangedPaths`
 * from `baseCommit`), and the commits its agent made since (`getCommitLog` from `headCommit`).
 * What it opens to is the change since it was made, as that is what a worktree beside a chat is
 * for, until another is picked (`compare`): one of its commits, or none for its code as it is. Kept
 * current as its summary changes. Nothing is read while `worktree` is absent.
 */
export const useWorktree = (worktree: { workspaceId: string; workpieceId: number } | undefined) => {
  const { api, reconnecting } = useApi()
  const workspaceId = worktree?.workspaceId
  const workpieceId = worktree?.workpieceId
  const [summary, setSummary] = useState<WorktreeSummary>()
  const [changes, setChanges] = useState<{ pinBase: string; changed: ReadonlySet<string>; commits: CommitInfo[] }>()
  const [asked, setAsked] = useState<string>()
  // What was picked to look at, once something has been: an id, or none for the code as it is.
  const [picked, setPicked] = useState<{ id?: string }>()

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
    const open = () => api.openWorkspace(workspaceId)
    Promise.all([
      baseCommit === pinBase ? Promise.resolve([]) : readChangedPaths(open, baseCommit, pinBase),
      readCommitLog(open, headCommit, COMMITS),
    ]).then(([paths, log]) => {
      if (current) setChanges({ pinBase, changed: new Set(paths), commits: commitsSince(log, baseCommit) })
    }, () => {
      // What changed only offers it to look at; the code still shows without it.
      if (current) setChanges({ pinBase, changed: NONE, commits: [] })
    })
    return () => { current = false }
  }, [api, reconnecting, workspaceId, pinBase, baseCommit, headCommit])

  const read = changes?.pinBase === pinBase ? changes : undefined
  const comparing = picked ? picked.id : read && read.changed.size > 0 ? SINCE_MADE : undefined
  const commit = comparing === SINCE_MADE ? undefined : read?.commits.find(({ oid }) => oid === comparing)
  const comparison = comparing === SINCE_MADE && baseCommit && pinBase ? { from: baseCommit, to: pinBase }
    : commit?.parents[0] ? { from: commit.parents[0], to: commit.oid } : undefined
  const code = useGadgetCode({
    workspaceId: workspaceId ?? '',
    commit: pinBase,
    comparing: comparison,
    asked,
    // Until it is known what changed, it is not known what it opens to.
    active: worktree !== undefined && read !== undefined,
    arrange: withoutRoles,
  })
  const state: WorktreeChanges = useMemo(
    () => (read ? { status: 'ready', changed: read.changed, commits: read.commits } : { status: 'loading' }),
    [read],
  )
  const compare = useCallback((id: string | undefined) => setPicked({ id }), [])
  return { title: summary?.title, changes: state, code, show: setAsked, comparing: comparison ? comparing : undefined, compare }
}
