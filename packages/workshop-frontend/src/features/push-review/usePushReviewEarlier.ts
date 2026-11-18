import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { FileAtCommit, Overseer } from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'

/**
 * What reading a file's earlier version came to: the read's own answer, `loading`, or a read
 * that threw, which can be tried again. A `blob` answer is a version that is not text or is
 * over MAX_BUFFERED_BLOB_SIZE: it is named and never fetched.
 */
export type EarlierVersion = 'loading' | FileAtCommit | { failed: string }

/**
 * Reads the version of `path` at a parent commit, to set what a push sends against. The read is
 * Overseer.readFilesAtCommit() itself and not the code view's commit file store, which follows
 * a file too large to arrive as text with a download of the whole of it: the earlier version is
 * context for a diff, of any size and not sent, so it is read only as far as one call returns
 * it. Nothing is read while `commitId` is undefined; bump `retryToken` to read again.
 */
export const usePushReviewEarlier = (
  overseer: RpcStub<Overseer>, commitId: string | undefined, path: string, retryToken: number,
): EarlierVersion | undefined => {
  const [read, setRead] = useState<{ key: string, version: FileAtCommit | { failed: string } }>()
  const key = `${commitId}\u0000${path}\u0000${retryToken}`
  useEffect(() => {
    if (commitId === undefined) return
    let cancelled = false
    // Inside a promise, so that a read that throws at once fails as one that rejects does.
    Promise.resolve().then(() => overseer.readFilesAtCommit(commitId, [path])).then(
      ([answer]) => {
        if (!cancelled) setRead({ key, version: answer?.[1] ?? { failed: 'The earlier version was not returned.' } })
      },
      (error: unknown) => {
        const failed = rpcFailureDescription(error) ?? 'The earlier version could not be read.'
        if (!cancelled) setRead({ key, version: { failed } })
      })
    return () => { cancelled = true }
    // `key` stands for the commit, the path and the retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overseer, key])
  return commitId === undefined ? undefined : read?.key === key ? read.version : 'loading'
}
