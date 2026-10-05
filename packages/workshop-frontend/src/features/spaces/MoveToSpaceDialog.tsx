import { useState } from 'react'
import { Dialog, Radio } from '@cloudflare/kumo'
import {
  PERSONAL_SPACE_PREFIX,
  type GadgetMetadata,
  type SpaceInfo,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { SpaceDialogFrame } from './SpaceDialogFrame'

// The radio value standing for the user's own personal space, which `Overseer.moveToSpace` takes
// as null. No team key can equal it: a team key cannot start with the prefix.
const PERSONAL_TARGET = PERSONAL_SPACE_PREFIX

const isTeamSpace = (space: SpaceInfo) => space.kind === 'team'

/**
 * Whether there is a space to move `workspace` to besides the one it is in: a team space among
 * `spaces`, or, for a workspace in a team space, the user's personal space.
 */
export const hasMoveTarget = (
  workspace: Pick<GadgetMetadata, 'spaceKey'>,
  spaces: SpaceInfo[],
): boolean => workspace.spaceKey !== undefined || spaces.some(isTeamSpace)

/**
 * Moves one of the user's own workspaces to another of their spaces: their personal space, or a
 * team space they are a member of. The space the workspace is in now is marked and cannot be
 * chosen as the target, except to ask again for a move that failed. A workspace stays in a team
 * space its owner has left, so that space may not be among the targets: it is then named by its
 * key, the only thing known of it. While the list of spaces has not loaded, a space missing from
 * the targets is not said to be missing from the user's spaces.
 */
export const MoveToSpaceDialog = ({ workspace, spaces, onClose, onMoved, onMoveFailed }: {
  /** A workspace the user owns, as `listGadgets()` reports it. */
  workspace: Pick<GadgetMetadata, 'id' | 'title' | 'spaceKey'>
  /**
   * The user's spaces (`useSpaces`). Only the team spaces among them are offered. Empty while the
   * list has not loaded, or could not be: once loaded it has the user's personal space at least.
   */
  spaces: SpaceInfo[]
  onClose: () => void
  /**
   * The workspace now belongs to the space with this team key, or with null to the user's
   * personal space. Closing the dialog is the caller's.
   */
  onMoved: (spaceKey: string | null) => void
  /**
   * A move failed. One that failed with no answer may have changed the space the workspace is
   * recorded in all the same (see `Overseer.moveToSpace`), so the caller reads `workspace` again,
   * and resolves once it has, whether or not that read worked.
   */
  onMoveFailed: () => Promise<void>
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const current = workspace.spaceKey ?? PERSONAL_TARGET
  const [target, setTarget] = useState(current)
  const [moving, setMoving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // After a move that failed, the space it was for may be the one the workspace is recorded in.
  // Asking for it again is then what completes the move, so it stays a target.
  const nothingToMove = target === current && failure === null

  const targets = [
    { value: PERSONAL_TARGET, name: 'Personal' },
    ...spaces.filter(isTeamSpace).map(space => ({ value: space.key, name: space.name })),
  ]
  const currentOffered = targets.some(({ value }) => value === current)
  const spacesLoaded = spaces.length > 0

  const handleMove = async () => {
    if (nothingToMove || moving) return
    setMoving(true)
    setFailure(null)
    const spaceKey = target === PERSONAL_TARGET ? null : target
    // Not awaited: the move is pipelined on the open, and disposing the promise disposes the
    // workspace it resolves to.
    const overseer = authenticatedApi.openGadget(workspace.id)
    try {
      await overseer.moveToSpace(spaceKey)
      onMoved(spaceKey)
    } catch (err) {
      logRpcFailure('Failed to move workspace to a space:', err)
      await onMoveFailed()
      setFailure(rpcFailureDescription(err) ?? 'Couldn’t move the workspace. Try again.')
    } finally {
      overseer[Symbol.dispose]()
      setMoving(false)
    }
  }

  return (
    <SpaceDialogFrame
      layout="form"
      title="Move to space"
      description={
        `Choose the space “${workspace.title}” belongs to. `
        + 'A space’s members see the title, owner and creation date of each workspace in it.'
      }
      busy={moving}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        {!currentOffered && (
          <p className="text-[13px] leading-[18px] text-kumo-default">
            {spacesLoaded
              ? `It is now in the space “${current}”, which is not in your list of spaces.`
              : `It is now in the space “${current}”. Your list of spaces has not loaded, so only your personal space is offered.`}
          </p>
        )}
        <Radio.Group
          value={target}
          onValueChange={(value) => { setTarget(value); setFailure(null) }}
          disabled={moving}
        >
          <Radio.Legend className="sr-only">Space</Radio.Legend>
          {targets.map(({ value, name }) => (
            <Radio.Item
              key={value}
              value={value}
              label={value === current ? `${name} (current)` : name}
            />
          ))}
        </Radio.Group>
        {failure && (
          <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{failure}</p>
        )}
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
          disabled={nothingToMove || moving}
        >
          {moving ? 'Moving…' : 'Move'}
        </WorkshopButton>
      </div>
    </SpaceDialogFrame>
  )
}
