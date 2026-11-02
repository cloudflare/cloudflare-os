import type {
  HierarchicalListDropDestination,
  HierarchicalListItem,
} from '@gadgets/ui/hierarchical-list'
import type { SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'

// The tree of a space's listing (`Space.listWorkspaces`), which the space delivers flat in
// depth-first pre-order. Every function here reads the listing the same way: an entry sits under
// its `parentId` only when that entry comes earlier in the listing, and at the top otherwise, so
// an entry whose parent the listing does not hold stays visible with its subtree instead of
// vanishing, and no listing can describe a cycle. Siblings keep the listing's order; `position`
// is not consulted, since the space already ordered them by it.

/** An entry of a space's listing with the entries directly under it, in their order. */
export type WorkspaceTreeNode = {
  entry: SpaceWorkspaceInfo
  children: WorkspaceTreeNode[]
}

/**
 * The arguments to `Space.moveWorkspace(id, parentId, beforeId)` after the entry's id: the entry
 * it goes under (null for the top of the tree) and the new sibling it goes immediately before,
 * omitted to place it after the last one.
 */
export type WorkspaceMove = {
  parentId: string | null
  beforeId?: string
}

type IndexedTree = {
  roots: WorkspaceTreeNode[]
  nodes: Map<string, WorkspaceTreeNode>
  parents: Map<string, string | null>
}

// Every call builds fresh nodes and child arrays, so a caller may rearrange them freely.
const indexTree = (listing: readonly SpaceWorkspaceInfo[]): IndexedTree => {
  const roots: WorkspaceTreeNode[] = []
  const nodes = new Map<string, WorkspaceTreeNode>()
  const parents = new Map<string, string | null>()
  for (const entry of listing) {
    if (nodes.has(entry.id)) continue
    const node: WorkspaceTreeNode = { entry, children: [] }
    const parent = entry.parentId === undefined ? undefined : nodes.get(entry.parentId)
    nodes.set(entry.id, node)
    parents.set(entry.id, parent ? parent.entry.id : null)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return { roots, nodes, parents }
}

const siblingNodes = (tree: IndexedTree, parentId: string | null) =>
  parentId === null ? tree.roots : tree.nodes.get(parentId)?.children ?? []

const ancestry = (tree: IndexedTree, id: string): SpaceWorkspaceInfo[] => {
  const path: SpaceWorkspaceInfo[] = []
  for (let current: string | null | undefined = id; current != null; current = tree.parents.get(current)) {
    const node = tree.nodes.get(current)
    if (!node) break
    path.unshift(node.entry)
  }
  return path
}

// A move the space would refuse: of an entry it does not list, under a parent it does not list,
// or under the entry itself or an entry beneath it.
const isRefusedMove = (tree: IndexedTree, id: string, parentId: string | null) =>
  !tree.nodes.has(id)
  || (parentId !== null
    && (!tree.nodes.has(parentId) || ancestry(tree, parentId).some(entry => entry.id === id)))

/** Nest a listing into the forest it describes. */
export const buildWorkspaceTree = (listing: readonly SpaceWorkspaceInfo[]): WorkspaceTreeNode[] =>
  indexTree(listing).roots

/** The entries from the top of the tree down to `id`, inclusive; empty when `id` is not listed. */
export const pathTo = (listing: readonly SpaceWorkspaceInfo[], id: string): SpaceWorkspaceInfo[] =>
  ancestry(indexTree(listing), id)

/** Whether `candidateId` is `ancestorId` itself or an entry somewhere beneath it. */
export const isSelfOrDescendant = (
  listing: readonly SpaceWorkspaceInfo[],
  ancestorId: string,
  candidateId: string,
): boolean => pathTo(listing, candidateId).some(entry => entry.id === ancestorId)

/** The entries directly under `parentId` (null for the top of the tree), in their order. */
export const childrenOf = (
  listing: readonly SpaceWorkspaceInfo[],
  parentId: string | null,
): SpaceWorkspaceInfo[] => siblingNodes(indexTree(listing), parentId).map(node => node.entry)

/**
 * The move that puts the entry `id` under `parentId` (null for the top of the tree) at `index`
 * among its new siblings, counted with the entry itself already taken out of the tree. An index
 * at or past the end places it last. Null for a move the space would refuse: of an entry the
 * listing does not hold, under a parent it does not hold, or under the entry itself or one of
 * its descendants.
 */
export const moveToIndex = (
  listing: readonly SpaceWorkspaceInfo[],
  id: string,
  parentId: string | null,
  index: number,
): WorkspaceMove | null => {
  const tree = indexTree(listing)
  if (isRefusedMove(tree, id, parentId)) return null
  const siblings = siblingNodes(tree, parentId).filter(node => node.entry.id !== id)
  const before = siblings[Math.max(0, index)]
  return before ? { parentId, beforeId: before.entry.id } : { parentId }
}

/**
 * The move a `HierarchicalList` `onMove(item, destination)` asks for, whose index is likewise
 * counted with the item taken out (see `moveToIndex`).
 */
export const moveForDrop = (
  listing: readonly SpaceWorkspaceInfo[],
  item: Pick<HierarchicalListItem, 'id'>,
  destination: HierarchicalListDropDestination,
): WorkspaceMove | null => moveToIndex(listing, item.id, destination.parent?.id ?? null, destination.index)

const withField = <K extends 'parentId' | 'hiddenBy'>(
  entry: SpaceWorkspaceInfo,
  field: K,
  value: SpaceWorkspaceInfo[K],
): SpaceWorkspaceInfo => {
  if (entry[field] === value) return entry
  const next = { ...entry }
  if (value === undefined) delete next[field]
  else next[field] = value
  return next
}

/**
 * The listing as it will be once `Space.moveWorkspace(id, move.parentId, move.beforeId)`
 * succeeds, in the same pre-order form, for showing a move before the space confirms it. The
 * entry moves with its subtree to just before `beforeId`, or after its last new sibling when
 * `beforeId` is omitted, is `id` itself, or is not directly under `parentId`, as the space does.
 * The sibling group it left and the one it joins are renumbered in order, and every entry's
 * `hiddenBy` is derived afresh from the moved tree, so a published entry now under an
 * unpublished one shows as hidden.
 *
 * A move the space would refuse (see `moveToIndex`) leaves the listing as it was. The input is
 * not modified, and entries that do not change are carried over as they are.
 */
export const applyMove = (
  listing: readonly SpaceWorkspaceInfo[],
  id: string,
  move: WorkspaceMove,
): SpaceWorkspaceInfo[] => {
  const tree = indexTree(listing)
  const moved = tree.nodes.get(id)
  if (!moved || isRefusedMove(tree, id, move.parentId)) return [...listing]

  const previous = siblingNodes(tree, tree.parents.get(id) ?? null)
  previous.splice(previous.indexOf(moved), 1)
  moved.entry = withField(moved.entry, 'parentId', move.parentId ?? undefined)

  const destination = siblingNodes(tree, move.parentId)
  const beforeIndex = move.beforeId === undefined
    ? -1
    : destination.findIndex(node => node.entry.id === move.beforeId)
  destination.splice(beforeIndex === -1 ? destination.length : beforeIndex, 0, moved)
  for (const group of new Set([previous, destination])) {
    group.forEach((node, position) => {
      if (node.entry.position !== position) node.entry = { ...node.entry, position }
    })
  }

  const result: SpaceWorkspaceInfo[] = []
  const flatten = (nodes: WorkspaceTreeNode[], nearestUnpublished: string | undefined) => {
    for (const { entry, children } of nodes) {
      const published = entry.published !== undefined
      result.push(withField(entry, 'hiddenBy', published ? nearestUnpublished : undefined))
      flatten(children, published ? nearestUnpublished : entry.id)
    }
  }
  flatten(tree.roots, undefined)
  return result
}

/**
 * The listing as `HierarchicalList` items. An entry is draggable when `canMove` allows it, and
 * every entry accepts drops when any entry is draggable, since moving a workspace under another
 * needs no right on the new parent; a caller who may move nothing gets a read-only tree. An entry
 * with nothing under it has no `children`, so it is not collapsible. `decorate` adds an entry's
 * icon and metadata.
 */
export const workspaceTreeItems = (
  listing: readonly SpaceWorkspaceInfo[],
  {
    canMove,
    decorate,
  }: {
    canMove: (entry: SpaceWorkspaceInfo) => boolean
    decorate?: (entry: SpaceWorkspaceInfo) => Pick<HierarchicalListItem, 'icon' | 'metadata'>
  },
): HierarchicalListItem[] => {
  const droppable = listing.some(canMove)
  const toItem = ({ entry, children }: WorkspaceTreeNode): HierarchicalListItem => ({
    ...decorate?.(entry),
    id: entry.id,
    name: entry.title,
    ...(children.length > 0 && { children: children.map(toItem) }),
    draggable: canMove(entry),
    droppable,
  })
  return buildWorkspaceTree(listing).map(toItem)
}

/**
 * The title of the unpublished entry that keeps `entry`'s publication from taking effect (see
 * `SpaceWorkspaceInfo.hiddenBy`); undefined when nothing does, or when the listing does not hold
 * that entry.
 */
export const hiddenByTitle = (
  listing: readonly SpaceWorkspaceInfo[],
  entry: Pick<SpaceWorkspaceInfo, 'hiddenBy'>,
): string | undefined =>
  entry.hiddenBy === undefined ? undefined : listing.find(other => other.id === entry.hiddenBy)?.title
