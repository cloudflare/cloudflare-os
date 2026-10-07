import { useState } from 'react'
import { Dialog, Select } from '@cloudflare/kumo'
import type { SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../../components/WorkshopControls'
import { logRpcFailure, rpcFailureDescription } from '../../../rpcErrors'
import { useDialogSelectPortalContainer } from '../../../useDialogSelectPortalContainer'
import { SpaceDialogFrame } from '../SpaceDialogFrame'
import {
  buildWorkspaceTree,
  childrenOf,
  isSelfOrDescendant,
  moveToIndex,
  pathTo,
  type WorkspaceTreeNode,
} from '../tree/workspaceTree'

// The parent option standing for the top of the space's tree. No workspace id can equal it: ids
// are url-safe base64, which has no space.
const TOP = 'top of the tree'

const titleOf = (entry: SpaceWorkspaceInfo) => entry.title || 'Untitled Workspace'

type ParentOption = { value: string; label: string; depth: number }

// Every entry that could become the parent, in tree order with its depth, minus the moving entry
// and everything under it: the space refuses a move that would make a cycle.
const parentOptions = (listing: readonly SpaceWorkspaceInfo[], moving: SpaceWorkspaceInfo): ParentOption[] => {
  const options: ParentOption[] = [{ value: TOP, label: 'Top of the space', depth: 0 }]
  const walk = (nodes: WorkspaceTreeNode[], depth: number) => {
    for (const { entry, children } of nodes) {
      if (isSelfOrDescendant(listing, moving.id, entry.id)) continue
      options.push({ value: entry.id, label: titleOf(entry), depth })
      walk(children, depth + 1)
    }
  }
  walk(buildWorkspaceTree(listing), 0)
  return options
}

/**
 * Moves a workspace within its space's tree by choosing the entry it goes under and its place
 * among that entry's children: the keyboard and screen-reader path to the move a drag in the tree
 * makes. The position is chosen as 'First' or 'After' one of the new siblings, and reaches
 * `onMove` as the anchor `Space.moveWorkspace` takes: the sibling the workspace will precede,
 * omitted to place it last. Its own place is preselected, and asking for it again moves nothing.
 */
export const MoveWorkspaceDialog = ({ workspace, listing, onClose, onMove }: {
  /** The entry being moved. */
  workspace: SpaceWorkspaceInfo
  /** The space's listing, as `Space.listWorkspaces` returns it. */
  listing: readonly SpaceWorkspaceInfo[]
  onClose: () => void
  /**
   * Moves the workspace under `parentId` (null for the top of the tree), just before `beforeId`
   * or after its last new sibling when that is omitted. Resolves once the space has moved it;
   * closing the dialog is the caller's. Rejects with the space's refusal, which the dialog shows.
   */
  onMove: (parentId: string | null, beforeId?: string) => Promise<void>
}) => {
  const selectContainer = useDialogSelectPortalContainer()
  // Where the tree shows the entry now, which is where the dialog starts: under the entry above
  // it in the listing, or at the top when the listing does not hold that one.
  const currentParent = pathTo(listing, workspace.id).at(-2)?.id ?? null
  const currentIndex = childrenOf(listing, currentParent).findIndex(entry => entry.id === workspace.id)
  const [chosenParent, setChosenParent] = useState(currentParent ?? TOP)
  // The index among the new siblings, counted without the moving entry; past the end is last.
  const [position, setPosition] = useState(Math.max(0, currentIndex))
  const [moving, setMoving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const options = parentOptions(listing, workspace)
  // A parent the listing, read again while the dialog is open, no longer offers gives way to where
  // the workspace is now, or the top when that is gone too: the Select resets a value its options
  // lost to the one it started with, so this agrees with it whichever of the two acts first.
  const offered = (value: string) => options.some(option => option.value === value)
  const parentValue = offered(chosenParent) ? chosenParent : offered(currentParent ?? TOP) ? currentParent ?? TOP : TOP
  const parentId = parentValue === TOP ? null : parentValue
  const siblings = childrenOf(listing, parentId).filter(entry => entry.id !== workspace.id)
  const index = Math.min(position, siblings.length)
  const unchanged = parentId === currentParent && index === currentIndex

  const positionOptions = [
    { value: 0, label: siblings.length === 0 ? 'Only workspace here' : 'First' },
    ...siblings.map((sibling, at) => ({ value: at + 1, label: `After ${titleOf(sibling)}` })),
  ]
  const labelOfParent = (value: string) => options.find(option => option.value === value)?.label ?? ''
  const labelOfPosition = (value: string) =>
    positionOptions.find(option => String(option.value) === value)?.label ?? ''

  const handleMove = async () => {
    const move = moveToIndex(listing, workspace.id, parentId, index)
    if (unchanged || moving || !move) return
    setMoving(true)
    setFailure(null)
    try {
      await onMove(move.parentId, move.beforeId)
    } catch (err) {
      logRpcFailure('Failed to move a workspace within its space:', err)
      setFailure(rpcFailureDescription(err) ?? 'Couldn’t move the workspace. Try again.')
    } finally {
      setMoving(false)
    }
  }

  return (
    <SpaceDialogFrame
      layout="form"
      title={`Move “${titleOf(workspace)}”`}
      description="Choose where the workspace and everything under it go in this space."
      busy={moving}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Select<string>
          label="Parent"
          className="w-full text-sm"
          value={parentValue}
          disabled={moving}
          container={selectContainer}
          renderValue={labelOfParent}
          onValueChange={(value) => {
            if (value === null) return
            setChosenParent(value)
            // A new parent puts the workspace after its last child until a place is chosen.
            setPosition(Number.MAX_SAFE_INTEGER)
            setFailure(null)
          }}
        >
          {options.map(option => (
            <Select.Option key={option.value} value={option.value}>
              {/* Indented by depth, so the options read as the tree they come from. */}
              <span className="truncate" style={{ paddingInlineStart: `${option.depth * 12}px` }}>
                {option.label}
              </span>
            </Select.Option>
          ))}
        </Select>
        <Select<string>
          label="Position"
          className="w-full text-sm"
          value={String(index)}
          disabled={moving}
          container={selectContainer}
          renderValue={labelOfPosition}
          onValueChange={(value) => {
            if (value === null) return
            setPosition(Number(value))
            setFailure(null)
          }}
        >
          {positionOptions.map(option => (
            <Select.Option key={option.value} value={String(option.value)}>{option.label}</Select.Option>
          ))}
        </Select>
        {failure && <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{failure}</p>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-5 py-3">
        <Dialog.Close
          render={(props) => (
            <WorkshopButton {...props} className="!h-9" disabled={moving}>Cancel</WorkshopButton>
          )}
        />
        <WorkshopButton
          tone="primary"
          className="min-w-[80px]"
          onClick={() => void handleMove()}
          disabled={unchanged || moving}
        >
          {moving ? 'Moving…' : 'Move'}
        </WorkshopButton>
      </div>
    </SpaceDialogFrame>
  )
}
