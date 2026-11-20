import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, ChatReadState, UnreadStateSubscriber, UnreadThread, UserUnreadState } from '@gadgets/workshop-shared/api'
import { keepSubscribed } from '@/rpc/keepSubscribed'
import { recentChatKey } from './recentChats'

/** The viewer's tracked chats, each with its latest message, as the account lists them, by key (`recentChatKey`). */
export type RecentChatsSnapshot = {
  threads: ReadonlyMap<string, UnreadThread>
  /** The account has said: with none listed, there are none. */
  known: boolean
}

/**
 * What the server calls with the viewer's recent chats (the `"recent"` scope, whose rows are
 * `UnreadThread`s). A class, because the server must receive a single stub for the object.
 */
class RecentListener extends RpcTarget implements UnreadStateSubscriber {
  constructor(
    private readonly onState: (state: UserUnreadState) => void,
    private readonly onChat: (workspaceId: string, chatId: number, chat: ChatReadState | null) => void,
    private readonly onReleased: () => void,
  ) {
    super()
  }

  async updated(state: UserUnreadState) {
    this.onState(state)
  }

  async summaryUpdated() {}

  async chatUpdated(workspaceId: string, chatId: number, chat: ChatReadState | null) {
    this.onChat(workspaceId, chatId, chat)
  }

  [Symbol.dispose]() {
    this.onReleased()
  }
}

/**
 * The viewer's recent chats across their workspaces, live from the account
 * (`subscribeToUnreadState("recent")`), which needs no workspace opened. What the viewer changes of
 * a chat (muted) shows at once (`markChat`), until the account says what it came to. Observable
 * through `subscribe`/`snapshot`.
 */
export class RecentChats {
  #snapshot: RecentChatsSnapshot = { threads: new Map(), known: false }
  #listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  snapshot = () => this.#snapshot

  /** Follows the account's recent chats until the function given back is called. */
  start(api: RpcStub<AuthenticatedApi>): () => void {
    return keepSubscribed((released, current) => api.subscribeToUnreadState('recent', new RecentListener(
      (state) => {
        if (!current()) return
        const threads = new Map((state.chats as UnreadThread[]).map((thread) => [recentChatKey(thread.workspaceId, thread.chatId), thread]))
        this.#publish({ threads, known: true })
      },
      (workspaceId, chatId, chat) => {
        if (!current()) return
        const threads = new Map(this.#snapshot.threads)
        // Only a thread says its latest message; a row without one says nothing to list it by.
        if (chat && 'latestActivityAt' in chat) threads.set(recentChatKey(workspaceId, chatId), chat as UnreadThread)
        else threads.delete(recentChatKey(workspaceId, chatId))
        this.#publish({ threads })
      },
      released,
    )))
  }

  /**
   * Shows a change the viewer made to a chat's read state, as the server has been asked for it,
   * until the account says otherwise. Returns how it was, to put back should the server refuse.
   */
  markChat(workspaceId: string, chatId: number, change: Partial<ChatReadState>): UnreadThread | undefined {
    const key = recentChatKey(workspaceId, chatId)
    const was = this.#snapshot.threads.get(key)
    if (!was) return undefined
    this.#publish({ threads: new Map(this.#snapshot.threads).set(key, { ...was, ...change }) })
    return was
  }

  /** Puts a chat's row back as it was (`markChat`'s answer), as after the server refused. */
  restoreChat(workspaceId: string, chatId: number, was: UnreadThread | undefined) {
    if (!was) return
    this.#publish({ threads: new Map(this.#snapshot.threads).set(recentChatKey(workspaceId, chatId), was) })
  }

  #publish(change: Partial<RecentChatsSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...change }
    for (const listener of this.#listeners) listener()
  }
}
