import { useState } from 'react'
import type { RemoveWorkspaceDialogProps } from '@/blocks/RemoveWorkspaceDialog'
import type { WorkspaceRemoval } from '@/blocks/WorkspaceMoreMenu'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useRemoveWorkspace } from './WorkspacesContext'

/** The workspace asked about, as the question names it. */
type Asked = {
  id: string
  title: string
  removal: WorkspaceRemoval
  /** How many besides the viewer have access to it, once known. */
  others?: number
}

/**
 * Deleting a workspace, or removing one shared with the viewer from their list: asks first, in
 * `RemoveWorkspaceDialog`, then does it and calls `onRemoved`. The workspace stays named while the
 * dialog goes, after it has left the list.
 */
export const useWorkspaceRemoval = ({ onRemoved }: { onRemoved?: () => void } = {}) => {
  const connection = useConnectionNotice()
  const remove = useRemoveWorkspace()
  const [asked, setAsked] = useState<Asked>()
  const [open, setOpen] = useState(false)

  const ask = (workspace: Asked) => {
    if (connection?.blocked()) return
    setAsked(workspace)
    setOpen(true)
  }

  const dialog: RemoveWorkspaceDialogProps | undefined = asked && {
    open,
    onOpenChange: setOpen,
    title: asked.title,
    removal: asked.removal,
    others: asked.others,
    onConfirm: async () => {
      if (connection?.blocked()) throw new Error('Not connected. Try again once it’s back.')
      await remove(asked.id, asked.removal)
      setOpen(false)
      onRemoved?.()
    },
  }

  return { ask, dialog }
}
