import { describe, expect, it } from 'vitest'
import type { HierarchicalListItem } from '@gadgets/ui/hierarchical-list'
import type { AiChatAuthorInfo, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import {
  applyMove,
  buildWorkspaceTree,
  childrenOf,
  hiddenByTitle,
  isSelfOrDescendant,
  moveForDrop,
  moveToIndex,
  pathTo,
  workspaceTreeItems,
  type WorkspaceTreeNode,
} from './workspaceTree'

const ADA: AiChatAuthorInfo = { type: 'user', id: 'ada@example.com', name: 'Ada' }
const CREATED = new Date('2026-09-01T00:00:00Z')

const entry = (id: string, fields: Partial<SpaceWorkspaceInfo> = {}): SpaceWorkspaceInfo =>
  ({ id, title: id.toUpperCase(), owner: ADA, created: CREATED, ...fields })

// In pre-order, as the space lists it:
//   a
//   ├─ a1
//   │  └─ a1x
//   └─ a2
//   b
const LISTING: readonly SpaceWorkspaceInfo[] = Object.freeze([
  entry('a', { position: 0 }),
  entry('a1', { parentId: 'a', position: 0 }),
  entry('a1x', { parentId: 'a1', position: 0 }),
  entry('a2', { parentId: 'a', position: 1 }),
  entry('b', { position: 1 }),
].map(e => Object.freeze(e)))

type Shape = string | { [id: string]: Shape[] }

const nodeShape = (node: WorkspaceTreeNode): Shape =>
  node.children.length === 0 ? node.entry.id : { [node.entry.id]: node.children.map(nodeShape) }

const shape = (listing: readonly SpaceWorkspaceInfo[]) => buildWorkspaceTree(listing).map(nodeShape)

const ids = (entries: readonly SpaceWorkspaceInfo[]) => entries.map(e => e.id)

// Where `id` sits in the tree the listing describes: its parent and its index among its siblings.
const placeOf = (listing: readonly SpaceWorkspaceInfo[], id: string) => {
  const path = pathTo(listing, id)
  const parentId = path.length > 1 ? path[path.length - 2].id : null
  return { parentId, index: ids(childrenOf(listing, parentId)).indexOf(id) }
}

const item = (id: string): HierarchicalListItem => ({ id, name: id.toUpperCase() })

const nobody = () => false

// Each item, depth first, as its id with its draggable and droppable flags.
const dragFlags = (items: readonly HierarchicalListItem[]): [string, boolean?, boolean?][] =>
  items.flatMap(i => [[i.id, i.draggable, i.droppable], ...dragFlags(i.children ?? [])])

describe('buildWorkspaceTree', () => {
  it('nests the pre-order listing, keeping its order among siblings', () => {
    expect(shape(LISTING)).toEqual([{ a: [{ a1: ['a1x'] }, 'a2'] }, 'b'])
  })

  it('trusts the listing’s order over `position`', () => {
    const listing = [entry('b', { position: 5 }), entry('a', { position: 0 })]
    expect(shape(listing)).toEqual(['b', 'a'])
  })

  it('puts an entry whose parent is not listed at the top, in its place, with its subtree', () => {
    const listing = LISTING.filter(e => e.id !== 'a1')
    expect(shape(listing)).toEqual([{ a: ['a2'] }, 'a1x', 'b'])
  })

  it('reads a parent that only comes later in the listing as no parent, so no cycle forms', () => {
    const listing = [entry('x', { parentId: 'y' }), entry('y', { parentId: 'x' }), entry('z', { parentId: 'z' })]
    expect(shape(listing)).toEqual([{ x: ['y'] }, 'z'])
    expect(ids(pathTo(listing, 'y'))).toEqual(['x', 'y'])
    expect(ids(pathTo(listing, 'z'))).toEqual(['z'])
  })

  it('keeps the first copy of an entry the listing repeats', () => {
    const listing = [...LISTING, entry('a1', { title: 'Second copy' })]
    expect(shape(listing)).toEqual([{ a: [{ a1: ['a1x'] }, 'a2'] }, 'b'])
    expect(pathTo(listing, 'a1')[1]?.title).toBe('A1')
  })

  it('gives an empty forest for an empty listing', () => {
    expect(buildWorkspaceTree([])).toEqual([])
  })
})

describe('pathTo', () => {
  it('lists the entries from the top of the tree down to the entry, inclusive', () => {
    expect(ids(pathTo(LISTING, 'a1x'))).toEqual(['a', 'a1', 'a1x'])
    expect(ids(pathTo(LISTING, 'b'))).toEqual(['b'])
  })

  it('is empty for an entry the listing does not hold', () => {
    expect(pathTo(LISTING, 'missing')).toEqual([])
  })
})

describe('isSelfOrDescendant', () => {
  it('holds for the entry itself and anything beneath it, at any depth', () => {
    expect(isSelfOrDescendant(LISTING, 'a', 'a')).toBe(true)
    expect(isSelfOrDescendant(LISTING, 'a', 'a1')).toBe(true)
    expect(isSelfOrDescendant(LISTING, 'a', 'a1x')).toBe(true)
  })

  it('does not hold for ancestors, siblings or unlisted entries', () => {
    expect(isSelfOrDescendant(LISTING, 'a1', 'a')).toBe(false)
    expect(isSelfOrDescendant(LISTING, 'a1', 'a2')).toBe(false)
    expect(isSelfOrDescendant(LISTING, 'a', 'b')).toBe(false)
    expect(isSelfOrDescendant(LISTING, 'a', 'missing')).toBe(false)
  })
})

describe('childrenOf', () => {
  it('lists the entries directly under a parent, or at the top for null, in order', () => {
    expect(ids(childrenOf(LISTING, null))).toEqual(['a', 'b'])
    expect(ids(childrenOf(LISTING, 'a'))).toEqual(['a1', 'a2'])
    expect(ids(childrenOf(LISTING, 'a1x'))).toEqual([])
  })

  it('is empty for a parent the listing does not hold', () => {
    expect(childrenOf(LISTING, 'missing')).toEqual([])
  })
})

describe('moveToIndex', () => {
  it('anchors the move on the sibling the entry will precede', () => {
    expect(moveToIndex(LISTING, 'b', 'a', 0)).toEqual({ parentId: 'a', beforeId: 'a1' })
    expect(moveToIndex(LISTING, 'b', 'a', 1)).toEqual({ parentId: 'a', beforeId: 'a2' })
    expect(moveToIndex(LISTING, 'a1x', null, 1)).toEqual({ parentId: null, beforeId: 'b' })
  })

  it('omits the anchor at the end, or past it', () => {
    expect(moveToIndex(LISTING, 'b', 'a', 2)).toEqual({ parentId: 'a' })
    expect(moveToIndex(LISTING, 'b', 'a', 99)).toEqual({ parentId: 'a' })
    expect(moveToIndex(LISTING, 'b', 'a1x', 0)).toEqual({ parentId: 'a1x' })
  })

  it('counts the index with the entry taken out of its current siblings', () => {
    // a1 to after a2: with a1 out, a2 is index 0, so index 1 is the end.
    expect(moveToIndex(LISTING, 'a1', 'a', 1)).toEqual({ parentId: 'a' })
    // a2 to the front: a1 is index 0 either way.
    expect(moveToIndex(LISTING, 'a2', 'a', 0)).toEqual({ parentId: 'a', beforeId: 'a1' })
    // a to the end of the top: with a out, b is index 0.
    expect(moveToIndex(LISTING, 'a', null, 0)).toEqual({ parentId: null, beforeId: 'b' })
    expect(moveToIndex(LISTING, 'a', null, 1)).toEqual({ parentId: null })
  })

  it('treats a negative index as the front', () => {
    expect(moveToIndex(LISTING, 'b', 'a', -1)).toEqual({ parentId: 'a', beforeId: 'a1' })
  })

  it('refuses what the space would: into the entry’s own subtree, or with an unlisted entry or parent', () => {
    expect(moveToIndex(LISTING, 'a', 'a', 0)).toBeNull()
    expect(moveToIndex(LISTING, 'a', 'a1', 0)).toBeNull()
    expect(moveToIndex(LISTING, 'a', 'a1x', 0)).toBeNull()
    expect(moveToIndex(LISTING, 'a', 'missing', 0)).toBeNull()
    expect(moveToIndex(LISTING, 'missing', null, 0)).toBeNull()
  })
})

describe('moveForDrop', () => {
  it('reads the drop destination’s parent item and post-removal index', () => {
    expect(moveForDrop(LISTING, item('b'), { parent: item('a1'), index: 0 }))
      .toEqual({ parentId: 'a1', beforeId: 'a1x' })
    expect(moveForDrop(LISTING, item('a1x'), { parent: null, index: 2 })).toEqual({ parentId: null })
    expect(moveForDrop(LISTING, item('a'), { parent: item('a2'), index: 0 })).toBeNull()
  })

  // Every place the list can drop an entry, as a post-removal destination, ends up exactly there
  // once the move is applied: the list restores focus to the moved row only if it does.
  it('lands each entry exactly where every possible destination puts it, once applied', () => {
    const parents: (string | null)[] = [null, ...ids(LISTING)]
    for (const moved of ids(LISTING)) {
      for (const parentId of parents) {
        if (parentId !== null && isSelfOrDescendant(LISTING, moved, parentId)) continue
        const siblings = childrenOf(LISTING, parentId).filter(e => e.id !== moved)
        for (let index = 0; index <= siblings.length; index++) {
          const parent = parentId === null ? null : item(parentId)
          const move = moveForDrop(LISTING, item(moved), { parent, index })
          expect(move, `${moved} -> ${parentId}[${index}]`).not.toBeNull()
          const result = applyMove(LISTING, moved, move!)
          expect(placeOf(result, moved), `${moved} -> ${parentId}[${index}]`).toEqual({ parentId, index })
        }
      }
    }
  })
})

describe('applyMove', () => {
  it('moves the entry with its subtree and returns the listing in pre-order', () => {
    const result = applyMove(LISTING, 'a1', { parentId: 'b' })
    expect(shape(result)).toEqual([{ a: ['a2'] }, { b: [{ a1: ['a1x'] }] }])
    expect(ids(result)).toEqual(['a', 'a2', 'b', 'a1', 'a1x'])
    expect(result.find(e => e.id === 'a1')?.parentId).toBe('b')
  })

  it('places the entry immediately before its anchor', () => {
    const result = applyMove(LISTING, 'b', { parentId: 'a', beforeId: 'a2' })
    expect(shape(result)).toEqual([{ a: [{ a1: ['a1x'] }, 'b', 'a2'] }])
  })

  it('reorders among the entry’s own siblings', () => {
    expect(shape(applyMove(LISTING, 'a2', { parentId: 'a', beforeId: 'a1' })))
      .toEqual([{ a: ['a2', { a1: ['a1x'] }] }, 'b'])
    expect(shape(applyMove(LISTING, 'a', { parentId: null })))
      .toEqual(['b', { a: [{ a1: ['a1x'] }, 'a2'] }])
  })

  it('moves an entry to the top of the tree and drops its parentId', () => {
    const result = applyMove(LISTING, 'a1x', { parentId: null, beforeId: 'b' })
    expect(shape(result)).toEqual([{ a: ['a1', 'a2'] }, 'a1x', 'b'])
    expect(result.find(e => e.id === 'a1x')).not.toHaveProperty('parentId')
  })

  it('places the entry last when the anchor is omitted, the entry itself, or not a new sibling', () => {
    const last = [{ a: [{ a1: ['a1x'] }, 'a2', 'b'] }]
    expect(shape(applyMove(LISTING, 'b', { parentId: 'a' }))).toEqual(last)
    expect(shape(applyMove(LISTING, 'b', { parentId: 'a', beforeId: 'b' }))).toEqual(last)
    expect(shape(applyMove(LISTING, 'b', { parentId: 'a', beforeId: 'a1x' }))).toEqual(last)
    expect(shape(applyMove(LISTING, 'b', { parentId: 'a', beforeId: 'missing' }))).toEqual(last)
  })

  it('renumbers the entry’s new siblings in their order', () => {
    const result = applyMove(LISTING, 'b', { parentId: 'a', beforeId: 'a1' })
    const positions = Object.fromEntries(result.map(e => [e.id, [e.parentId ?? null, e.position]]))
    expect(positions).toEqual({
      a: [null, 0],
      b: ['a', 0],
      a1: ['a', 1],
      a2: ['a', 2],
      a1x: ['a1', 0],
    })
  })

  it('renumbers the siblings the entry left', () => {
    const result = applyMove(LISTING, 'a', { parentId: 'b' })
    const positions = Object.fromEntries(result.map(e => [e.id, [e.parentId ?? null, e.position]]))
    expect(positions).toEqual({
      b: [null, 0],
      a: ['b', 0],
      a1: ['a', 0],
      a1x: ['a1', 0],
      a2: ['a', 1],
    })
  })

  it('leaves the listing as it was for a move the space would refuse', () => {
    expect(applyMove(LISTING, 'a', { parentId: 'a1x' })).toEqual(LISTING)
    expect(applyMove(LISTING, 'a', { parentId: 'a' })).toEqual(LISTING)
    expect(applyMove(LISTING, 'a', { parentId: 'missing' })).toEqual(LISTING)
    expect(applyMove(LISTING, 'missing', { parentId: null })).toEqual(LISTING)
  })

  it('does not modify the input, and carries unchanged entries over as they are', () => {
    // LISTING and its entries are frozen, so any write to them throws.
    const result = applyMove(LISTING, 'a2', { parentId: 'a1', beforeId: 'a1x' })
    expect(shape(result)).toEqual([{ a: [{ a1: ['a2', 'a1x'] }] }, 'b'])
    expect(result.find(e => e.id === 'b')).toBe(LISTING.find(e => e.id === 'b'))
    expect(shape(LISTING)).toEqual([{ a: [{ a1: ['a1x'] }, 'a2'] }, 'b'])
  })

  it('marks published entries moved under an unpublished one as hidden by it', () => {
    const listing = [
      entry('draft'),
      entry('guide', { published: 'use' }),
      entry('chapter', { parentId: 'guide', published: 'use' }),
      entry('notes', { parentId: 'guide' }),
      entry('appendix', { parentId: 'notes', published: 'use', hiddenBy: 'notes' }),
    ]
    const result = applyMove(listing, 'guide', { parentId: 'draft' })
    const hiddenBy = Object.fromEntries(result.map(e => [e.id, e.hiddenBy]))
    expect(hiddenBy).toEqual({
      draft: undefined,
      guide: 'draft',
      chapter: 'draft',
      notes: undefined,
      // The nearest unpublished entry above it still hides it.
      appendix: 'notes',
    })
    expect(result.find(e => e.id === 'notes')).not.toHaveProperty('hiddenBy')
  })

  it('clears hiddenBy from entries moved out from under every unpublished one', () => {
    const listing = [
      entry('draft'),
      entry('guide', { parentId: 'draft', published: 'build', hiddenBy: 'draft' }),
      entry('chapter', { parentId: 'guide', published: 'use', hiddenBy: 'draft' }),
    ]
    const result = applyMove(listing, 'guide', { parentId: null })
    expect(shape(result)).toEqual(['draft', { guide: ['chapter'] }])
    for (const e of result) expect(e).not.toHaveProperty('hiddenBy')
  })
})

describe('workspaceTreeItems', () => {
  it('nests items named by title, giving children only to entries that have some', () => {
    const items = workspaceTreeItems(LISTING, { canMove: nobody })
    expect(items).toEqual([
      {
        id: 'a',
        name: 'A',
        children: [
          {
            id: 'a1',
            name: 'A1',
            children: [{ id: 'a1x', name: 'A1X', draggable: false, droppable: false }],
            draggable: false,
            droppable: false,
          },
          { id: 'a2', name: 'A2', draggable: false, droppable: false },
        ],
        draggable: false,
        droppable: false,
      },
      { id: 'b', name: 'B', draggable: false, droppable: false },
    ])
    expect(items[1]).not.toHaveProperty('children')
  })

  it('makes only the entries the caller may move draggable, and every entry a drop target', () => {
    expect(dragFlags(workspaceTreeItems(LISTING, { canMove: e => e.id === 'a2' }))).toEqual([
      ['a', false, true],
      ['a1', false, true],
      ['a1x', false, true],
      ['a2', true, true],
      ['b', false, true],
    ])
  })

  it('adds the icon and metadata `decorate` gives each entry', () => {
    const items = workspaceTreeItems(LISTING, {
      canMove: nobody,
      decorate: e => ({ metadata: `meta:${e.id}`, icon: `icon:${e.id}` }),
    })
    expect(items[0]).toMatchObject({ id: 'a', metadata: 'meta:a', icon: 'icon:a' })
    expect(items[0].children?.[1]).toMatchObject({ id: 'a2', metadata: 'meta:a2', icon: 'icon:a2' })
  })
})

describe('hiddenByTitle', () => {
  const listing = [
    entry('draft', { title: 'Draft plans' }),
    entry('guide', { parentId: 'draft', published: 'use', hiddenBy: 'draft' }),
  ]

  it('names the unpublished entry that hides a published one', () => {
    expect(hiddenByTitle(listing, listing[1])).toBe('Draft plans')
  })

  it('is undefined when nothing hides the entry, or the hiding entry is not listed', () => {
    expect(hiddenByTitle(listing, listing[0])).toBeUndefined()
    expect(hiddenByTitle([listing[1]], listing[1])).toBeUndefined()
  })
})
