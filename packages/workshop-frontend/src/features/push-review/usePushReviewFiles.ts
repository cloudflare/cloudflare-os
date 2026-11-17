import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { MAX_READ_FILES_PER_CALL, type Overseer } from '@gadgets/workshop-shared/api'
import { commitFileStore, type CommitFile } from '../code/commitFileStore'
import { rpcFailureDescription } from '../../rpcErrors'
import { entryKey, expectsText, type PathRow } from './pushReviewModel'

/**
 * What reading a row's file came to. `text` is the content the push sends. `notText` is a file
 * too large to have been checked that turned out not to be text, with its size. `link` is a
 * symbolic link, in the words of the read, which name its target. `failed` is a read that threw,
 * and can be tried again. `mismatch` is a read that returned something other than the review
 * lists at that path: the review and the store disagree, and no retry settles that.
 */
export type PushFileState =
  | 'idle'
  | 'loading'
  | { text: string }
  | { notText: number }
  | { link: string }
  | { failed: string }
  | { mismatch: string }

// The rows whose content the push sends and that may be text. A row the store lacks is never
// read: reading it would pull from a connection.
const readable = (row: PathRow) => row.sent?.kind === 'text' || row.sent?.kind === 'large'

const LISTED_AS = { text: 'text', large: 'a large file', symlink: 'a symbolic link' } as const

// What each row promises of its read, and so what a mismatch is.
const settle = (row: PathRow, file: CommitFile): PushFileState => {
  const link = row.entry?.kind === 'symlink'
  if (link) {
    if (file.kind === 'unreadable') return { link: file.message }
  } else if (file.kind === 'text') {
    return { text: file.text }
  } else if (file.kind === 'blob' && row.sent?.kind === 'large' && file.blob.oid === row.entry?.oid) {
    return { notText: file.blob.byteLength }
  }
  const returned = file.kind === 'absent' ? 'nothing at that path'
    : file.kind === 'unreadable' ? 'something that is not a file'
      : file.kind === 'text' ? 'the text of a file'
        : row.sent?.kind === 'large' ? 'another object'
          : 'content that is not text'
  const listed = LISTED_AS[link ? 'symlink' : row.sent?.kind === 'large' ? 'large' : 'text']
  return { mismatch: `The review lists ${row.path} as ${listed}, but reading it returned ${returned}.` }
}

/**
 * Reads the files a push review lists, through the code view's commit file store. With `eager`
 * every row listed as text is read as soon as it is given; otherwise a row is read when
 * `request(row)` asks, and `requestAll()` reads every row listed as text that has not been. A
 * row listed as large is of any size and read whole, so it is read on `request(row)` alone.
 * `total` and `loaded` count the rows the kernel promises are text (`expectsText`). `pending`,
 * `failed` and `mismatched` count every row read, a symbolic link and a large file included: a
 * read that is in flight, threw or disagreed with the review is one the review has not settled.
 */
export const usePushReviewFiles = (overseer: RpcStub<Overseer>, rows: readonly PathRow[], eager: boolean) => {
  const [states, setStates] = useState<ReadonlyMap<string, PushFileState>>(new Map())
  // The states as last written, ahead of the render, so that no row is read twice.
  const latest = useRef(states)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const write = (changes: Iterable<[PathRow, PushFileState]>) => {
    const next = new Map(latest.current)
    for (const [row, state] of changes) next.set(entryKey(row), state)
    latest.current = next
    setStates(next)
  }

  const read = (wanted: readonly PathRow[]) => {
    if (wanted.length === 0) return
    write(wanted.map(row => [row, 'loading']))
    const byCommit = new Map<string, PathRow[]>()
    for (const row of wanted) {
      const ofCommit = byCommit.get(row.commit)
      if (ofCommit) ofCommit.push(row)
      else byCommit.set(row.commit, [row])
    }
    for (const [commit, ofCommit] of byCommit) {
      for (let from = 0; from < ofCommit.length; from += MAX_READ_FILES_PER_CALL) {
        const chunk = ofCommit.slice(from, from + MAX_READ_FILES_PER_CALL)
        commitFileStore.readFiles(overseer, commit, chunk.map(row => row.path)).then(
          files => {
            if (mounted.current) write(chunk.map(row => [row, settle(row, files.get(row.path)!)]))
          },
          (error: unknown) => {
            const failed = { failed: rpcFailureDescription(error) ?? 'This file could not be read.' }
            if (mounted.current) write(chunk.map(row => [row, failed]))
          })
      }
    }
  }

  const stateOf = (row: PathRow): PushFileState => states.get(entryKey(row)) ?? 'idle'
  const unreadText = () =>
    rows.filter(row => row.sent?.kind === 'text' && !latest.current.has(entryKey(row)))

  // The rows arrive a page at a time, and each page's text rows are read as it comes.
  const unreadKeys = eager ? unreadText().map(entryKey).join('\n') : ''
  useEffect(() => {
    if (unreadKeys !== '') read(unreadText())
    // `unreadKeys` stands for the rows; `read` and `unreadText` are rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadKeys, overseer])

  const promised = rows.filter(expectsText)
  const count = (of: readonly PathRow[], matches: (state: PushFileState) => boolean) =>
    of.filter(row => matches(stateOf(row))).length
  const ended = (how: 'text' | 'failed' | 'mismatch') => (state: PushFileState) =>
    typeof state === 'object' && how in state
  return {
    stateOf,
    /** Reads one row, listed as text or as large, unless it has been read or is being read. */
    request: (row: PathRow) => {
      if (readable(row) && !latest.current.has(entryKey(row))) read([row])
    },
    requestAll: () => read(unreadText()),
    /** Reads again every row whose read threw. */
    retry: () => read(rows.filter(row => ended('failed')(latest.current.get(entryKey(row)) ?? 'idle'))),
    total: promised.length,
    loaded: count(promised, ended('text')),
    pending: count(rows, state => state === 'loading'),
    failed: count(rows, ended('failed')),
    mismatched: count(rows, ended('mismatch')),
  }
}
