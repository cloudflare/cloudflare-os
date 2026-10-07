import { useState } from 'react'
import { Dialog } from '@cloudflare/kumo'
import type { SpaceSyncJobInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../../AuthContext'
import { WorkshopButton } from '../../../components/WorkshopControls'
import { logRpcFailure, rpcFailureDescription } from '../../../rpcErrors'
import { SpaceDialogFrame } from '../SpaceDialogFrame'

/**
 * Asks the owner of a synced workspace to confirm a re-sync from its source, which replaces the
 * workspace's content and every one of its comments, the ones written here since included, and
 * then starts it (`AuthenticatedApi.resyncWorkspace`). The job is handed back as the server
 * recorded it, which may already have failed.
 */
export const ResyncWorkspaceDialog = ({ workspace, sourceName, syncRunning, onClose, onStarted }: {
  workspace: { id: string; title: string }
  /** What the workspace's source is called, such as its vendor's display name. */
  sourceName: string
  /** A sync of the user's into the workspace's space is running, so the server would refuse. */
  syncRunning: boolean
  onClose: () => void
  /** The re-sync was started; closing the dialog and following the job are the caller's. */
  onStarted: (job: SpaceSyncJobInfo) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const title = workspace.title || 'Untitled Workspace'

  const handleResync = async () => {
    if (starting || syncRunning) return
    setStarting(true)
    setFailure(null)
    try {
      onStarted(await authenticatedApi.resyncWorkspace(workspace.id))
    } catch (err) {
      logRpcFailure('Failed to re-sync a workspace:', err)
      setFailure(rpcFailureDescription(err) ?? 'Couldn’t start the re-sync. Try again.')
    } finally {
      setStarting(false)
    }
  }

  return (
    <SpaceDialogFrame
      layout="form"
      title={`Re-sync “${title}” from ${sourceName}?`}
      // The description is what is read out as the dialog opens, so it carries what is lost.
      description={`The workspace’s content and all of its comments will be replaced from ${sourceName}, including every edit and comment made here since it was synced. This can’t be undone.`}
      busy={starting}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3 px-5 py-4 text-[13px] leading-5 text-kumo-default">
        <p className="text-kumo-subtle">It keeps its place in the space and how it is published.</p>
        {syncRunning && (
          <p role="note" className="text-[12px] leading-4 text-kumo-subtle">
            A sync into this space is already running. Wait for it to finish, or cancel it, first.
          </p>
        )}
        {failure && <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{failure}</p>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-5 py-3">
        <Dialog.Close
          render={(props) => (
            <WorkshopButton {...props} className="!h-9" disabled={starting}>Cancel</WorkshopButton>
          )}
        />
        <WorkshopButton
          tone="danger"
          className="!h-9 min-w-[80px]"
          disabled={starting || syncRunning}
          onClick={() => void handleResync()}
        >
          {starting ? 'Starting…' : 'Replace from source'}
        </WorkshopButton>
      </div>
    </SpaceDialogFrame>
  )
}
