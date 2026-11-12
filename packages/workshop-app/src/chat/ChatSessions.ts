import type { ChatSession } from './ChatSession'

// Let go of by everyone, a session is forgotten this long after: whoever takes hold of the same
// chat next, such as the same component again in development, picks it up rather than starting over.
const FORGET_AFTER = 1000

/**
 * The live chats, one session for each, shared by whoever shows the same chat: the conversation,
 * and the aside, which shows what the chat made. A session is connected while anyone holds it.
 */
export class ChatSessions {
  #sessions = new Map<string, ChatSession>()
  #holds = new Map<ChatSession, number>()

  /** `create` makes the session for a chat, which connects only once held. */
  constructor(private readonly create: (workspaceId: string, chatId: number) => ChatSession) {}

  /** The session for a chat, made if there is none. Free: it connects only once held. */
  get(workspaceId: string, chatId: number): ChatSession {
    const key = `${workspaceId}/${chatId}`
    let session = this.#sessions.get(key)
    if (!session) {
      session = this.create(workspaceId, chatId)
      this.#sessions.set(key, session)
    }
    return session
  }

  /** Keeps `session` connected until the function returned is called. The last to let go stops it. */
  hold(session: ChatSession): () => void {
    const holds = this.#holds.get(session) ?? 0
    this.#holds.set(session, holds + 1)
    if (holds === 0) session.start()
    let held = true
    return () => {
      if (!held) return
      held = false
      const left = this.#holds.get(session)! - 1
      if (left > 0) return void this.#holds.set(session, left)
      this.#holds.delete(session)
      session.stop()
      setTimeout(() => {
        if (this.#holds.has(session)) return
        for (const [key, candidate] of this.#sessions) {
          if (candidate === session) this.#sessions.delete(key)
        }
      }, FORGET_AFTER)
    }
  }
}
