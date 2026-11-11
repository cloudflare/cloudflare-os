import type { Overseer } from '@gadgets/workshop-shared/api'

/** The part of a new workspace's Overseer that starting a conversation uses. */
export type NewConversationOverseer = Pick<Overseer, 'newChat' | 'getMetadata'> & Disposable

/**
 * Starts a conversation: a new workspace holding one chat that begins with `text`, answered by
 * `modelId`. Resolves with the workspace's and the chat's ids once the chat exists. `open` creates
 * the workspace; its connection is released before returning.
 */
export const startConversation = async (
  open: () => NewConversationOverseer,
  text: string,
  modelId: string,
): Promise<{ workspaceId: string; chatId: number }> => {
  const overseer = open()
  try {
    // Both calls ride on the workspace that is still being created.
    const [chatId, metadata] = await Promise.all([overseer.newChat(text, modelId), overseer.getMetadata()])
    return { workspaceId: metadata.id, chatId }
  } finally {
    overseer[Symbol.dispose]()
  }
}
