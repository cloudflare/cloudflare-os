import type { AiChatMessage, FileAtCommit, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { ChatContentSnapshot } from '../code/otClient'

// Accepting a chat's changes takes whatever its files hold, conflict markers included (see
// Overseer.mergeChanges()). Whether to let markers through is the client's call, and this is
// what it goes by: the files that the chat's merges reported as conflicted, and whether each
// still has a marker in it, in the chat's content or, where nobody has edited it since the
// merge, in the merge commit. A file one side deleted and the other changed is reported too but
// never had markers, so nothing here can tell whether anyone has looked at it.

/** A file that a merge recorded in a chat left with conflicts. */
export type ConflictedFile = { workpieceId: WorkpieceId; path: string }

/** A conflicted file that still holds a conflict marker, and the line of its first one. */
export type UnresolvedConflict = ConflictedFile & { line: number }

/**
 * The files that the chat's still-proposed merges list as conflicted: blueprint releases merged
 * into a gadget (`blueprintMerges`) and mainline commits merged into the chat (`mainlineMerge`).
 * `changeStatus` says which `changes` messages are still proposed.
 *
 * TODO: A merge on a page of history that is not loaded is not seen. A chat reopened after a
 * compaction loads only what follows the checkpoint, so a conflicted merge recorded before it
 * is accepted unchecked until the user scrolls back that far. The checkpoint carries the
 * still-proposed changes of the pages before it (AiChatHistoryPage.compacted.proposedChange)
 * but not their merge records. Having it carry those too, for this to be seeded from, would
 * close the gap: a change to workshop-backend's checkpoint builder and to the shared API.
 */
export const listConflictedFiles = (
  messages: readonly AiChatMessage[],
  changeStatus: ReadonlyMap<number, 'pending' | 'merged' | 'reverted'>,
): ConflictedFile[] => {
  const files = new Map<string, ConflictedFile>()
  const add = (workpieceId: WorkpieceId, path: string) => {
    files.set(`${workpieceId}\u0000${path}`, { workpieceId, path })
  }

  for (const message of messages) {
    if (message.type !== 'changes' || changeStatus.get(message.sequence) !== 'pending') continue

    for (const merge of message.blueprintMerges ?? []) {
      for (const path of merge.conflictPaths) add(merge.gadgetId, path)
    }

    const mainlineMerge = message.mainlineMerge
    if (mainlineMerge?.gadgets !== undefined) {
      for (const merge of mainlineMerge.gadgets) {
        for (const path of merge.conflictPaths) add(merge.gadgetId, path)
      }
      continue
    }

    // A mainline merge recorded before merges were commits names each file only as
    // `GADGET_NAME/path`, by a binding name that the client is never told. A binding name has
    // no slash in it, so the path is what follows the first, and the gadget is whichever one
    // the merge's own change touches at that path: a conflict's markers are something the
    // merge wrote.
    for (const qualified of mainlineMerge?.conflictPaths ?? []) {
      const path = qualified.slice(qualified.indexOf('/') + 1)
      for (const [workpieceId, entries] of Object.entries(message.change ?? {})) {
        if (entries.some(([changed]) => changed === path)) add(Number(workpieceId), path)
      }
    }
  }

  return [...files.values()]
}

// The lines that open and close a conflict. The separators between its sides (`|||||||`,
// `=======`) are not looked for: a conflict has both of these, and `=======` alone is a
// Markdown heading's underline.
const CONFLICT_MARKER = /^(?:<<<<<<< |>>>>>>> )/m

/** The 1-based line of the text's first conflict marker, or undefined if it has none. */
export const findConflictMarkerLine = (text: string): number | undefined => {
  const match = CONFLICT_MARKER.exec(text)
  if (match === null) return undefined
  let line = 1
  for (let at = text.indexOf('\n'); at !== -1 && at < match.index; at = text.indexOf('\n', at + 1)) {
    line++
  }
  return line
}

/**
 * Which of `files` still hold a conflict marker in `content`, the chat's uncommitted content.
 * A file the chat has not touched since its merge has the text of its pin's base commit, the
 * merge commit (see ChatGadgetPinState), which `baseOf` names and `readFiles` reads it from.
 * A file the chat removed, or whose gadget it has no pin for, has no markers to find.
 */
export const findUnresolvedConflicts = async (
  files: readonly ConflictedFile[],
  content: ChatContentSnapshot,
  baseOf: (workpieceId: WorkpieceId) => string | undefined,
  readFiles: (commitId: string, paths: readonly string[]) =>
    Promise<ReadonlyMap<string, FileAtCommit>>,
): Promise<UnresolvedConflict[]> => {
  const texts = new Map<ConflictedFile, string | null | undefined>()
  const untouched = new Map<string, ConflictedFile[]>()
  for (const file of files) {
    const text = content(file.workpieceId, file.path)
    texts.set(file, text)
    const base = text === undefined ? baseOf(file.workpieceId) : undefined
    if (base !== undefined) untouched.set(base, [...untouched.get(base) ?? [], file])
  }

  await Promise.all([...untouched].map(async ([commitId, atBase]) => {
    const read = await readFiles(commitId, atBase.map(file => file.path))
    for (const file of atBase) {
      const entry = read.get(file.path)
      texts.set(file, entry?.kind === 'text' ? entry.text : null)
    }
  }))

  return files.flatMap(file => {
    const text = texts.get(file)
    const line = typeof text === 'string' ? findConflictMarkerLine(text) : undefined
    return line === undefined ? [] : [{ ...file, line }]
  })
}
