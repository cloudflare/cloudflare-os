import type { AiChatMetadata } from '@gadgets/workshop-shared/api'

/** The part of a workspace's Overseer this needs, and the lease that must be disposed. */
type ChatLister = { listChats(): Promise<AiChatMetadata[]> } & Disposable

/** The chat in a workspace that was active last, if it has any. `open` connects to the workspace. */
export const latestChat = async (open: () => ChatLister): Promise<AiChatMetadata | undefined> => {
  const overseer = open()
  try {
    const chats = await overseer.listChats()
    return chats.reduce<AiChatMetadata | undefined>((latest, chat) => (!latest || chat.lastActive > latest.lastActive ? chat : latest), undefined)
  } finally {
    overseer[Symbol.dispose]()
  }
}
