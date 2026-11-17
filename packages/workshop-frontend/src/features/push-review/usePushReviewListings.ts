import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { commitFileStore } from '../code/commitFileStore'
import { rpcFailureDescription } from '../../rpcErrors'
import type { CommitListing, CommitRow } from './pushReviewModel'

/** What listing a commit's directories came to; `failed` is a read that threw, and can be tried again. */
export type CommitListingState = 'idle' | 'loading' | CommitListing | { failed: string }

/**
 * Reads what the review needs to show the entries of the directories a push sends, a commit at a
 * time, through the code view's commit file store: the commit's tree and, for a commit with
 * several parents, the paths at which it differs from each. No narrower read exists, so the tree
 * is the commit's whole tree, and a tree the workspace does not hold is pulled from its
 * connection. With `eager` every commit given is read as soon as it is given; otherwise one is
 * read when `request(commit)` asks, and `requestAll()` reads every one that has not been.
 */
export const usePushReviewListings = (overseer: RpcStub<Overseer>, commits: readonly CommitRow[], eager: boolean) => {
  const [states, setStates] = useState<ReadonlyMap<string, CommitListingState>>(new Map())
  // The states as last written, ahead of the render, so that no commit is read twice.
  const latest = useRef(states)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const write = (oid: string, state: CommitListingState) => {
    const next = new Map(latest.current)
    next.set(oid, state)
    latest.current = next
    setStates(next)
  }

  const read = (wanted: readonly CommitRow[]) => {
    for (const { oid, parents } of wanted) {
      write(oid, 'loading')
      // Inside a promise, so that a read that throws at once fails as one that rejects does.
      Promise.resolve().then(async (): Promise<CommitListing> => {
        const [tree, changed] = await Promise.all([
          commitFileStore.listTree(overseer, oid),
          Promise.all(parents.length > 1
            ? parents.map(parent => commitFileStore.listChangedPaths(overseer, parent, oid))
            : []),
        ])
        return { tree, changed }
      }).then(
        listing => { if (mounted.current) write(oid, listing) },
        (error: unknown) => {
          if (mounted.current) write(oid, { failed: rpcFailureDescription(error) ?? 'This directory could not be listed.' })
        })
    }
  }

  const unread = () => commits.filter(commit => !latest.current.has(commit.oid))

  // The commits arrive a page at a time, and each page's are read as it comes.
  const unreadKeys = eager ? unread().map(commit => commit.oid).join('\n') : ''
  useEffect(() => {
    if (unreadKeys !== '') read(unread())
    // `unreadKeys` stands for the commits; `read` and `unread` are rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadKeys, overseer])

  return {
    /** What each commit read so far came to, by its oid; a commit not in it is `idle`. */
    states,
    /** Reads one commit's listing, unless it has been read or is being read. */
    request: (commit: CommitRow) => { if (!latest.current.has(commit.oid)) read([commit]) },
    requestAll: () => read(unread()),
    /** Reads again every listing whose read threw. */
    retry: () => read(commits.filter(commit => {
      const state = latest.current.get(commit.oid)
      return typeof state === 'object' && 'failed' in state
    })),
  }
}
