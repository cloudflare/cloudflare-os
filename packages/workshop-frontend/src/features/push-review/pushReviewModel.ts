import {
  PUSH_REVIEW_PAGE_SIZE, READ_FILES_RESPONSE_BUDGET,
  type PushReviewEntry, type PushReviewParentEntry, type PushReviewTreeEntry,
} from '@gadgets/workshop-shared/api'
import type { GitOid } from '@gadgets/workshop-shared/gatekeeper'
import { formatSize } from '../../components/ActionFields'

// What the push review shows, worked out from the entries Overseer.getPushReview() returns. Pure:
// the hooks beside this file do the reading, and the views say what these functions return.

/** A commit the push sends. */
export type CommitRow = Extract<PushReviewEntry, { kind: 'commit' }>
/** A path at which a commit of the push differs from every parent. */
export type PathRow = Extract<PushReviewEntry, { kind: 'path' }>
/** An object the push sends that no commit or path accounts for. */
export type ObjectRow = Extract<PushReviewEntry, { kind: 'object' }>

/** A commit of the review with the paths it changes, in the order the review lists them. */
export type ReviewedCommit = { commit: CommitRow, paths: PathRow[] }

/** How the review names the root directory, whose path is the empty string. */
export const ROOT_LABEL = '(root directory)'

/** An oid cut to what a list row and a sentence have room for. The full oid is always nearby. */
export const shortOid = (oid: GitOid) => oid.slice(0, 12)

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

// ---- commit text ---------------------------------------------------------------------------------

/**
 * One header line of a commit, or a line that is not one. A header is `name SP value`, its value
 * continued by the lines after it that start with a space (a signature). `raw` is a line with no
 * space, or a continuation with no header to continue, kept as written.
 */
export type CommitHeader = { name: string, value: string } | { raw: string }

/**
 * A commit's text taken apart for display, losing nothing: `formatCommitText` gives the text
 * back for every string. `message` is absent when nothing follows the blank line that ends the
 * headers, and `terminated` is false when there is no such line at all.
 */
export type ParsedCommitText = { headers: CommitHeader[], message?: string, terminated: boolean }

/** Splits a commit's text into its headers and its message. Total: any string parses. */
export const parseCommitText = (text: string): ParsedCommitText => {
  const lines = text.split('\n')
  const blank = lines.indexOf('')
  const headers: CommitHeader[] = []
  // The header a line starting with a space continues, until a line that is not a header.
  let open: { name: string, value: string } | undefined
  for (const line of blank === -1 ? lines : lines.slice(0, blank)) {
    const space = line.indexOf(' ')
    if (space === 0 && open) {
      open.value += `\n${line.slice(1)}`
    } else if (space > 0) {
      open = { name: line.slice(0, space), value: line.slice(space + 1) }
      headers.push(open)
    } else {
      open = undefined
      headers.push({ raw: line })
    }
  }
  return {
    headers,
    terminated: blank !== -1,
    ...(blank !== -1 && blank < lines.length - 1 && { message: lines.slice(blank + 1).join('\n') }),
  }
}

/** The inverse of `parseCommitText`. */
export const formatCommitText = ({ headers, message, terminated }: ParsedCommitText): string => [
  ...headers.map(header =>
    'raw' in header ? header.raw : `${header.name} ${header.value.replaceAll('\n', '\n ')}`),
  ...(terminated ? [''] : []),
  ...(message === undefined ? [] : [message]),
].join('\n')

/**
 * The first line of a commit's message, as `parseCommitText` finds it, without taking the whole
 * text apart: absent when the text has no message.
 */
export const commitSubject = (text: string): string | undefined => {
  // Where the blank line that ends the headers begins: it is followed by a line break exactly
  // when a message follows it.
  const blank = text.startsWith('\n') ? 0 : text.indexOf('\n\n') + 1
  if (blank === 0 && !text.startsWith('\n')) return undefined
  const end = text.indexOf('\n', blank + 1)
  return text.slice(blank + 1, end === -1 ? undefined : end)
}

// ---- rows ----------------------------------------------------------------------------------------

/**
 * The review's entries by commit. A path row follows its commit, on the same page or a later
 * one. A path row whose commit is not among the entries gets a commit row of its own, so that no
 * row is left out.
 */
export const groupPushReview = (
  entries: readonly PushReviewEntry[],
): { commits: ReviewedCommit[], objects: ObjectRow[] } => {
  const commits: ReviewedCommit[] = []
  const byOid = new Map<GitOid, ReviewedCommit>()
  const objects: ObjectRow[] = []
  const group = (commit: CommitRow) => {
    const reviewed = { commit, paths: [] }
    byOid.set(commit.oid, reviewed)
    commits.push(reviewed)
    return reviewed
  }
  for (const entry of entries) {
    if (entry.kind === 'commit') group(entry)
    else if (entry.kind === 'object') objects.push(entry)
    else (byOid.get(entry.commit) ?? group({ kind: 'commit', oid: entry.commit, parents: [] })).paths.push(entry)
  }
  return { commits, objects }
}

/** One thing the review lists and shows when selected: a commit, a path of one, or an object. */
export type ReviewItem =
  | { kind: 'commit', key: string, reviewed: ReviewedCommit }
  | { kind: 'path', key: string, reviewed: ReviewedCommit, row: PathRow }
  | { kind: 'object', key: string, row: ObjectRow }

/** The review's list, in order: each commit, the paths it lists, then the objects without a path. */
export const reviewItems = (
  { commits, objects }: { commits: readonly ReviewedCommit[], objects: readonly ObjectRow[] },
): ReviewItem[] => [
  ...commits.flatMap((reviewed): ReviewItem[] => [
    { kind: 'commit', key: entryKey(reviewed.commit), reviewed },
    ...listedPaths(reviewed).map((row): ReviewItem => ({ kind: 'path', key: entryKey(row), reviewed, row })),
  ]),
  ...objects.map((row): ReviewItem => ({ kind: 'object', key: entryKey(row), row })),
]

/** What identifies an entry within one listing: no listing yields a key twice. */
export const entryKey = (entry: PushReviewEntry): string =>
  entry.kind === 'path' ? `path:${entry.commit}:${entry.path}` : `${entry.kind}:${entry.oid}`

/**
 * How many distinct objects the entries say the push sends: the commits, the objects sent at a
 * path, and the objects no path accounts for. Over one whole listing this is the review's
 * `objectCount`.
 */
export const sentObjectCount = (entries: readonly PushReviewEntry[]): number => {
  const oids = new Set<GitOid>()
  for (const entry of entries) {
    if (entry.kind !== 'path') oids.add(entry.oid)
    else if (entry.sent && entry.entry) oids.add(entry.entry.oid)
  }
  return oids.size
}

const isFile = (entry: PushReviewTreeEntry | PushReviewParentEntry | undefined) =>
  entry?.kind === 'file' || entry?.kind === 'executable'

const hasEntry = (parent: PushReviewParentEntry): parent is PushReviewTreeEntry => 'oid' in parent

/** Whether the kernel promises that reading this row returns text: a sent file listed as text. */
export const expectsText = (row: PathRow): boolean => row.sent?.kind === 'text' && isFile(row.entry)

/** What a commit did at a path. `mode`: the content is a parent's, under another mode. */
export const pathChange = (row: PathRow): 'added' | 'deleted' | 'mode' | 'modified' => {
  const { entry } = row
  if (!entry) return 'deleted'
  if (row.parents.every(parent => parent.kind === 'none')) return 'added'
  return row.parents.some(parent => hasEntry(parent) && parent.oid === entry.oid && parent.kind !== entry.kind)
    ? 'mode'
    : 'modified'
}

/** The first parent that has a file or a symbolic link at the row's path: what to compare with. */
export const comparableParent = (row: PathRow): number | undefined => {
  const index = row.parents.findIndex(parent => isFile(parent) || parent.kind === 'symlink')
  return index === -1 ? undefined : index
}

// A directory the review opens: its changed entries are rows of their own. One that replaces a
// file is not: its row is where the removed file shows.
const opensDirectory = (row: PathRow) =>
  row.sent?.kind === 'dir' &&
  row.parents.every(parent => parent.kind === 'dir' || parent.kind === 'none' || parent.kind === 'unknown')

/**
 * The commit's rows that the review lists: all of them but each directory the review opens that
 * has a listed row beneath it, whose name is then in that row's path. A directory with nothing
 * listed beneath it stays, because its row is the only place its name shows. Over the rows
 * loaded so far, a directory whose rows are on a page to come shows until they arrive.
 */
export const listedPaths = ({ paths }: ReviewedCommit): PathRow[] => {
  // The paths with a listed row beneath them. Rows come directory first, so the walk runs
  // backwards, and a listed row adds every directory above it.
  const above = new Set<string>()
  const folded = new Set<PathRow>()
  for (let index = paths.length - 1; index >= 0; index--) {
    const row = paths[index]
    if (opensDirectory(row) && above.has(row.path)) {
      folded.add(row)
      continue
    }
    let path = row.path
    while (path !== '') {
      path = parentPath(path)
      // A path in the set has every directory above it there too.
      if (above.has(path)) break
      above.add(path)
    }
  }
  return paths.filter(row => !folded.has(row))
}

const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

const KIND_WORDS = {
  file: 'file', executable: 'executable', dir: 'directory', symlink: 'symbolic link',
  submodule: 'submodule entry',
} as const

/**
 * What the file view knows beyond the row: the commit's parents, to name the one a statement is
 * about, and whether rows are listed beneath a directory row (`loading` while they may be on a
 * page to come).
 */
export type PathNotesContext = {
  parents?: readonly GitOid[]
  beneath?: 'none' | 'listed' | 'loading'
}

/** The plain statements shown above a path's content: what it is, and why it is shown as it is. */
export const pathNotes = (row: PathRow, { parents = [], beneath = 'none' }: PathNotesContext = {}): string[] => {
  const { entry, sent } = row
  const notes: string[] = []
  if (!entry) {
    // One statement for each kind of thing a parent had there.
    for (const parent of new Map(row.parents.map(had => [had.kind, had])).values()) {
      if (parent.kind === 'dir') {
        notes.push('A directory: everything under it is removed with it, and is not listed here.')
      } else if (parent.kind === 'submodule') {
        notes.push(`A submodule entry: commit ${parent.oid}.`)
      } else if (parent.kind === 'symlink') {
        notes.push('A symbolic link.')
      }
    }
  } else {
    if (sent) notes.push('Sent by this push.')
    else if (entry.kind !== 'submodule') notes.push('Not sent: the remote already has this content.')

    const held = row.parents.filter(hasEntry)
    // Each kind a parent has this path under that the entry is not: the same content under
    // another mode, or other content too. A directory on either side of other content is a
    // replacement, said below.
    const earlierKinds = new Set(held
      .filter(parent => parent.kind !== entry.kind &&
        (parent.oid === entry.oid || (parent.kind !== 'dir' && entry.kind !== 'dir')))
      .map(parent => parent.kind))
    for (const kind of earlierKinds) notes.push(`Mode changed: ${KIND_WORDS[kind]} to ${KIND_WORDS[entry.kind]}.`)

    // With no change of mode to say so, an executable says what it is, as a link does.
    if (entry.kind === 'executable' && earlierKinds.size === 0) notes.push('Executable file.')
    if (entry.kind === 'symlink') notes.push('Symbolic link.')
    if (entry.kind === 'submodule') {
      const was = held.find(parent => parent.kind === 'submodule')
      notes.push(`Submodule entry: commit ${entry.oid}${was ? `, was ${was.oid}` : ''}.`)
    }
    if (entry.kind === 'dir' && !sent) notes.push('Directory the remote already has.')
    if (sent?.kind === 'dir') {
      notes.push(
        sent.size === 0 ? 'Empty directory.'
          : beneath === 'listed' ? 'Directory: what it changes is listed beneath it.'
            : beneath === 'loading' ? 'Directory: what it changes is still loading.'
              : 'Directory with no changed entry: a parent already has each of its entries.')
    }

    if (entry.kind === 'dir') {
      const replaced = held.find(parent => parent.kind !== 'dir')
      if (replaced) notes.push(`Replaces a ${isFile(replaced) ? 'file' : KIND_WORDS[replaced.kind]}.`)
    } else if (row.parents.some(parent => parent.kind === 'dir')) {
      notes.push('Replaces a directory.')
    }
  }

  row.parents.forEach((of, index) => {
    if (of.kind !== 'unknown') return
    const name = parents[index] ? shortOid(parents[index]) : `${index + 1}`
    notes.push(`Parent ${name} is not in this workspace, so there is nothing to compare with.`)
  })

  switch (sent?.kind) {
    case 'binary':
      notes.push(`Not text: ${formatSize(sent.size)}. Its content cannot be shown.`)
      break
    case 'large':
      notes.push(`${formatSize(sent.size)}: over the size checked as text, so it is not read until you ask.`)
      break
    case 'absent':
      notes.push('Not in this workspace yet, so it cannot be shown.')
      break
    case 'unlistable':
      notes.push(
        'A directory that is not in the form git writes (a name that is not valid UTF-8, is ' +
        `repeated, is out of order or is not a single path segment): ${formatSize(sent.size)}. ` +
        "Its entries cannot be listed; what the push sends under it is under 'Sent without a path'.")
      break
    case 'mistyped':
      notes.push(
        `This entry says ${entry?.kind === 'dir' ? 'directory' : 'file'}, but the object is a ` +
        `${sent.type}: ${formatSize(sent.size)}. It cannot be shown here.`)
      break
  }
  return notes
}

/**
 * How many things the push sends that the review cannot show as text: a commit that is
 * unreadable or absent, a path whose object is not text, too large to have been checked, absent,
 * or not what its entry says, and every object without a path.
 */
export const notShownAsText = (entries: readonly PushReviewEntry[]): number =>
  entries.filter(entry =>
    entry.kind === 'object' ||
    (entry.kind === 'commit' && entry.text === undefined) ||
    (entry.kind === 'path' && entry.sent !== undefined && entry.sent.kind !== 'text' && entry.sent.kind !== 'dir'),
  ).length

// ---- how much loads by itself, and when the review is whole -----------------------------------------

/** The most entries, and the most objects, of a review the dialog loads without being asked. */
export const MAX_WHOLE_REVIEW_ENTRIES = 6 * PUSH_REVIEW_PAGE_SIZE

/**
 * Whether the review is more than the dialog loads without being asked. Each page makes the
 * server walk the push from its start, and a few objects can list without end (a directory that
 * names the one below it twice, at every level), so both the objects and the entries are
 * bounded; and every file listed as text is read and held, so their sizes are bounded with the
 * commits' and the paths'. The kernel queues no push this large from a workspace that holds
 * restricted data, so only a push that was already waiting can be.
 */
export const reviewTooLarge = (entries: readonly PushReviewEntry[], objectCount: number): boolean => {
  if (objectCount > MAX_WHOLE_REVIEW_ENTRIES || entries.length > MAX_WHOLE_REVIEW_ENTRIES) return true
  let size = 0
  const files = new Set<GitOid>()
  for (const entry of entries) {
    if (entry.kind === 'commit') {
      size += entry.size ?? 0
    } else if (entry.kind === 'path') {
      size += entry.path.length
      if (entry.sent?.kind === 'text' && entry.entry && !files.has(entry.entry.oid)) {
        files.add(entry.entry.oid)
        size += entry.sent.size
      }
    }
  }
  return size > READ_FILES_RESPONSE_BUDGET
}

/** How far the review's pages have loaded. */
export type ReviewProgress = {
  /** Entries loaded so far. */
  entries: number
  /** Every page is in and the listing is consistent. */
  done: boolean
  loading: boolean
  failed: boolean
}

/**
 * How far the review's files have been read. `total` and `loaded` count the files the review
 * lists as text (`expectsText`); `pending`, `failed` and `mismatched` count every read, a
 * symbolic link's and a large file's included. `eager`: the dialog reads the files by itself.
 */
export type FilesProgress = {
  total: number
  loaded: number
  pending: number
  failed: number
  mismatched: number
  eager: boolean
}

/** Whether a push can be approved from the review, and otherwise why not and what would help. */
export type ReviewReadiness =
  | { ready: true }
  | { ready: false, reason: string, retry?: 'review' | 'files', load?: 'review' | 'files' }

/**
 * Whether the whole review has loaded: every page, and every file it lists as text read and
 * come back as text, with no read in flight, failed or returning something other than the
 * review lists. That is all Approve waits for, however the review was loaded: by itself, or a
 * page and a batch of files at a time by an approver whose push is too large to load unasked.
 * What the approver opened or selected plays no part.
 */
export const reviewReadiness = (review: ReviewProgress, files: FilesProgress): ReviewReadiness => {
  if (review.loading) return { ready: false, reason: 'Loading the review.' }
  if (review.failed) return { ready: false, reason: 'The review could not be loaded.', retry: 'review' }
  if (!review.done) {
    return {
      ready: false,
      reason: `This push is too large to load by itself: ${plural(review.entries, 'entry', 'entries')} ` +
        'loaded so far. Load the rest of it to approve it.',
      load: 'review',
    }
  }
  if (files.mismatched > 0) {
    return {
      ready: false,
      reason: `${plural(files.mismatched, 'file')} did not come back as the review lists ` +
        `${files.mismatched === 1 ? 'it' : 'them'}, so this push cannot be approved here.`,
    }
  }
  if (files.failed > 0) {
    return { ready: false, reason: `${plural(files.failed, 'file')} could not be read.`, retry: 'files' }
  }
  if (files.pending > 0 || (files.loaded < files.total && files.eager)) {
    return {
      ready: false,
      // Every file listed as text is in, and a link or a large file is still being read.
      reason: files.loaded < files.total
        ? `Loading files: ${files.loaded} of ${files.total}.`
        : `Loading ${plural(files.pending, 'file')}.`,
    }
  }
  if (files.loaded < files.total) {
    return {
      ready: false,
      reason: `${files.loaded} of ${plural(files.total, 'file')} loaded. Load the rest to approve this push.`,
      load: 'files',
    }
  }
  return { ready: true }
}
