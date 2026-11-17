import { useEffect, useMemo, useState } from 'react'
import type { CommitInfo, FileAtCommit } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { readChangedPaths, readCodeFiles, readCodeText, readCommitLog } from './codeReads'
import { changedFiles, shownFile, type CodeFile } from './gadgetCode'

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

/** Two commits of the code, compared: what changed from the one to the other. */
export type CodeComparison = { from: string; to: string }

/** The shown file as it was before, where the code is compared: empty where it was added. */
export type CodeBeforeState = { status: 'loading' } | { status: 'text'; text: string }

export type UseGadgetCodeOptions = {
  workspaceId: string
  /** The commit shown: a gadget's head, a worktree's accepted commit. Nothing is read without it. */
  commit: string | undefined
  /** Shows only what changed between two commits, and each file as the change to it. */
  comparing?: CodeComparison
  /** The file asked for, which is shown when it is there, else the first. */
  asked: string | undefined
  /** Nothing is read until it is. */
  active: boolean
  /**
   * Orders and marks the files listed, as a worktree's are without a gadget's roles. Should keep
   * its identity between renders.
   */
  arrange?: (files: CodeFile[]) => CodeFile[]
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const stateOf = (kind: CodeFile['kind'], read: FileAtCommit | undefined): CodeFileState => {
  if (kind === 'symlink') return { status: 'other', message: 'It’s a link to another file, so there’s nothing in it to show.' }
  if (kind === 'submodule') return { status: 'other', message: 'It’s another project’s code, kept apart, so there’s nothing here to show.' }
  switch (read?.kind) {
    case 'text': return { status: 'text', text: read.text }
    case 'unreadable': return { status: 'other', message: read.message }
    default: return { status: 'failed', message: 'It isn’t in this version of the code.' }
  }
}

const readable = (kind: CodeFile['kind']) => kind === 'file' || kind === 'executable'

/**
 * A gadget's code at a commit, read as it is shown (`listTree`, `readFilesAtCommit`, kept by commit
 * in `codeReads`): its files and the text of the one shown, which is the one `asked` for where it
 * is there, else the first. Compared with another commit (`comparing`), only what changed is
 * listed, each marked how, and the shown file's text before the change comes with it. A way to
 * read again what failed comes back too.
 */
export const useGadgetCode = ({ workspaceId, commit, comparing, asked, active, arrange }: UseGadgetCodeOptions) => {
  const { api, reconnecting } = useApi()
  const open = useMemo(() => () => api.openWorkspace(workspaceId), [api, workspaceId])
  const to = comparing?.to ?? commit
  const from = comparing?.from
  // What a list was read for: the commit shown, and what it is compared with.
  const listKey = to && `${from ?? ''}\n${to}`
  const [files, setFiles] = useState<{ key?: string; state: CodeFilesState }>({ state: { status: 'loading' } })
  const [text, setText] = useState<{ key?: string; state: CodeFileState }>({ state: { status: 'loading' } })
  const [before, setBefore] = useState<{ key: string; text?: string }>()
  // Bumped to read again what failed.
  const [attempt, setAttempt] = useState(0)
  const ready = useMemo(() => {
    if (files.key !== listKey || files.state.status !== 'ready') return undefined
    return arrange ? arrange(files.state.files) : files.state.files
  }, [files, listKey, arrange])
  const shown = ready && shownFile(ready, asked)
  const shownPath = shown?.path
  const shownKind = shown?.kind
  const shownChange = shown?.change

  useEffect(() => {
    if (!active || !to || !listKey || reconnecting) return
    let current = true
    const read = from
      ? Promise.all([readCodeFiles(open, to), readCodeFiles(open, from), readChangedPaths(open, from, to)])
        .then(([after, earlier, paths]) => changedFiles(after, earlier, paths))
      : readCodeFiles(open, to)
    read.then(
      (found) => current && setFiles({ key: listKey, state: { status: 'ready', files: found } }),
      (error: unknown) => current && setFiles({ key: listKey, state: { status: 'failed', message: messageOf(error) } }),
    )
    return () => { current = false }
  }, [open, reconnecting, to, from, listKey, active, attempt])

  // The shown file as it is: at the commit shown, or as it was where the change took it away.
  const textKey = to && shownPath !== undefined ? `${listKey}\n${shownPath}` : undefined
  useEffect(() => {
    if (!active || !to || !textKey || shownPath === undefined || shownKind === undefined || reconnecting) return
    let current = true
    if (shownChange === 'removed') {
      setText({ key: textKey, state: { status: 'text', text: '' } })
      return
    }
    const read = readable(shownKind) ? readCodeText(open, to, shownPath) : Promise.resolve(undefined)
    read.then(
      (entry) => current && setText({ key: textKey, state: stateOf(shownKind, entry) }),
      (error: unknown) => current && setText({ key: textKey, state: { status: 'failed', message: messageOf(error) } }),
    )
    return () => { current = false }
  }, [open, reconnecting, to, textKey, shownPath, shownKind, shownChange, active, attempt])

  // And as it was before the change, where the code is compared: nothing where it was added.
  useEffect(() => {
    if (!active || !from || !textKey || shownPath === undefined || shownChange === undefined || reconnecting) return
    let current = true
    if (shownChange === 'added') {
      setBefore({ key: textKey, text: '' })
      return
    }
    readCodeText(open, from, shownPath).then(
      (entry) => current && setBefore({ key: textKey, text: entry?.kind === 'text' ? entry.text : '' }),
      // Without what it was, it is shown as it is.
      () => current && setBefore({ key: textKey }),
    )
    return () => { current = false }
  }, [open, reconnecting, from, textKey, shownPath, shownChange, active, attempt])

  const filesState: CodeFilesState = !listKey || files.key !== listKey ? { status: 'loading' }
    : ready ? { status: 'ready', files: ready } : files.state
  const textState: CodeFileState = textKey && text.key === textKey ? text.state : { status: 'loading' }
  const beforeState: CodeBeforeState | undefined = !from || shownChange === undefined ? undefined
    : !before || before.key !== textKey ? { status: 'loading' }
      : before.text === undefined ? undefined : { status: 'text', text: before.text }
  const retry = () => {
    setFiles({ state: { status: 'loading' } })
    setText({ state: { status: 'loading' } })
    setAttempt((count) => count + 1)
  }
  return { files: filesState, shown: shownPath, file: textState, before: beforeState, retry }
}

/** The commits a gadget's code was kept in, as they are read. */
export type CodeHistoryState =
  | { status: 'loading' }
  | { status: 'ready'; commits: CommitInfo[] }
  | { status: 'failed'; message: string }

// How far back its history goes: a gadget's commits are a chat's accepted changes each.
const HISTORY = 50

/**
 * The commits from `head` back, newest first (`getCommitLog`): each time the code was kept, which
 * can be compared with the one before it. Read once `active`.
 */
export const useCodeHistory = (workspaceId: string, head: string | undefined, active: boolean): CodeHistoryState => {
  const { api, reconnecting } = useApi()
  const [log, setLog] = useState<{ head: string; state: CodeHistoryState }>()
  useEffect(() => {
    if (!active || !head || reconnecting) return
    let current = true
    readCommitLog(() => api.openWorkspace(workspaceId), head, HISTORY).then(
      (commits) => current && setLog({ head, state: { status: 'ready', commits } }),
      (error: unknown) => current && setLog({ head, state: { status: 'failed', message: messageOf(error) } }),
    )
    return () => { current = false }
  }, [api, reconnecting, workspaceId, head, active])
  return log && log.head === head ? log.state : { status: 'loading' }
}
