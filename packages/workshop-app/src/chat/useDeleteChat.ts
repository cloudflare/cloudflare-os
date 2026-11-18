import { useApi } from '@/rpc/ApiContext'

/**
 * Deletes one of the workspace's chats, for everyone in it (`Overseer.deleteChat()`). Rejects with
 * why it could not be. A conversation open on it hears of it from the workspace, as it does when
 * anyone else deletes it.
 */
export const useDeleteChat = (workspaceId: string) => {
  const { api } = useApi()
  return async (chatId: number) => {
    const overseer = api.openWorkspace(workspaceId)
    try {
      await overseer.deleteChat(chatId)
    } finally {
      overseer[Symbol.dispose]()
    }
  }
}
