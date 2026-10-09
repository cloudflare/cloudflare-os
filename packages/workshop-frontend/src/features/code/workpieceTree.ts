import type { FileAtCommit, TreeNode } from '@gadgets/workshop-shared/api'

// The displayed shape of a workpiece's files: the content base's tree (Overseer.listTree(), see
// TreeNode) with the chat's overlay folded in. Pure derivations, kept apart from the view so the
// overlay rules can be tested directly.

/** The git entry kinds a leaf can have. Only `file` and `executable` have text to open. */
export type LeafKind = 'file' | 'executable' | 'symlink' | 'submodule'

/** A node of the displayed tree: a leaf, or a directory carrying its (sorted) children. */
export type BrowserNode =
  | { kind: LeafKind; name: string; path: string }
  | { kind: 'dir'; name: string; path: string; children: BrowserNode[] }

/** The displayed tree with an index of its leaves by path. */
export type BrowserTree = {
  roots: BrowserNode[]
  leaves: ReadonlyMap<string, LeafKind>
}

/** How a file compares to the review base. */
export type FileChangeStatus = 'added' | 'deleted' | 'modified' | 'unchanged'

/**
 * One row of the Changes list. `pending` is a removed path whose review-base read has not
 * settled (or failed): it may prove to be a deletion, and it is listed nowhere else, so it stays
 * selectable here -- its pane shows the read's loading state or error, with the retry -- rather
 * than vanishing until the read lands.
 */
export type ChangedFile = {
  path: string
  status: Exclude<FileChangeStatus, 'unchanged'> | 'pending'
}

export const EMPTY_BROWSER_TREE: BrowserTree = { roots: [], leaves: new Map() }

// The mutable intermediate: a directory maps each name to a subdirectory or a leaf kind.
type Dir = Map<string, Dir | LeafKind>

/**
 * The displayed tree: `base` less the paths in `removed`, plus the paths in `present` the base
 * lacks (as ordinary files, with whatever ancestor directories they need). A directory left with
 * nothing in it is dropped, so a directory whose every file the chat deleted disappears. Each
 * directory lists its subdirectories first and then its leaves, each group by name.
 *
 * A present path that names an existing base leaf keeps the leaf's kind, so an edited executable
 * stays marked executable. `null` for the base means it has not loaded (or there is none, as for a
 * pending gadget): the tree is then the overlay alone.
 */
export function buildBrowserTree(
  base: readonly TreeNode[] | null,
  present: Iterable<string>,
  removed: ReadonlySet<string>,
): BrowserTree {
  const root: Dir = new Map()
  if (base !== null) addBaseNodes(root, base)
  for (const path of removed) deleteLeaf(root, path.split('/'))
  for (const path of present) insertLeaf(root, path.split('/'))
  const leaves = new Map<string, LeafKind>()
  const roots = toNodes(root, '', leaves)
  return { roots, leaves }
}

function addBaseNodes(dir: Dir, nodes: readonly TreeNode[]): void {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      const child: Dir = new Map()
      addBaseNodes(child, node.children)
      dir.set(node.name, child)
    } else {
      dir.set(node.name, node.kind)
    }
  }
}

function deleteLeaf(dir: Dir, segments: string[]): void {
  const [head, ...rest] = segments
  const entry = dir.get(head)
  if (entry === undefined) return
  if (rest.length === 0) {
    if (!(entry instanceof Map)) dir.delete(head)
    return
  }
  if (entry instanceof Map) deleteLeaf(entry, rest)
}

// A path whose ancestor is an existing leaf (`a` a file, inserting `a/b`) replaces that leaf with
// a directory: the server would have rejected the change, so this only keeps the walk total.
function insertLeaf(dir: Dir, segments: string[]): void {
  const [head, ...rest] = segments
  const entry = dir.get(head)
  if (rest.length === 0) {
    if (entry === undefined || entry instanceof Map) dir.set(head, 'file')
    return
  }
  let child: Dir
  if (entry instanceof Map) {
    child = entry
  } else {
    child = new Map()
    dir.set(head, child)
  }
  insertLeaf(child, rest)
}

function toNodes(dir: Dir, prefix: string, leaves: Map<string, LeafKind>): BrowserNode[] {
  const dirs: BrowserNode[] = []
  const files: BrowserNode[] = []
  for (const name of [...dir.keys()].toSorted(compareNames)) {
    const entry = dir.get(name)!
    const path = prefix + name
    if (entry instanceof Map) {
      const children = toNodes(entry, path + '/', leaves)
      if (children.length > 0) dirs.push({ kind: 'dir', name, path, children })
    } else {
      files.push({ kind: entry, name, path })
      leaves.set(path, entry)
    }
  }
  return [...dirs, ...files]
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The leaf paths of the tree, in display order. */
export function browserTreePaths(nodes: readonly BrowserNode[]): string[] {
  const out: string[] = []
  const walk = (list: readonly BrowserNode[]) => {
    for (const node of list) {
      if (node.kind === 'dir') walk(node.children)
      else out.push(node.path)
    }
  }
  walk(nodes)
  return out
}

/** The directory paths above `path` (`a/b/c.ts` -> `['a', 'a/b']`). */
export function ancestorDirs(path: string): string[] {
  const out: string[] = []
  let index = path.indexOf('/')
  while (index >= 0) {
    out.push(path.slice(0, index))
    index = path.indexOf('/', index + 1)
  }
  return out
}

/**
 * The destination of renaming `path` to the name typed in its row: a name relative to the file's
 * own directory, so a bare name renames in place and `sub/name` moves down a level. A file is
 * moved *up* with `..` segments (`../name`), or anywhere with a leading `/` (root-relative).
 * Returns `null` for a destination that climbs above the root or ends in an empty segment.
 */
export function resolveRenamePath(path: string, name: string): string | null {
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  const raw = name.startsWith('/') ? name.slice(1) : dir + name
  const out: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '') return null
    if (segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return null
      out.pop()
    } else {
      out.push(segment)
    }
  }
  return out.length > 0 ? out.join('/') : null
}

/**
 * A touched path's status against the review base. `displayed` is the text the view shows for
 * the path (`null` when the chat removed it); `original` is its content at the review base, or
 * `undefined` while that read is in flight -- then no status is known yet, unless there is no
 * review base at all (a pending gadget), where every displayed file is an addition.
 *
 * A removal of a path the review base lacks (added, then deleted, within the chat) is nothing to
 * review and reads as unchanged; an unreadable original (a binary the chat overwrote) can only be
 * reported as modified.
 */
export function fileChangeStatus(
  displayed: string | null,
  original: FileAtCommit | undefined,
  hasReviewBase: boolean,
): FileChangeStatus | undefined {
  if (original === undefined) {
    if (hasReviewBase) return undefined
    return displayed !== null ? 'added' : 'unchanged'
  }
  if (original.kind === 'absent') return displayed !== null ? 'added' : 'unchanged'
  if (displayed === null) return 'deleted'
  if (original.kind === 'unreadable' || original.text !== displayed) return 'modified'
  return 'unchanged'
}

/**
 * The statuses of the paths that a merge changed (see Overseer.listChangedPaths()), as an
 * untouched path displays them: the content base's entry against the review base's. Only
 * trees are read, never content, which is enough because the merge says the two differ. A
 * path neither tree has a leaf at (a file one side made a directory) has no status.
 */
export function mergedPathStatuses(
  paths: readonly string[],
  contentTree: readonly TreeNode[],
  reviewTree: readonly TreeNode[],
): Map<string, FileChangeStatus> {
  const statuses = new Map<string, FileChangeStatus>()
  for (const path of paths) {
    const displayed = hasTreeLeaf(contentTree, path)
    const original = hasTreeLeaf(reviewTree, path)
    if (displayed || original) {
      statuses.set(path, !original ? 'added' : !displayed ? 'deleted' : 'modified')
    }
  }
  return statuses
}

function hasTreeLeaf(nodes: readonly TreeNode[], path: string): boolean {
  let level = nodes
  const segments = path.split('/')
  for (let i = 0; i < segments.length; i++) {
    const node = level.find(candidate => candidate.name === segments[i])
    if (node === undefined) return false
    if (i === segments.length - 1) return node.kind !== 'dir'
    if (node.kind !== 'dir') return false
    level = node.children
  }
  return false
}

/**
 * The Changes list and the per-path statuses for the touched paths, in the paths' order, which
 * is sorted wherever `merged` adds to them. `displayed(path)` is the view's text for a touched
 * path (`null` when removed; `undefined` is skipped as untouched after all); `originals` holds
 * the review-base content loaded so far. A touched path whose original is still loading gets no
 * status; if it is a removal it is listed as `pending` (see ChangedFile), since no other listing
 * would show it.
 *
 * `merged` holds the statuses of the paths that a merge the chat's pin is rooted at changed
 * (see mergedPathStatuses). They count for the paths the chat has not touched since, which no
 * other listing would show: the chat's own content for a path takes precedence.
 */
export function deriveChanges(
  touchedPaths: readonly string[],
  displayed: (path: string) => string | null | undefined,
  originals: ReadonlyMap<string, FileAtCommit>,
  hasReviewBase: boolean,
  merged: ReadonlyMap<string, FileChangeStatus> = new Map(),
): { statuses: Map<string, FileChangeStatus>; changes: ChangedFile[] } {
  const statuses = new Map<string, FileChangeStatus>()
  const changes: ChangedFile[] = []
  const paths = merged.size === 0
    ? touchedPaths
    : [...new Set([...touchedPaths, ...merged.keys()])].toSorted()
  for (const path of paths) {
    const text = displayed(path)
    const status = text === undefined
      ? merged.get(path)
      : fileChangeStatus(text, originals.get(path), hasReviewBase)
    if (status === undefined) {
      if (text === null) changes.push({ path, status: 'pending' })
      continue
    }
    statuses.set(path, status)
    if (status !== 'unchanged') changes.push({ path, status })
  }
  return { statuses, changes }
}
