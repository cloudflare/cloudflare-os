import { useState, type ReactNode } from 'react'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import type { LibraryMoreActions } from '@/blocks/LibraryMoreMenu'
import { DeleteGadgetDialog } from '@/blocks/DeleteGadgetDialog'
import { useGadgetChanges } from '@/gadgets/useGadgetChanges'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { ShareWorkspaceDialog } from '@/workspaces/ShareWorkspaceDialog'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { mayChange, NO_EDITS, withDeletion, withoutRename, withRename, type LibraryEdits } from './libraryEdits'
import { outputKey, outputTitle } from './libraryList'

export type LibraryActionsOptions = {
  /** The outputs as they were read, which a rename is made over. */
  read: readonly OutputSummary[]
  /** An output's own page, which sharing it lets people in to. Without it, nothing is shared. */
  outputHref?: (output: OutputSummary) => string
  /** Goes to an output's settings. */
  onOpenSettings?: (output: OutputSummary) => void
  /** An output was deleted, for whatever else is kept of it to go with it, as its star. */
  onDeleted?: (output: OutputSummary) => void
}

export type LibraryActions = {
  /** What was renamed and deleted, to show at once over what was read (`withEdits`). */
  edits: LibraryEdits
  /** What the viewer may do to an output from its more menu; nothing for whoever may do nothing. */
  actionsOf: (output: OutputSummary) => LibraryMoreActions | undefined
  /** Why the last rename was not made. */
  problem: string | undefined
  /** The dialogs that deleting and sharing ask in, to be put on the page. */
  dialogs: ReactNode
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * What can be done to the outputs a list shows from their more menus, wherever the list is (the
 * Library page, a workspace's Library tab, a chat's): rename one, which shows at once and is put
 * back if it is refused; share it from its own page; go to its settings; and delete it, which asks
 * first and leaves the list once it is gone. Only for whoever builds in its workspace
 * (`mayChange`); the server checks again.
 */
export const useLibraryActions = ({ read, outputHref, onOpenSettings, onDeleted }: LibraryActionsOptions): LibraryActions => {
  const changes = useGadgetChanges()
  const connection = useConnectionNotice()
  const workspaces = useWorkspaces()
  const [edits, setEdits] = useState(NO_EDITS)
  const [problem, setProblem] = useState<string>()
  // The one being asked about or shared, kept as the dialog closes so that it does not change as it goes.
  const [deleting, setDeleting] = useState<{ output: OutputSummary; open: boolean }>()
  const [sharing, setSharing] = useState<{ output: OutputSummary; open: boolean }>()

  const rename = (output: OutputSummary, title: string) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    // As read, which the rename is made over, rather than as it shows after an earlier one.
    const was = read.find((candidate) => outputKey(candidate) === outputKey(output)) ?? output
    setEdits((current) => withRename(current, was, title))
    changes.rename(output, title).catch((error: unknown) => {
      setEdits((current) => withoutRename(current, was))
      setProblem(`Couldn’t rename “${outputTitle(was)}”: ${messageOf(error)}`)
    })
  }
  const confirmDelete = async () => {
    if (!deleting || connection?.blocked()) return
    const { output } = deleting
    await changes.remove(output)
    setEdits((current) => withDeletion(current, output))
    onDeleted?.(output)
    setDeleting({ ...deleting, open: false })
  }
  const actionsOf = (output: OutputSummary) => {
    const listed = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === output.workspaceId) : undefined
    if (!mayChange(output, listed)) return undefined
    return {
      onRename: (title: string) => rename(output, title),
      // Shared from its own page, which is what its link lets anyone in to.
      onShare: outputHref && (() => setSharing({ output, open: true })),
      onOpenSettings: onOpenSettings && (() => onOpenSettings(output)),
      onDelete: () => setDeleting({ output, open: true }),
    }
  }

  const dialogs = (
    <>
      {deleting && (
        <DeleteGadgetDialog
          key={outputKey(deleting.output)}
          open={deleting.open}
          onOpenChange={(open) => setDeleting((current) => current && { ...current, open })}
          title={outputTitle(deleting.output)}
          workspace={deleting.output.workspaceTitle || undefined}
          onConfirm={confirmDelete}
        />
      )}
      {sharing && outputHref && (
        <ShareWorkspaceDialog
          key={outputKey(sharing.output)}
          workspaceId={sharing.output.workspaceId}
          title={sharing.output.workspaceTitle || 'Workspace'}
          page={new URL(outputHref(sharing.output), window.location.href).href}
          gadget={{ id: sharing.output.workpieceId, title: outputTitle(sharing.output) }}
          open={sharing.open}
          onOpenChange={(open) => setSharing((current) => current && { ...current, open })}
        />
      )}
    </>
  )

  return { edits, actionsOf, problem, dialogs }
}
