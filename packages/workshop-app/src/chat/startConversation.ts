import type { CapsuleSpecifier, MessageFormatRef, Overseer } from '@gadgets/workshop-shared/api'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import { missingCommand, slashRequestFor } from './slashCommands'
import { assertAttachable, uploadAttachments } from './uploadAttachments'

/** The part of a workspace's Overseer that starting a conversation uses. */
export type NewConversationOverseer = Pick<Overseer, 'newChat' | 'getMetadata' | 'uploadBlob' | 'listSlashCommands'> & Disposable

/**
 * Starts a conversation: a chat that begins with `text` and carries `files`, answered by `modelId`,
 * in the workspace `open` creates or opens; or, with `command`, one that begins with the skill or
 * command given `text`, as that workspace offers it, which it may not. `formats` says where the
 * text names a format, for it to be drawn as one, and `capsules` the connections it carries. Resolves with the workspace's and the chat's ids once the chat exists; the
 * workspace's connection is released before returning.
 */
export const startConversation = async (
  open: () => NewConversationOverseer,
  text: string,
  files: readonly File[],
  modelId: string,
  command?: ComposerCommand,
  formats?: MessageFormatRef[],
  capsules?: CapsuleSpecifier[],
): Promise<{ workspaceId: string; chatId: number }> => {
  // Before `open`, which may create a workspace, so that none is made for a message that cannot be sent.
  assertAttachable(files)
  const overseer = open()
  try {
    // Every call rides on the workspace, which may still be being created.
    const [chatId, metadata] = await Promise.all([
      command
        ? overseer.listSlashCommands().then((choices) => {
            const request = slashRequestFor(choices, command, text)
            if (!request) throw new Error(missingCommand(command))
            return overseer.newChat(request, modelId)
          })
        : uploadAttachments(overseer, files).then((attachments) => overseer.newChat(text, modelId, capsules, attachments, formats)),
      overseer.getMetadata(),
    ])
    return { workspaceId: metadata.id, chatId }
  } finally {
    overseer[Symbol.dispose]()
  }
}
