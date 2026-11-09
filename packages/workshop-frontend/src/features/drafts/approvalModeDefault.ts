import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { ApprovalMode } from './ApprovalModeMenu'

const KEY = 'gadgets.chatApprovalMode'

/** The mode new chats start in: whichever this person last chose, Review first until they do. */
export const defaultApprovalMode = (): ApprovalMode => {
  try {
    return localStorage.getItem(KEY) === 'auto' ? 'auto' : 'review'
  } catch {
    return 'review'
  }
}

/** Remembers `mode` as what new chats start in. */
export const rememberApprovalMode = (mode: ApprovalMode) => {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // Without storage, new chats start in Review first, the safe default.
  }
}

/**
 * Puts a just-started chat in the remembered mode. Its first turn may already be running, but an
 * action it made in the meantime only waits until this lands, which applies it.
 */
export const startInDefaultMode = async (overseer: RpcStub<Overseer>, chatId: number) => {
  if (defaultApprovalMode() !== 'auto') return
  await overseer.setChatAutoApprove(chatId, true).catch((error: unknown) => {
    console.error("Failed to start the chat in Auto:", error)
  })
}
