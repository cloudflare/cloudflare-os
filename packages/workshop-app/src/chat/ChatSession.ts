import type { RpcStub } from 'capnweb'
import type { AiChatMessage, AiChatMetadata, AiChatStreamEvent, Overseer } from '@gadgets/workshop-shared/api'
import { toChatItems, type ChatItem } from './chatItems'
import { ChatSubscriber, type ChatEvents } from './ChatSubscriber'

export type ChatSnapshot =
  | { status: 'loading' }
  | {
      status: 'ready'
      /** The chat's title; undefined when the workspace has no chat yet. */
      title: string | undefined
      /** The committed messages, as items. The array is unchanged while only streaming text moves. */
      items: ChatItem[]
      /** The assistant's reply so far, while it is still being written; empty otherwise. */
      streamingText: string
      /** An assistant turn is running and has not started writing text. */
      thinking: boolean
      /** Why the last send failed, until the next send. */
      sendError: string | undefined
    }
  | { status: 'failed'; message: string }

/**
 * The part of a workspace's Overseer a session uses, and the lease that must be disposed.
 * `subscribeToChat` takes the subscriber object itself, as a call through a stub does: the stub
 * for it is made and released by the RPC system.
 */
export type ChatOverseer = Pick<Overseer, 'listChats' | 'getChatHistory' | 'sendChatMessage' | 'newChat'> & {
  subscribeToChat(
    subscriber: Parameters<RpcStub<Overseer>['subscribeToChat']>[0],
    startAfter?: Date,
  ): ReturnType<Overseer['subscribeToChat']>
} & Disposable

export type ChatSessionOptions = {
  /** Called when an assistant turn ends, e.g. to refresh lists that show the workspace. */
  onTurnEnded?: () => void
}

const LOADING: ChatSnapshot = { status: 'loading' }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * One workspace's conversation, live. A workspace is treated as holding one chat: the most
 * recently active one. Observable through `subscribe`/`getSnapshot` (for `useSyncExternalStore`).
 *
 * Nothing happens until `start()`, and `stop()` releases the workspace connection, so the pair is
 * safe to run twice in a row (React does that in development) and a session abandoned before
 * starting holds nothing.
 */
export class ChatSession {
  #snapshot: ChatSnapshot = LOADING
  #listeners = new Set<() => void>()
  #overseer: ChatOverseer | undefined
  #lease: Promise<Disposable> | undefined
  // Bumped by every start() and stop(), so work from an earlier run can tell it is stale.
  #run = 0

  // Events that arrive while the initial load is still running are held until it knows which chat
  // is shown: the subscription covers the whole workspace, so an early event may be for another one.
  #loaded = false
  #early: Array<() => void> = []

  #chatId: number | undefined
  #title: string | undefined
  #agentActive = false
  #messages = new Map<number, AiChatMessage>()
  #items: ChatItem[] = []
  #streaming = ''
  #generation: number | undefined
  #sendError: string | undefined
  // Set when the subscription fails, for the rest of the run: a conversation that is no longer
  // live must not go back to looking ready because the initial load finished.
  #failure: string | undefined

  /** `open` connects to the workspace; the session disposes what it returns. */
  constructor(
    private readonly open: () => ChatOverseer,
    private readonly options: ChatSessionOptions = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    this.#reset()
    this.#publish(LOADING)
    void this.#load(run)
  }

  stop() {
    this.#run++
    this.#reset()
    void this.#lease?.then(
      (lease) => lease[Symbol.dispose](),
      () => {},
    )
    this.#lease = undefined
    this.#overseer?.[Symbol.dispose]()
    this.#overseer = undefined
  }

  /**
   * Sends a message to the conversation, starting its chat if the workspace has none yet. The
   * message and the reply come back through the subscription, not from here; a failure is reported
   * in the snapshot's `sendError`.
   */
  send = async (text: string, modelId: string) => {
    const overseer = this.#overseer
    if (!overseer || !this.#loaded) return
    const run = this.#run
    this.#sendError = undefined
    try {
      if (this.#chatId === undefined) {
        const chatId = await overseer.newChat(text, modelId)
        // Events for the new chat usually arrive first and have already adopted it.
        if (run === this.#run) this.#chatId ??= chatId
      } else {
        await overseer.sendChatMessage(this.#chatId, text, modelId)
      }
    } catch (error) {
      if (run !== this.#run) return
      this.#sendError = messageOf(error)
    }
    if (run === this.#run) this.#publishReady()
  }

  #reset() {
    this.#loaded = false
    this.#early = []
    this.#chatId = undefined
    this.#title = undefined
    this.#agentActive = false
    this.#messages = new Map()
    this.#items = []
    this.#streaming = ''
    this.#generation = undefined
    this.#sendError = undefined
    this.#failure = undefined
  }

  #publish(snapshot: ChatSnapshot) {
    this.#snapshot = snapshot
    this.#listeners.forEach((listener) => listener())
  }

  #fail(message: string) {
    this.#failure = message
    this.#publish({ status: 'failed', message })
  }

  #publishReady() {
    if (this.#failure !== undefined) return this.#publish({ status: 'failed', message: this.#failure })
    this.#publish({
      status: 'ready',
      title: this.#title,
      items: this.#items,
      streamingText: this.#streaming,
      thinking: this.#agentActive && this.#streaming === '',
      sendError: this.#sendError,
    })
  }

  async #load(run: number) {
    const overseer = this.open()
    this.#overseer = overseer
    try {
      // Subscribe before reading anything, so nothing that happens meanwhile is missed.
      const lease = overseer.subscribeToChat(new ChatSubscriber(this.#eventsFor(run)))
      this.#lease = lease
      lease.catch((error) => {
        if (run === this.#run) this.#fail(messageOf(error))
      })

      const chats = await overseer.listChats()
      const latest = chats.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())[0]
      const history = latest ? await overseer.getChatHistory(latest.id) : undefined
      if (run !== this.#run) return

      const messages = history?.messages ?? []
      this.#chatId = latest?.id
      this.#title = latest?.title
      this.#agentActive = latest?.activeAgent !== undefined
      this.#messages = new Map(messages.map((message) => [message.sequence, message]))
      this.#items = toChatItems(messages)
      this.#loaded = true
      for (const apply of this.#early.splice(0)) apply()
      this.#publishReady()
    } catch (error) {
      if (run === this.#run) this.#fail(messageOf(error))
    }
  }

  #eventsFor(run: number): ChatEvents {
    const live = (apply: () => void) => {
      if (run !== this.#run) return
      if (this.#loaded) apply()
      else this.#early.push(apply)
    }
    return {
      streamGeneration: (generation) => {
        if (run !== this.#run) return
        // A different value means the server restarted, so whatever was streaming is gone and will
        // be streamed again from the start.
        const restarted = this.#generation !== undefined && this.#generation !== generation
        this.#generation = generation
        if (restarted && this.#streaming !== '') {
          this.#streaming = ''
          if (this.#loaded) this.#publishReady()
        }
      },
      metadata: (chat) => live(() => this.#applyMetadata(chat)),
      message: (message) => live(() => this.#applyMessage(message)),
      stream: (chatId, event) => live(() => this.#applyStream(chatId, event)),
      deleted: () => {},
    }
  }

  // The first chat to report in adopts the session when the workspace had none.
  #accepts(chatId: number) {
    this.#chatId ??= chatId
    return chatId === this.#chatId
  }

  #applyMetadata(chat: AiChatMetadata) {
    if (!this.#accepts(chat.id)) return
    const wasActive = this.#agentActive
    this.#title = chat.title
    this.#agentActive = chat.activeAgent !== undefined
    const turnEnded = wasActive && !this.#agentActive
    // Whatever was still streaming is not going to become a message.
    if (turnEnded) this.#streaming = ''
    this.#publishReady()
    if (turnEnded) this.options.onTurnEnded?.()
  }

  #applyMessage(message: AiChatMessage) {
    if (!this.#accepts(message.chatId)) return
    // Replayed and live delivery can overlap, so a sequence number is stored once.
    this.#messages.set(message.sequence, message)
    this.#items = toChatItems([...this.#messages.values()].toSorted((a, b) => a.sequence - b.sequence))
    // The finished message replaces what was streaming.
    if (message.author.type === 'agent') this.#streaming = ''
    this.#publishReady()
  }

  #applyStream(chatId: number, event: AiChatStreamEvent) {
    if (chatId !== this.#chatId) return
    if (event.type === 'textDelta') this.#streaming += event.delta
    else if (event.type === 'streamReset') this.#streaming = ''
    else return
    this.#publishReady()
  }
}
