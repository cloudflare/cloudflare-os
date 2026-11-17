import { useEffect, useMemo, useState } from 'react'
import type { FileAtCommit } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { codeFiles, shownFile, type CodeFile } from './gadgetCode'

/** The files of a gadget's code, as they are read. */
export type CodeFilesState =
  | { status: 'loading' }
  | { status: 'ready'; files: CodeFile[] }
  | { status: 'failed'; message: string }

/** One file's text, as it is read. */
export type CodeFileState =
  | { status: 'loading' }
  | { status: 'text'; text: string }
  /** It has no text to show: not UTF-8, a symlink or a submodule, with what it is. */
  | { status: 'other'; message: string }
  | { status: 'failed'; message: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Commits never change, so what was read of one is kept, for the last few, so that coming back to
// a gadget, or to a file, reads nothing again.
const KEPT = 8
const trees = new Map<string, Promise<CodeFile[]>>()
const texts = new Map<string, Promise<FileAtCommit | undefined>>()
const keep = <T,>(cache: Map<string, T>, key: string, read: () => T) => {
  const found = cache.get(key)
  if (found) return found
  const made = read()
  cache.set(key, made)
  if (cache.size > KEPT * (cache === texts ? 16 : 1)) cache.delete(cache.keys().next().value!)
  return made
}

const stateOf = (kind: CodeFile['kind'], read: FileAtCommit | undefined): CodeFileState => {
  if (kind === 'symlink') return { status: 'other', message: 'It’s a link to another file, so there’s nothing in it to show.' }
  if (kind === 'submodule') return { status: 'other', message: 'It’s another project’s code, kept apart, so there’s nothing here to show.' }
  switch (read?.kind) {
    case 'text': return { status: 'text', text: read.text }
    case 'unreadable': return { status: 'other', message: read.message }
    default: return { status: 'failed', message: 'It isn’t in this version of the code.' }
  }
}

/**
 * A gadget's code as it was last kept (`commitId`, its head; `Overseer.listTree` and
 * `readFilesAtCommit`): its files, and the text of the one shown, which is `asked` when that is
 * among them, else the first, and a way to read again what failed. Nothing is read until
 * `active`, or while the commit is unknown. `arrange`, which should keep its identity between
 * renders, orders and marks the files listed, as a worktree's are by what changed.
 */
export const useGadgetCode = (
  workspaceId: string,
  commitId: string | undefined,
  asked: string | undefined,
  active: boolean,
  arrange?: (files: CodeFile[]) => CodeFile[],
) => {
  const { api, reconnecting } = useApi()
  const [files, setFiles] = useState<{ commitId?: string; state: CodeFilesState }>({ state: { status: 'loading' } })
  const [text, setText] = useState<{ key?: string; state: CodeFileState }>({ state: { status: 'loading' } })
  // Bumped to read again what failed, which the caches have let go of.
  const [attempt, setAttempt] = useState(0)
  const read = files.commitId === commitId && files.state.status === 'ready' ? files.state.files : undefined
  const ready = useMemo(() => (read && arrange ? arrange(read) : read), [read, arrange])
  const shown = ready && shownFile(ready, asked)
  const shownPath = shown?.path
  const shownKind = shown?.kind

  useEffect(() => {
    if (!active || !commitId || reconnecting) return
    let current = true
    let overseer: ReturnType<typeof api.openWorkspace> | undefined
    keep(trees, commitId, () => {
      overseer = api.openWorkspace(workspaceId)
      return overseer.listTree(commitId).then(codeFiles)
    }).then(
      (found) => current && setFiles({ commitId, state: { status: 'ready', files: found } }),
      (error: unknown) => {
        trees.delete(commitId)
        if (current) setFiles({ commitId, state: { status: 'failed', message: messageOf(error) } })
      },
    ).finally(() => overseer?.[Symbol.dispose]())
    return () => { current = false }
  }, [api, reconnecting, workspaceId, commitId, active, attempt])

  useEffect(() => {
    if (!active || !commitId || shownPath === undefined || shownKind === undefined || reconnecting) return
    const key = `${commitId}\n${shownPath}`
    let current = true
    let overseer: ReturnType<typeof api.openWorkspace> | undefined
    const reading = shownKind === 'file' || shownKind === 'executable'
      ? keep(texts, key, () => {
        overseer = api.openWorkspace(workspaceId)
        return overseer.readFilesAtCommit(commitId, [shownPath]).then((entries) => entries.find(([path]) => path === shownPath)?.[1])
      })
      : Promise.resolve(undefined)
    reading.then(
      (entry) => current && setText({ key, state: stateOf(shownKind, entry) }),
      (error: unknown) => {
        texts.delete(key)
        if (current) setText({ key, state: { status: 'failed', message: messageOf(error) } })
      },
    ).finally(() => overseer?.[Symbol.dispose]())
    return () => { current = false }
  }, [api, reconnecting, workspaceId, commitId, shownPath, shownKind, active, attempt])

  const filesState: CodeFilesState = !commitId || files.commitId !== commitId ? { status: 'loading' }
    : ready ? { status: 'ready', files: ready } : files.state
  const textState: CodeFileState = shown && text.key === `${commitId}\n${shown.path}` ? text.state : { status: 'loading' }
  const retry = () => {
    setFiles({ state: { status: 'loading' } })
    setText({ state: { status: 'loading' } })
    setAttempt((count) => count + 1)
  }
  return { files: filesState, shown: shown?.path, file: textState, retry }
}
