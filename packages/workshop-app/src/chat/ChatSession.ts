import type { RpcStub } from 'capnweb'
import type { AiChatMessage, AiChatMetadata, AiChatStreamEvent, Overseer } from '@gadgets/workshop-shared/api'
import { toChatItems, type ChatItem } from './chatItems'
import { ChatSubscriber, type ChatEvents } from './ChatSubscriber'

export type ChatSnapshot =
  | { status: 'loading' }
  | {
      status: 'ready'
      /** Undefined until the chat's metadata arrives, which can be after its messages. */
      title: string | undefined
      /** The committed messages, as items. The array is unchanged while only streaming text moves. */
      items: ChatItem[]
      /** The assistant's reply so far, while it is still being written; empty otherwise. */
      streamingText: string
      /** An assistant turn is running and has not started writing text. False until the metadata arrives. */
      thinking: boolean
      /** Why the last send failed, until the next send. */
      sendError: string | undefined
      /** Older history is fetched separately from the live tail. */
      hasEarlier: boolean
      loadingEarlier: boolean
      historyError: string | undefined
    }
  | { status: 'failed'; message: string }

/**
 * The part of a workspace's Overseer a session uses, and the lease that must be disposed.
 * `subscribeToChat` takes the subscriber object itself, as a call through a stub does: the stub
 * for it is made and released by the RPC system.
 */
export type ChatOverseer = Pick<Overseer, 'listChats' | 'getChatHistory' | 'sendChatMessage'> & {
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
const HISTORY_PAGE_SIZE = 50

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * One chat in a workspace, live. Observable through `subscribe`/`getSnapshot` (for
 * `useSyncExternalStore`).
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

  // Events that arrive while the initial load is still running are held until the history is in,
  // so they are applied on top of it rather than replaced by it.
  #loaded = false
  #early: Array<() => void> = []

  #title: string | undefined
  #agentActive = false
  // Set once a live metadata update was applied, so the listed metadata cannot overwrite it.
  #liveMetadata = false
  #messages = new Map<number, AiChatMessage>()
  #items: ChatItem[] = []
  #streaming = ''
  #generation: number | undefined
  #sendError: string | undefined
  #nextBeforeSequence: number | undefined
  #loadingEarlier = false
  #historyError: string | undefined
  // Set when the subscription fails, for the rest of the run: a conversation that is no longer
  // live must not go back to looking ready because the initial load finished.
  #failure: string | undefined

  /** `open` connects to the chat's workspace; the session disposes what it returns. */
  constructor(
    private readonly open: () => ChatOverseer,
    private readonly chatId: number,
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
   * Sends a message to the chat. The message and the reply come back through the subscription, not
   * from here; a failure is reported in the snapshot's `sendError`.
   */
  send = async (text: string, modelId: string) => {
    const overseer = this.#overseer
    if (!overseer || !this.#loaded) return
    const run = this.#run
    this.#sendError = undefined
    try {
      await overseer.sendChatMessage(this.chatId, text, modelId)
    } catch (error) {
      if (run !== this.#run) return
      this.#sendError = messageOf(error)
    }
    if (run === this.#run) this.#publishReady()
  }

  /** Fetches one older page. Concurrent calls are ignored; failures are retryable. */
  loadEarlier = async () => {
    const overseer = this.#overseer
    const before = this.#nextBeforeSequence
    if (!overseer || !this.#loaded || this.#failure || this.#loadingEarlier || before === undefined) return
    const run = this.#run
    this.#loadingEarlier = true
    this.#historyError = undefined
    this.#publishReady()
    try {
      const page = await overseer.getChatHistory(this.chatId, before, HISTORY_PAGE_SIZE)
      if (run !== this.#run) return
      // Live updates (e.g. an approval resolved during the read) take precedence over the page.
      for (const message of page.messages) {
        if (!this.#messages.has(message.sequence)) this.#messages.set(message.sequence, message)
      }
      this.#nextBeforeSequence = page.nextBeforeSequence
      this.#rebuildItems()
    } catch (error) {
      if (run !== this.#run) return
      this.#historyError = messageOf(error)
    }
    if (run !== this.#run) return
    this.#loadingEarlier = false
    this.#publishReady()
  }

  #rebuildItems() {
    // An update to an older, unloaded card must not expose a disconnected fragment of history.
    // Retain its newer value until paging reaches it, then prefer it over the fetched snapshot.
    this.#items = toChatItems([...this.#messages.values()]
      .filter((message) => this.#nextBeforeSequence === undefined || message.sequence >= this.#nextBeforeSequence)
      .toSorted((a, b) => a.sequence - b.sequence))
  }

  #reset() {
    this.#loaded = false
    this.#early = []
    this.#title = undefined
    this.#agentActive = false
    this.#liveMetadata = false
    this.#messages = new Map()
    this.#items = []
    this.#streaming = ''
    this.#generation = undefined
    this.#sendError = undefined
    this.#nextBeforeSequence = undefined
    this.#loadingEarlier = false
    this.#historyError = undefined
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
      hasEarlier: this.#nextBeforeSequence !== undefined,
      loadingEarlier: this.#loadingEarlier,
      historyError: this.#historyError,
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

      // The messages are shown as soon as they arrive; the title and agent state follow from the
      // list, as the workspace has no call for one chat's metadata.
      overseer.listChats().then(
        (chats) => this.#live(run, () => this.#applyListedChat(chats.find(({ id }) => id === this.chatId))),
        (error) => {
          if (run === this.#run) this.#fail(messageOf(error))
        },
      )
      const history = await overseer.getChatHistory(this.chatId, undefined, HISTORY_PAGE_SIZE)
      if (run !== this.#run) return

      this.#messages = new Map(history.messages.map((message) => [message.sequence, message]))
      this.#items = toChatItems(history.messages)
      this.#nextBeforeSequence = history.nextBeforeSequence
      this.#loaded = true
      for (const apply of this.#early.splice(0)) apply()
      this.#publishReady()
    } catch (error) {
      if (run === this.#run) this.#fail(messageOf(error))
    }
  }

  /** Applies an update from run `run`, holding it until the history is in. */
  #live(run: number, apply: () => void) {
    if (run !== this.#run) return
    if (this.#loaded) apply()
    else this.#early.push(apply)
  }

  #eventsFor(run: number): ChatEvents {
    const live = (apply: () => void) => this.#live(run, apply)
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

  #applyListedChat(chat: AiChatMetadata | undefined) {
    if (!chat) return this.#fail('This chat doesn’t exist, or was deleted.')
    // The list may have been read before a live update that arrived first; live updates win, as
    // they do over fetched history.
    if (this.#liveMetadata) return
    this.#title = chat.title
    this.#agentActive = chat.activeAgent !== undefined
    this.#publishReady()
  }

  #applyMetadata(chat: AiChatMetadata) {
    // The subscription covers the whole workspace, so events for its other chats are dropped.
    if (chat.id !== this.chatId) return
    this.#liveMetadata = true
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
    if (message.chatId !== this.chatId) return
    // Replayed and live delivery can overlap, so a sequence number is stored once.
    this.#messages.set(message.sequence, message)
    this.#rebuildItems()
    // A finished reply replaces the stream; updates to an agent's approval/tool cards do not.
    if (message.type === 'message' && message.author.type === 'agent' &&
      (this.#nextBeforeSequence === undefined || message.sequence >= this.#nextBeforeSequence)) this.#streaming = ''
    this.#publishReady()
  }

  #applyStream(chatId: number, event: AiChatStreamEvent) {
    if (chatId !== this.chatId) return
    if (event.type === 'textDelta') this.#streaming += event.delta
    else if (event.type === 'streamReset') this.#streaming = ''
    else return
    this.#publishReady()
  }
}
