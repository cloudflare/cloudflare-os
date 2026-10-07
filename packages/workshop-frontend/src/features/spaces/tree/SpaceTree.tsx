import { useLayoutEffect, useRef, useState } from 'react'
import { DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import {
  ArrowSquareOut,
  ArrowsClockwise,
  ArrowsOutCardinal,
  LinkSimple,
  Plus,
  ShareNetwork,
  SquaresFour,
} from '@phosphor-icons/react'
import {
  HierarchicalList,
  type HierarchicalListDropDestination,
  type HierarchicalListItem,
} from '@gadgets/ui/hierarchical-list'
import type { SpaceMemberRole, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { logRpcFailure, rpcFailureDescription } from '../../../rpcErrors'
import { PublishedIndicator, publicationHeldBack } from '../PublishedIndicator'
import {
  applyMove,
  moveForDrop,
  workspaceTreeItems,
  type WorkspaceMove,
} from './workspaceTree'

/** What a member of the space can start from an entry's menu, each given that entry. */
export type SpaceTreeMemberActions = {
  /** Create a workspace under the entry. */
  onNewChild: (entry: SpaceWorkspaceInfo) => void
  /** Choose a new place for the entry, the way to move it without dragging. */
  onMove: (entry: SpaceWorkspaceInfo) => void
  onChangeAddress: (entry: SpaceWorkspaceInfo) => void
}

/**
 * What the user can start from an entry's menu that their membership of the space does not decide,
 * each present only where the caller offers it for that entry.
 */
export type SpaceTreeEntryActions = {
  /** Open the entry's Share dialog. */
  onShare?: () => void
  /** Re-sync the entry from the source a sync created it from. */
  onResync?: () => void
}

/** The user as a member of the space, which is what lets them rearrange its tree. */
export type SpaceTreeMember = {
  role: SpaceMemberRole
  profileId: string
  /**
   * Move the workspace `id` in the space (`Space.moveWorkspace`), settling once the space has
   * answered. The tree shows the move from the moment it is asked for, and undoes it and says so
   * when this rejects.
   */
  onMove: (id: string, parentId: string | null, beforeId: string | undefined) => Promise<void>
  actions: SpaceTreeMemberActions
}

type SpaceTreeProps = {
  /**
   * The space's listing, as `Space.listWorkspaces` gives it. A new array is taken as a new read of
   * the listing, which drops the moves the space has confirmed since, so the caller passes the same
   * array until it reads the listing again.
   */
  listing: readonly SpaceWorkspaceInfo[]
  /** The accessible name of the tree. */
  label: string
  selectedId?: string
  onSelect: (id: string) => void
  onOpen: (entry: SpaceWorkspaceInfo) => void
  /** Null for a visitor, whose tree is read-only. */
  member: SpaceTreeMember | null
  /** The actions the caller offers on `entry` besides the member's; none when absent. */
  entryActions?: (entry: SpaceWorkspaceInfo) => SpaceTreeEntryActions
  /**
   * Puts the focus on this entry's row, once for each new object: the way a caller that moved an
   * entry itself keeps the focus on it, its row being a new one when its parent changed.
   */
  focusRequest?: { id: string }
}

// A move shown over the listing from the moment it is asked for. Once the space has confirmed it,
// it is shown until the listing is replaced, since a listing read after the move already has it.
type OptimisticMove = {
  token: number
  id: string
  move: WorkspaceMove
  confirmed: boolean
}

const UNTITLED = 'Untitled Workspace'

const branchIds = (items: readonly HierarchicalListItem[]): string[] =>
  items.flatMap(item => (item.children ? [item.id, ...branchIds(item.children)] : []))

const rowOf = (root: HTMLElement | null, id: string) =>
  [...root?.querySelectorAll<HTMLElement>('[data-hierarchical-list-row]') ?? []]
    .find(row => row.closest('[data-hierarchical-list-item]')?.getAttribute('data-item-id') === id)

/**
 * A space's listing as its tree. A member may drag an entry, or move it with Alt and the arrow
 * keys, where the space allows them to: an admin any entry, anyone else the entries of their own.
 * A row says when its workspace is published and, while an unpublished entry above it keeps that
 * from taking effect, which one. Every row has a menu, opened from its "More actions" button as
 * well as by a right-click or a long press: it opens the workspace, and offers what membership
 * lets the user do with it and what `entryActions` adds. Branches start open. Pressing an entry
 * selects it; pressing the selected one opens or closes its branch, so previewing an entry leaves
 * the tree as it was.
 */
export const SpaceTree = ({
  listing,
  label,
  selectedId,
  onSelect,
  onOpen,
  member,
  entryActions,
  focusRequest,
}: SpaceTreeProps) => {
  const toasts = useKumoToastManager()
  const [moves, setMoves] = useState<readonly OptimisticMove[]>([])
  const [movesListing, setMovesListing] = useState(listing)
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set())
  const nextToken = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  // The entry whose row takes the focus after this render: one whose refused move was undone
  // while its row had the focus, the undone move giving it a new row when it changed the parent.
  const focusAfterRender = useRef<string | null>(null)
  const handledFocusRequest = useRef<SpaceTreeProps['focusRequest']>(undefined)
  // Whether the press being reported selects a branch, which the list opens or closes on that
  // same press, right after reporting it.
  const selectingBranch = useRef(false)

  useLayoutEffect(() => {
    if (focusRequest && focusRequest !== handledFocusRequest.current) {
      handledFocusRequest.current = focusRequest
      focusAfterRender.current = focusRequest.id
    }
    const id = focusAfterRender.current
    if (id === null) return
    focusAfterRender.current = null
    rowOf(rootRef.current, id)?.focus()
  })

  if (movesListing !== listing) {
    setMovesListing(listing)
    setMoves(current => current.filter(move => !move.confirmed))
  }

  const shown = moves.reduce<SpaceWorkspaceInfo[]>(
    (current, { id, move }) => applyMove(current, id, move),
    listing.map(entry => (entry.title ? entry : { ...entry, title: UNTITLED })),
  )
  const entries = new Map(shown.map(entry => [entry.id, entry]))

  const canMove = (entry: SpaceWorkspaceInfo) =>
    member !== null && (member.role === 'admin' || entry.owner.id === member.profileId)

  const items = workspaceTreeItems(shown, {
    canMove,
    decorate: entry => ({
      icon: <SquaresFour aria-hidden="true" size={18} className="shrink-0 text-kumo-subtle" />,
      metadata: entry.published && (
        <PublishedIndicator
          access={entry.published}
          heldBack={publicationHeldBack(shown, entry)}
        />
      ),
    }),
  })
  const branches = branchIds(items)

  const settle = (token: number, confirmed: boolean) => setMoves(current => current.flatMap(move => {
    if (move.token !== token) return [move]
    return confirmed ? [{ ...move, confirmed }] : []
  }))

  const moveEntry = (item: HierarchicalListItem, destination: HierarchicalListDropDestination) => {
    if (!member) return
    const move = moveForDrop(shown, item, destination)
    if (!move) return
    const token = nextToken.current++
    setMoves(current => [...current, { token, id: item.id, move, confirmed: false }])
    // A move into a closed branch opens it, so the moved entry stays in view.
    const { parentId } = move
    if (parentId !== null && collapsedIds.has(parentId)) {
      setCollapsedIds(current => new Set([...current].filter(id => id !== parentId)))
    }
    return member.onMove(item.id, move.parentId, move.beforeId).then(
      () => settle(token, true),
      (err: unknown) => {
        const row = rowOf(rootRef.current, item.id)
        if (row && row === document.activeElement) focusAfterRender.current = item.id
        settle(token, false)
        logRpcFailure('Failed to move workspace:', err)
        toasts.add({
          title: `Couldn't move ${item.name}`,
          description: rpcFailureDescription(err),
          variant: 'error',
        })
        // Rejecting tells the list not to announce the move as made.
        throw err
      },
    )
  }

  const renderMenu = (item: HierarchicalListItem) => {
    const entry = entries.get(item.id)
    if (!entry) return null
    const { onShare, onResync } = entryActions?.(entry) ?? {}
    return (
      <>
        <DropdownMenu.Item icon={ArrowSquareOut} onClick={() => onOpen(entry)}>Open</DropdownMenu.Item>
        {member && (
          <DropdownMenu.Item icon={Plus} onClick={() => member.actions.onNewChild(entry)}>
            New child workspace
          </DropdownMenu.Item>
        )}
        {member && canMove(entry) && (
          <>
            <DropdownMenu.Item icon={ArrowsOutCardinal} onClick={() => member.actions.onMove(entry)}>
              Move…
            </DropdownMenu.Item>
            <DropdownMenu.Item icon={LinkSimple} onClick={() => member.actions.onChangeAddress(entry)}>
              Change address
            </DropdownMenu.Item>
          </>
        )}
        {onShare && <DropdownMenu.Item icon={ShareNetwork} onClick={onShare}>Share</DropdownMenu.Item>}
        {onResync && (
          <DropdownMenu.Item icon={ArrowsClockwise} onClick={onResync}>Re-sync from source</DropdownMenu.Item>
        )}
      </>
    )
  }

  if (items.length === 0) return null

  return (
    <div ref={rootRef}>
      <HierarchicalList
        items={items}
        label={label}
        selectedId={selectedId}
        expandedIds={new Set(branches.filter(id => !collapsedIds.has(id)))}
        onExpandedChange={(expanded) => {
          if (selectingBranch.current) {
            selectingBranch.current = false
            return
          }
          setCollapsedIds(new Set(branches.filter(id => !expanded.has(id))))
        }}
        dragAndDrop={member && shown.some(canMove) ? { onMove: moveEntry } : undefined}
        onItemClick={(item) => {
          if (item.id === selectedId) return
          selectingBranch.current = item.children !== undefined
          onSelect(item.id)
        }}
        renderContextMenu={renderMenu}
        showRowActions
      />
    </div>
  )
}
