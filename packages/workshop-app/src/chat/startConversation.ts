import type { Overseer } from '@gadgets/workshop-shared/api'
import { assertAttachable, uploadAttachments } from './uploadAttachments'

/** The part of a workspace's Overseer that starting a conversation uses. */
export type NewConversationOverseer = Pick<Overseer, 'newChat' | 'getMetadata' | 'uploadBlob'> & Disposable

/**
 * Starts a conversation: a chat that begins with `text` and carries `files`, answered by `modelId`,
 * in the workspace `open` creates or opens. Resolves with the workspace's and the chat's ids once
 * the chat exists; the workspace's connection is released before returning.
 */
export const startConversation = async (
  open: () => NewConversationOverseer,
  text: string,
  files: readonly File[],
  modelId: string,
): Promise<{ workspaceId: string; chatId: number }> => {
  // Before `open`, which may create a workspace, so that none is made for a message that cannot be sent.
  assertAttachable(files)
  const overseer = open()
  try {
    // Every call rides on the workspace, which may still be being created.
    const [chatId, metadata] = await Promise.all([
      uploadAttachments(overseer, files).then((attachments) => overseer.newChat(text, modelId, undefined, attachments)),
      overseer.getMetadata(),
    ])
    return { workspaceId: metadata.id, chatId }
  } finally {
    overseer[Symbol.dispose]()
  }
}
