import type { RpcStub } from 'capnweb'
import { isAgentRun, type AiChatMetadata, type Overseer } from '@gadgets/workshop-shared/api'
import { ChatSubscriber } from '@/chat/ChatSubscriber'

export type WorkspaceChatsState =
  | { status: 'loading' }
  | { status: 'ready'; chats: AiChatMetadata[] }
  | { status: 'failed'; message: string }

/** The part of a workspace's Overseer the chats use, and the lease that must be disposed. */
export type ChatsOverseer = Pick<Overseer, 'listChats'> & {
  subscribeToChat(subscriber: Parameters<RpcStub<Overseer>['subscribeToChat']>[0]): Promise<Disposable>
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
} & Disposable

const LOADING: WorkspaceChatsState = { status: 'loading' }
// After the workspace was lost, how long until it is opened again.
const RETRY_DELAY = 1000
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The chats people have in one workspace, live, most recently active first: read once
 * (`listChats({ kind: 'chats' })`) and kept up from the chat stream (`subscribeToChat()`,
 * subscribed to before the read), so that a new chat shows and a title or cost changes as it does,
 * and one deleted goes. Agents' runs, which are their agents', never come in (`isAgentRun`).
 * Observable through `subscribe`/`getSnapshot`; nothing happens until `start()`, and `stop()`
 * lets the workspace go. When the workspace restarts, it is opened and read again, with what is
 * shown left up meanwhile.
 */
export class WorkspaceChats {
  #snapshot: WorkspaceChatsState = LOADING
  #listeners = new Set<() => void>()
  #overseer: ChatsOverseer | undefined
  #lease: Promise<Disposable> | undefined
  // Bumped by every start and stop, so what a run asked for can tell it is stale.
  #run = 0
  // Cancels the reopening a broken workspace is waiting for.
  #cancelRetry: (() => void) | undefined
  // The chats, by id, once read; and the updates that arrived before, applied over them.
  #chats: Map<number, AiChatMetadata> | undefined
  #early = new Map<number, AiChatMetadata | null>()

  constructor(private readonly open: () => ChatsOverseer) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    this.#chats = undefined
    this.#early = new Map()
    let overseer: ChatsOverseer
    try {
      overseer = this.#overseer = this.open()
    } catch (error) {
      this.#publish({ status: 'failed', message: messageOf(error) })
      return
    }
    const live = (apply: () => void) => {
      if (run === this.#run) apply()
    }
    this.#lease = overseer.subscribeToChat(new ChatSubscriber({
      streamGeneration: () => {},
      stream: () => {},
      message: () => {},
      metadata: (chat) => live(() => this.#updated(chat)),
      deleted: (chatId) => live(() => this.#deleted(chatId)),
    }))
    this.#lease.catch((error: unknown) => live(() => this.#publish({ status: 'failed', message: messageOf(error) })))
    overseer.listChats({ kind: 'chats' }).then(
      (chats) => live(() => {
        this.#chats = new Map(chats.map((chat) => [chat.id, chat]))
        for (const [id, chat] of this.#early) {
          if (chat) this.#chats.set(id, chat)
          else this.#chats.delete(id)
        }
        this.#early.clear()
        this.#publishReady()
      }),
      (error: unknown) => live(() => this.#publish({ status: 'failed', message: messageOf(error) })),
    )

    // Last, as it can be called at once, for a workspace that cannot be reached.
    overseer.onRpcBroken(() => {
      if (run !== this.#run) return
      this.#cancelRetry?.()
      const retry = setTimeout(() => {
        if (run !== this.#run) return
        this.stop()
        this.start()
      }, RETRY_DELAY)
      this.#cancelRetry = () => clearTimeout(retry)
    })
  }

  stop() {
    this.#run++
    this.#cancelRetry?.()
    this.#cancelRetry = undefined
    void this.#lease?.then((lease) => lease[Symbol.dispose](), () => {})
    this.#overseer?.[Symbol.dispose]()
    this.#lease = this.#overseer = undefined
  }

  #updated(chat: AiChatMetadata) {
    if (isAgentRun(chat)) return
    if (!this.#chats) {
      this.#early.set(chat.id, chat)
      return
    }
    this.#chats.set(chat.id, chat)
    this.#publishReady()
  }

  #deleted(chatId: number) {
    if (!this.#chats) {
      this.#early.set(chatId, null)
      return
    }
    if (this.#chats.delete(chatId)) this.#publishReady()
  }

  #publishReady() {
    if (!this.#chats) return
    this.#publish({ status: 'ready', chats: [...this.#chats.values()].toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime()) })
  }

  #publish(snapshot: WorkspaceChatsState) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}
