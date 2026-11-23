/** How long to wait for a chat named by a token the Workshop doesn't know yet. */
export const CHAT_TOKEN_WAIT_MS = 5_000

/**
 * The workspace's chats by `AiChatMetadata.chatToken`, for showing a chat a gadget names
 * (`GadgetHost.openAgentChat`).
 *
 * A gadget may spawn an agent and name its chat at once. The chat's metadata reaches the Workshop
 * over the chat subscription, not with the gadget's reply, so it can arrive after the gadget's
 * request does, and a lookup waits briefly for it.
 */
export class ChatTokenIndex {
  #chatIds: ReadonlyMap<string, number> = new Map()
  readonly #waiters = new Set<() => void>()

  update(chatIdsByToken: ReadonlyMap<string, number>): void {
    this.#chatIds = chatIdsByToken
    // A check that finds its chat removes itself, which a Set's iteration allows.
    for (const check of this.#waiters) check()
  }

  /**
   * Resolves to the ID of the chat `token` names, or to undefined if `signal` aborts first.
   * Rejects if no chat has the token within `timeoutMs`.
   */
  find(token: string, signal: AbortSignal, timeoutMs = CHAT_TOKEN_WAIT_MS)
      : Promise<number | undefined> {
    if (signal.aborted) return Promise.resolve(undefined)
    const known = this.#chatIds.get(token)
    if (known !== undefined) return Promise.resolve(known)

    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        this.#waiters.delete(check)
        signal.removeEventListener('abort', onAbort)
      }
      const check = () => {
        const chatId = this.#chatIds.get(token)
        if (chatId === undefined) return
        finish()
        resolve(chatId)
      }
      const onAbort = () => {
        finish()
        resolve(undefined)
      }
      const timer = setTimeout(() => {
        finish()
        reject(new Error('No such chat.'))
      }, timeoutMs)
      this.#waiters.add(check)
      signal.addEventListener('abort', onAbort)
    })
  }
}
