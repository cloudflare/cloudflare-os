import { useEffect, useMemo, useState } from 'react'
import type { FileAtCommit, TreeNode } from '@gadgets/workshop-shared/api'
import { commitFileStore, type CommitFileReader } from './commitFileStore'

// React bindings for the per-commit file store. The store is the source of truth and already
// memoizes by commit, so these hooks hold no copy of its data: each render reads what is loaded
// through the store's synchronous peeks, an effect fetches whatever is missing, and a version
// counter re-renders when the fetch settles. That keeps a value an editor already loaded from
// ever showing a loading state again, and lets the same base be shared with the OT client.

const NO_FILES: ReadonlyMap<string, FileAtCommit> = new Map()
const NO_TREE: TreeNode[] = []

/**
 * The commit's nested tree: `null` while loading, `[]` for no commit (a pending gadget has no
 * tree). `error` is set when the fetch failed; bump `retryToken` to try again.
 */
export function useCommitTree(
  reader: CommitFileReader, commitId: string | undefined, retryToken = 0,
): { tree: TreeNode[] | null; error: unknown } {
  const [, bump] = useState(0)
  const [failure, setFailure] = useState<{ commitId: string; error: unknown } | null>(null)
  const loaded = commitId !== undefined ? commitFileStore.peekTree(commitId) : NO_TREE
  useEffect(() => {
    if (commitId === undefined || loaded !== undefined) return
    let cancelled = false
    commitFileStore.listTree(reader, commitId).then(
      () => { if (!cancelled) bump(version => version + 1) },
      (error: unknown) => { if (!cancelled) setFailure({ commitId, error }) })
    return () => { cancelled = true }
  }, [reader, commitId, loaded, retryToken])
  const error = failure !== null && failure.commitId === commitId && loaded === undefined
    ? failure.error : null
  return { tree: loaded ?? null, error }
}

/**
 * The named files at the commit, as far as loaded: one FileAtCommit per path the store holds
 * (an empty map for no commit), `loading` while any requested path is still in flight -- a
 * consumer degrades per path rather than all-or-nothing, so a newly touched file never blanks
 * the rest of the view. `error` is set when a fetch failed; bump `retryToken` to try again
 * (the store evicts failures, so the retry genuinely refetches).
 */
export function useFilesAtCommit(
  reader: CommitFileReader, commitId: string | undefined, paths: readonly string[],
  retryToken = 0,
): { files: ReadonlyMap<string, FileAtCommit>; loading: boolean; error: unknown } {
  const [version, bump] = useState(0)
  const [failure, setFailure] =
    useState<{ commitId: string; retryToken: number; error: unknown } | null>(null)
  const missing = commitId !== undefined
    ? paths.filter(path => commitFileStore.peekFile(commitId, path) === undefined)
    : []
  // Paths are compared by content: callers rebuild the array per render.
  const pathsKey = paths.join('\u0000')
  const missingKey = missing.join('\u0000')
  useEffect(() => {
    if (commitId === undefined || missing.length === 0) return
    let cancelled = false
    commitFileStore.readFiles(reader, commitId, missing).then(
      () => { if (!cancelled) bump(current => current + 1) },
      (error: unknown) => { if (!cancelled) setFailure({ commitId, retryToken, error }) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, commitId, missingKey, retryToken])
  // Identity is stable while nothing it holds could have changed, so it can serve as a memo
  // dependency downstream. `missingKey` is a dependency because another consumer's fetch (the
  // OT client's, say) can complete a path this hook never asked for.
  const files = useMemo(() => {
    if (commitId === undefined) return NO_FILES
    const out = new Map<string, FileAtCommit>()
    for (const path of paths) {
      const file = commitFileStore.peekFile(commitId, path)
      if (file !== undefined) out.set(path, file)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitId, pathsKey, missingKey, version])
  const loading = missing.length > 0
  const error = loading && failure !== null && failure.commitId === commitId &&
      failure.retryToken === retryToken
    ? failure.error : null
  return { files, loading, error }
}
