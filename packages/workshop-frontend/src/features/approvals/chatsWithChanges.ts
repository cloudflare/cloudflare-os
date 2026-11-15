import type { AiChatMetadata } from '@gadgets/workshop-shared/api'

/**
 * A chat with changes waiting to be accepted, as the Activity page lists it under the branch
 * approval model, where a chat's requests are accepted with its code (see Overseer.mergeChanges()).
 */
export type ChatWithChanges = {
  id: number
  title: string
  /** How many of its requests are pending (AiChatMetadata.pendingActions). */
  requests: number
  /** Whether it proposes code changes (AiChatMetadata.proposedChangeWorkpieces). */
  codeChanges: boolean
  /** Whether holding is on (AiChatMetadata.holding). */
  holding: boolean
  /** Whether its agent is stopped on a decision (AiChatMetadata.awaitingDecision). */
  awaitingDecision: boolean
}

/** The chats among `chats` with requests or code changes waiting to be accepted, in order. */
export const chatsWithChanges = (chats: readonly AiChatMetadata[]): ChatWithChanges[] =>
  chats.flatMap(chat => {
    const requests = chat.pendingActions ?? 0
    const codeChanges = (chat.proposedChangeWorkpieces?.length ?? 0) > 0
    if (requests === 0 && !codeChanges) return []
    return [{
      id: chat.id,
      title: chat.title,
      requests,
      codeChanges,
      holding: chat.holding === true,
      awaitingDecision: chat.awaitingDecision === true,
    }]
  })
