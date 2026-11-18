import { useApi } from '@/rpc/ApiContext'
import { deleteGadget, renameGadget } from './gadgetChanges'

/**
 * Renames and deletes a gadget, for everyone with access to its workspace, through the connection
 * there is at the time. Each rejects with why it could not be done.
 */
export const useGadgetChanges = () => {
  const { api } = useApi()
  const open = (workspaceId: string) => () => api.openWorkspace(workspaceId)
  return {
    rename: (gadget: { workspaceId: string; workpieceId: number }, title: string) => renameGadget(open(gadget.workspaceId), gadget.workpieceId, title),
    remove: (gadget: { workspaceId: string; workpieceId: number }) => deleteGadget(open(gadget.workspaceId), gadget.workpieceId),
  }
}
