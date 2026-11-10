import { useState } from 'react'
import { Dialog, Radio } from '@cloudflare/kumo'
import type { WorkspaceMetadata, SpaceInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { BusyButton } from './BusyButton'
import { SpaceDialogFrame } from './SpaceDialogFrame'

// The radio value standing for the user's own personal space, which `Overseer.moveToSpace` takes
// as null. No space id equals it: an id is made by the server, and is never a word.
const PERSONAL_TARGET = 'personal'

const isTeamSpace = (space: SpaceInfo) => space.kind === 'team'

/**
 * Whether there is a space to move `workspace` to besides the one it is in: a team space among
 * `spaces`, or, for a workspace in a team space, the user's personal space.
 */
export const hasMoveTarget = (
  workspace: Pick<WorkspaceMetadata, 'spaceId'>,
  spaces: SpaceInfo[],
): boolean => workspace.spaceId !== undefined || spaces.some(isTeamSpace)

/**
 * Moves one of the user's own workspaces to another of their spaces: their personal space, or a
 * team space they are a member of. The space the workspace is in now is marked and cannot be
 * chosen as the target, except to ask again for a move that failed. A workspace stays in a team
 * space its owner has left, so that space may not be among the targets: nothing is known of it
 * but its id, so it is not named. While the list of spaces has not loaded, a space missing from
 * the targets is not said to be missing from the user's spaces. Nothing is moved under a session
 * that has not said that the `spaces` flag is on.
 */
export const MoveToSpaceDialog = ({ workspace, spaces, onClose, onMoved, onMoveFailed }: {
  /** A workspace the user owns, as `listWorkspaces()` reports it. */
  workspace: Pick<WorkspaceMetadata, 'id' | 'title' | 'spaceId'>
  /**
   * The user's spaces (`useSpaces`). Only the team spaces among them are offered. Empty while the
   * list has not loaded, or could not be: once loaded it has the user's personal space at least.
   */
  spaces: SpaceInfo[]
  onClose: () => void
  /**
   * The workspace now belongs to the team space with this id, or with null to the user's
   * personal space. Closing the dialog is the caller's.
   */
  onMoved: (spaceId: string | null) => void
  /**
   * A move failed. One that failed with no answer may have changed the space the workspace is
   * recorded in all the same (see `Overseer.moveToSpace`), so the caller reads `workspace` again,
   * and resolves once it has, whether or not that read worked.
   */
  onMoveFailed: () => Promise<void>
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const current = workspace.spaceId ?? PERSONAL_TARGET
  const [target, setTarget] = useState(current)
  const [moving, setMoving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // A session that replaces another (a reconnect) reads as having the flag off until its own
  // flags arrive, and the dialog outlasts that. `Move` waits for them as it waits for its own
  // call: with the flag off the list takes the dialog away.
  const sessionReady = useUiFeatureFlag('spaces').enabled
  // After a move that failed, the space it was for may be the one the workspace is recorded in.
  // Asking for it again is then what completes the move, so it stays a target.
  const nothingToMove = target === current && failure === null

  const targets = [
    { value: PERSONAL_TARGET, name: 'Personal' },
    ...spaces.filter(isTeamSpace).map(space => ({ value: space.id, name: space.name })),
  ]
  const currentOffered = targets.some(({ value }) => value === current)
  const spacesLoaded = spaces.length > 0

  const handleMove = async () => {
    if (nothingToMove || moving || !sessionReady) return
    setMoving(true)
    setFailure(null)
    const spaceId = target === PERSONAL_TARGET ? null : target
    // Not awaited: the move is pipelined on the open, and disposing the promise disposes the
    // workspace it resolves to.
    const overseer = authenticatedApi.openWorkspace(workspace.id)
    try {
      await overseer.moveToSpace(spaceId)
      onMoved(spaceId)
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
        + 'That space’s Admin and Build members will be able to build in it, and its Use members to use it.'
      }
      busy={moving}
      onClose={onClose}
      footer={(
        <>
          {/* Above the buttons and not under the spaces, which may scroll it out of view. */}
          {failure && (
            <p role="alert" className="w-full text-[12px] leading-4 text-kumo-danger">{failure}</p>
          )}
          <Dialog.Close
            render={(props) => (
              <WorkshopButton {...props} className="!h-9" disabled={moving}>Cancel</WorkshopButton>
            )}
          />
          <BusyButton
            tone="primary"
            className="min-w-[80px]"
            busy={moving || !sessionReady}
            // A move that asks again for the current space clears the failure that made it one
            // to ask for, which is no reason to disable the button its press came from.
            disabled={nothingToMove && !moving}
            onClick={() => void handleMove()}
          >
            {moving ? 'Moving…' : 'Move'}
          </BusyButton>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        {!currentOffered && (
          <p className="text-[13px] leading-[18px] text-kumo-default">
            {spacesLoaded
              ? 'It is now in a space that is not in your list of spaces.'
              : 'It is now in a team space. Your list of spaces has not loaded, so only your personal space is offered.'}
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
      </div>
    </SpaceDialogFrame>
  )
}
