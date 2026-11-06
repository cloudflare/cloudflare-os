import type { Overseer } from '@gadgets/workshop-shared/api'

/** The part of a new workspace's Overseer that starting a conversation uses. */
export type NewConversationOverseer = Pick<Overseer, 'newChat' | 'getMetadata'> & Disposable

/**
 * Starts a conversation: a new workspace holding one chat that begins with `text`, answered by
 * `modelId`. Resolves with the workspace's id once the chat exists. `open` creates the workspace;
 * its connection is released before returning.
 */
export const startConversation = async (
  open: () => NewConversationOverseer,
  text: string,
  modelId: string,
): Promise<string> => {
  const overseer = open()
  try {
    // Both calls ride on the workspace that is still being created.
    const [, metadata] = await Promise.all([overseer.newChat(text, modelId), overseer.getMetadata()])
    return metadata.id
  } finally {
    overseer[Symbol.dispose]()
  }
}
