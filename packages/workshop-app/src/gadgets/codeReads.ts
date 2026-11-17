import type { CommitInfo, FileAtCommit, Overseer } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { codeFiles, type CodeFile } from './gadgetCode'

// What has been read of a workspace's code, by commit. Commits never change, so a read is kept
// for the last many and never read again: coming back to a gadget, a file or a diff fetches
// nothing. A read that failed is let go of, so that trying again reads it again.

type Open = () => RpcStub<Overseer>

const MOST = { trees: 16, texts: 256, logs: 16, changes: 64 } as const

const caches = {
  trees: new Map<string, Promise<CodeFile[]>>(),
  texts: new Map<string, Promise<FileAtCommit | undefined>>(),
  logs: new Map<string, Promise<CommitInfo[]>>(),
  changes: new Map<string, Promise<string[]>>(),
}

// A read through a workspace's Overseer, opened for it and let go of once it is answered.
const keep = <T,>(kind: keyof typeof caches, key: string, open: Open, read: (overseer: RpcStub<Overseer>) => Promise<T>): Promise<T> => {
  const cache = caches[kind] as Map<string, Promise<T>>
  const found = cache.get(key)
  if (found) {
    // The most recently used last, so that the oldest is let go of first.
    cache.delete(key)
    cache.set(key, found)
    return found
  }
  const overseer = open()
  const made = read(overseer).finally(() => overseer[Symbol.dispose]())
  cache.set(key, made)
  made.catch(() => { if (cache.get(key) === made) cache.delete(key) })
  if (cache.size > MOST[kind]) cache.delete(cache.keys().next().value!)
  return made
}

/** A commit's files, as the Code tab lists them (`codeFiles`). */
export const readCodeFiles = (open: Open, commit: string) => keep('trees', commit, open, (overseer) => overseer.listTree(commit).then(codeFiles))

/** One file at a commit; nothing where the server left it unanswered. */
export const readCodeText = (open: Open, commit: string, path: string) => keep('texts', `${commit}\n${path}`, open, (overseer) =>
  overseer.readFilesAtCommit(commit, [path]).then((entries) => entries.find(([found]) => found === path)?.[1]))

/** The commits from `head` back, newest first, up to `depth`. */
export const readCommitLog = (open: Open, head: string, depth: number) => keep('logs', `${head}\n${depth}`, open, (overseer) => overseer.getCommitLog(head, depth))

/** The paths that differ between two commits. */
export const readChangedPaths = (open: Open, from: string, to: string) => keep('changes', `${from}\n${to}`, open, (overseer) => overseer.listChangedPaths(from, to))
