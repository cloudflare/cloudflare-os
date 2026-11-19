import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileAtCommit } from '@gadgets/workshop-shared/api'
import type { FileChange, FileContent } from '@gadgets/workshop-shared/code-change'
import type { GadgetChatCode } from '@/chat/code/ChatCode'
import { useApi } from '@/rpc/ApiContext'
import { chatFileContent, chatFileList, needsBase, presentPaths } from './chatCodeFiles'
import { readChangedPaths, readCodeFiles, readCodeText } from './codeReads'
import { shownFile, type CodeFile } from './gadgetCode'
import type { CodeBeforeState, CodeFileState, CodeFilesState } from './useGadgetCode'

export type UseChatGadgetCodeOptions = {
  workspaceId: string
  /** What the chat does to the gadget, as it is now: nothing where it has done nothing. */
  code: GadgetChatCode | undefined
  /** What its changes apply over, and what they are compared with (`chatCodeCommits`). */
  commits: { base?: string; review?: string }
  /** The commits are known: the workspace has said what the gadget's head is. */
  known: boolean
  /** The file asked for, which is shown when it is there, else the first. */
  asked: string | undefined
  /** Nothing is read until it is. */
  active: boolean
}

const NO_FILES: CodeFile[] = []
const NO_CHANGES: ReadonlyMap<string, FileChange> = new Map()
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const contentOf = (read: FileAtCommit | undefined): FileContent | undefined =>
  read?.kind === 'text' ? read.text : read?.kind === 'blob' ? read.blob : undefined
const readable = (kind: CodeFile['kind']) => kind === 'file' || kind === 'executable'

const stateOf = (file: CodeFile, read: FileAtCommit | undefined, change: FileChange | undefined): CodeFileState => {
  if (file.kind === 'symlink') return { status: 'other', message: 'It’s a link to another file, so there’s nothing in it to show.' }
  if (file.kind === 'submodule') return { status: 'other', message: 'It’s another project’s code, kept apart, so there’s nothing here to show.' }
  if (read?.kind === 'unreadable' && needsBase(change)) return { status: 'other', message: read.message }
  let content: FileContent | undefined
  try {
    content = chatFileContent(contentOf(read), change)
  } catch {
    return { status: 'failed', message: 'The chat’s change to it doesn’t fit it.' }
  }
  if (content === undefined) return file.change === 'removed' ? { status: 'text', text: '' } : { status: 'failed', message: 'It isn’t in the chat’s version of the code.' }
  return typeof content === 'string' ? { status: 'text', text: content } : { status: 'other', message: 'It isn’t text, so there’s nothing in it to show.' }
}

/**
 * A gadget's code as a chat has it (see `ChatCode`): its files at the commit the chat's changes
 * apply over, read as `useGadgetCode` reads a commit, with the changes on top, each file marked as
 * it differs from what it is compared with. The shown file's text is read at that commit only
 * where the chat edits it rather than setting it whole, and is had with the changes on top as they
 * come, so that typing reads nothing; where it changed, what it was comes with it, to show it as
 * the change. A gadget the chat made starts from no files.
 *
 * `textOf` and `reviewTextOf` read any file as the chat has it now, and as it is compared with,
 * for what is done to it from its menu.
 */
export const useChatGadgetCode = ({ workspaceId, code, commits, known, asked, active }: UseChatGadgetCodeOptions) => {
  const { api, reconnecting } = useApi()
  const open = useMemo(() => () => api.openWorkspace(workspaceId), [api, workspaceId])
  const { base, review } = commits
  const changes = code?.files ?? NO_CHANGES
  const latest = useRef(changes)
  latest.current = changes
  const listKey = known ? `${base ?? ''}\n${review ?? ''}` : undefined
  const [trees, setTrees] = useState<{ key: string; state: { status: 'ready'; base: CodeFile[]; review: CodeFile[]; moved: string[] } | { status: 'failed'; message: string } }>()
  const [read, setRead] = useState<{ key: string; base?: FileAtCommit; failed?: string }>()
  const [before, setBefore] = useState<{ key: string; text?: string }>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!active || listKey === undefined || reconnecting) return
    let current = true
    const moves = base !== undefined && review !== undefined && review !== base
    Promise.all([
      base ? readCodeFiles(open, base) : NO_FILES,
      moves ? readCodeFiles(open, review) : undefined,
      moves ? readChangedPaths(open, review, base) : [],
    ]).then(
      ([atBase, atReview, moved]) => current && setTrees({ key: listKey, state: { status: 'ready', base: atBase, review: atReview ?? atBase, moved } }),
      (error: unknown) => current && setTrees({ key: listKey, state: { status: 'failed', message: messageOf(error) } }),
    )
    return () => { current = false }
  }, [open, reconnecting, base, review, listKey, active, attempt])

  // Listing needs only which files the changes leave there, which typing leaves as it was.
  const present = JSON.stringify([...presentPaths(changes)])
  const tree = trees?.key === listKey ? trees?.state : undefined
  const listed = useMemo(() => tree?.status === 'ready'
    ? chatFileList({ ...tree, present: new Map(JSON.parse(present) as [string, boolean][]) })
    : undefined, [tree, present])
  const atBasePaths = useMemo(() => new Set(tree?.status === 'ready' ? tree.base.map(({ path }) => path) : []), [tree])
  const shown = listed && shownFile(listed, asked)
  const shownPath = shown?.path
  const shownChange = shown?.change
  const change = shownPath === undefined ? undefined : changes.get(shownPath)
  const atBase = shown !== undefined && base !== undefined && atBasePaths.has(shown.path) && readable(shown.kind)
  const wantsBase = atBase && needsBase(change)

  // The shown file at the base, where what the chat does to it needs what it was.
  const textKey = listKey !== undefined && shownPath !== undefined ? `${listKey}\n${shownPath}` : undefined
  useEffect(() => {
    if (!active || !textKey || !wantsBase || !base || shownPath === undefined || reconnecting) return
    let current = true
    readCodeText(open, base, shownPath).then(
      (entry) => current && setRead({ key: textKey, base: entry }),
      (error: unknown) => current && setRead({ key: textKey, failed: messageOf(error) }),
    )
    return () => { current = false }
  }, [open, reconnecting, base, textKey, shownPath, wantsBase, active, attempt])

  // And as it is compared with, where it changed: nothing where the chat made it.
  useEffect(() => {
    if (!active || !textKey || !shownChange || shownPath === undefined || reconnecting) return
    let current = true
    if (shownChange === 'added' || !review) {
      setBefore({ key: textKey, text: '' })
      return
    }
    readCodeText(open, review, shownPath).then(
      (entry) => current && setBefore({ key: textKey, text: entry?.kind === 'text' ? entry.text : '' }),
      // Without what it was, it is shown as it is.
      () => current && setBefore({ key: textKey }),
    )
    return () => { current = false }
  }, [open, reconnecting, review, textKey, shownPath, shownChange, active, attempt])

  const files: CodeFilesState = !tree ? { status: 'loading' }
    : tree.status === 'failed' ? tree : { status: 'ready', files: listed ?? NO_FILES }
  const baseRead = read?.key === textKey ? read : undefined
  const file: CodeFileState = !shown ? { status: 'loading' }
    : wantsBase && !baseRead ? { status: 'loading' }
      : baseRead?.failed ? { status: 'failed', message: baseRead.failed }
        : stateOf(shown, wantsBase ? baseRead?.base : undefined, change)
  const beforeState: CodeBeforeState | undefined = !shownChange ? undefined
    : !before || before.key !== textKey ? { status: 'loading' }
      : before.text === undefined ? undefined : { status: 'text', text: before.text }

  /** The file at `path` as the chat has it now: nothing where it has no text. */
  const textOf = async (path: string): Promise<string | undefined> => {
    const first = latest.current.get(path)
    const was = base && needsBase(first) ? contentOf(await readCodeText(open, base, path)) : undefined
    // What the chat does to it may have moved on while it was read.
    const content = chatFileContent(was, latest.current.get(path))
    return typeof content === 'string' ? content : undefined
  }
  /** The file at `path` as it is compared with: nothing where it is not there. */
  const reviewTextOf = async (path: string): Promise<{ text?: string; there: boolean }> => {
    if (!review) return { there: false }
    const found = await readCodeText(open, review, path)
    return { text: found?.kind === 'text' ? found.text : undefined, there: found !== undefined && found.kind !== 'absent' }
  }
  const retry = () => {
    setTrees(undefined)
    setRead(undefined)
    setAttempt((count) => count + 1)
  }
  return { files, shown: shownPath, file, before: beforeState, retry, textOf, reviewTextOf }
}
