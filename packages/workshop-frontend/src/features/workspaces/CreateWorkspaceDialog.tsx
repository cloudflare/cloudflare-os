import { useState } from 'react'
import { Dialog, useKumoToastManager } from '@cloudflare/kumo'
import { useNavigate } from '@tanstack/react-router'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { CloseIcon, FolderIcon } from '../../components/icons/designIcons'
import { useWorkspaces } from './WorkspacesContext'

/**
 * Names and creates a workspace, then opens it. Reached from Home's "Create a workspace" action,
 * the composer's workspace picker and the Workspaces page's "New" menu.
 */
export const CreateWorkspaceDialog = ({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { refresh } = useWorkspaces()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const name = title.trim()

  const create = async () => {
    if (!name || creating) return
    setCreating(true)
    try {
      // Disposed by hand, not with `using`: Safari can't parse it, and the dev server doesn't lower it.
      const overseer = authenticatedApi.newWorkspace({ kind: 'workspace', title: name })
      const { id } = await overseer.getMetadata().finally(() => overseer[Symbol.dispose]())
      refresh()
      onOpenChange(false)
      setTitle('')
      navigate({ to: '/workspace/$id', params: { id } })
    } catch (err) {
      if (!logRpcFailure('Failed to create workspace:', err, { reportSite: 'workspace.create' })) {
        toasts.add({ title: "Couldn't create the workspace", description: rpcFailureDescription(err), variant: 'error' })
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!creating) onOpenChange(next) }}>
      <Dialog
        className="responsive-dialog !z-[1000] !w-[min(400px,calc(100vw-32px))] overflow-hidden rounded-3xl bg-kumo-base p-0 !top-[20%] !-translate-y-0"
        size="sm"
      >
        <form onSubmit={(e) => { e.preventDefault(); void create() }} className="flex flex-col gap-4 p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-kumo-tint text-kumo-default">
              <FolderIcon size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] font-medium leading-[18px] text-kumo-default">Create a workspace</Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-4 text-kumo-subtle">
                A shared space for a team's chats, apps and files.
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={(props) => (
                <button {...props} type="button" aria-label="Close" disabled={creating}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default">
                  <CloseIcon size={16} />
                </button>
              )}
            />
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium leading-4 text-kumo-default">Name</span>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Engineering"
              maxLength={120}
              className="h-9 rounded-xl bg-kumo-elevated px-3 text-[14px] leading-[17px] text-kumo-default ring-1 ring-inset ring-kumo-line outline-none placeholder:text-kumo-subtle focus:ring-kumo-ring/60"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <button {...props} type="button" disabled={creating}
                  className="h-[34px] rounded-full bg-kumo-base px-4 text-[13px] font-medium text-kumo-default ring-1 ring-kumo-line hover:bg-kumo-elevated">
                  Cancel
                </button>
              )}
            />
            <button type="submit" disabled={!name || creating}
              className="h-[34px] rounded-full bg-kumo-contrast px-4 text-[13px] font-medium text-kumo-inverse transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40">
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
