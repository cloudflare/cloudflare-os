import { applyCodeChange, type FileChange, type FileContent } from '@gadgets/workshop-shared/code-change'
import type { GadgetChatCode } from '@/chat/code/ChatCode'
import { fileOffers } from './codeDrafts'
import { codeFileAt, orderCodeFiles, type CodeFile } from './gadgetCode'

/**
 * The commits a gadget's code beside a chat is read from: what the chat's changes apply over
 * (`base`), and what they are compared with to say what changed (`review`). Over its pin where the
 * chat has one, else the commit the chat's last keep made of it while the head has not caught up,
 * else its head. Neither, for a gadget the chat made, which starts from nothing.
 */
export const chatCodeCommits = (code: GadgetChatCode | undefined, head: string | undefined) => {
  const base = code?.base ?? (code?.kept && head === code.kept.over ? code.kept.commit : head)
  return { base, review: code?.review ?? base }
}

/** What reading a file at `base` is for: what a change does to it needs what it was, but for a set or a removal. */
export const needsBase = (change: FileChange | undefined) => change === undefined || 'edit' in change

/** A file as the chat has it: as it was (`before`) with what the chat does to it on top. */
export const chatFileContent = (before: FileContent | undefined, change: FileChange | undefined): FileContent | undefined => {
  if (!change) return before
  const files = new Map<string, FileContent>(before === undefined ? [] : [['', before]])
  return applyCodeChange(new Map([[0, files]]), { 0: [['', change]] }).get(0)?.get('')
}

/** Which of the files a chat's changes touch it leaves there, by path: what listing them needs of the changes. */
export const presentPaths = (changes: ReadonlyMap<string, FileChange>): ReadonlyMap<string, boolean> =>
  new Map([...changes].map(([path, change]) => [path, !('remove' in change)]))

export type ChatFileListing = {
  /** The files at the commit the changes apply over. */
  base: readonly CodeFile[]
  /** The files at the commit they are compared with: the same, where it is the same commit. */
  review: readonly CodeFile[]
  /** The paths that differ between the two, as the chat brought in what was kept elsewhere. */
  moved: readonly string[]
  /** The files the chat's changes touch, and whether each is left there (`presentPaths`). */
  present: ReadonlyMap<string, boolean>
}

/**
 * The files as the chat has them, in the order the Code tab lists them: those at the base, but
 * for what the changes remove, with what they make, each marked as it differs from the review
 * (`change`), and those there that the chat took away after them, marked so.
 */
export const chatFileList = ({ base, review, moved, present }: ChatFileListing): CodeFile[] => {
  const touched = new Set([...present.keys(), ...moved])
  const reviewed = new Set(review.map(({ path }) => path))
  const files = new Map(base.map((file) => [file.path, file]))
  for (const [path, stays] of present) {
    if (!stays) files.delete(path)
    else if (!files.has(path)) files.set(path, codeFileAt(path))
  }
  const marked = [...files.values()].map((file): CodeFile => {
    if (!touched.has(file.path)) return file
    return { ...file, change: reviewed.has(file.path) ? 'modified' : 'added' }
  })
  const removed = review.filter(({ path }) => touched.has(path) && !files.has(path)).map((file): CodeFile => ({ ...file, change: 'removed' }))
  return [...orderCodeFiles(marked), ...removed]
}

/**
 * What can be done to a file of the chat's from its menu (see `fileOffers`): one the chat took
 * away is only put back, and one the chat changed is put back as it was.
 */
export const chatFileOffers = (file: CodeFile, files: readonly CodeFile[], gadget: string, readable: boolean) => {
  const edit = file.change === 'removed' ? 'deleted' as const : file.change === 'added' ? 'added' as const : file.change ? 'changed' as const : undefined
  return fileOffers({ ...file, edit }, files.filter(({ change }) => change !== 'removed'), gadget, readable, 'It’s deleted in this chat.')
}
