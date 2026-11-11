import type { RpcStub } from 'capnweb'
import type { AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiToolCall, Overseer } from '@gadgets/workshop-shared/api'
import {
  continueTools,
  EMPTY_FEED,
  toChatFeed,
  type ArtefactItem,
  type ChatFeed,
  type ChatItem,
  type OutputFormat,
  type ToolEntry,
  type ToolsItem,
} from './chatItems'
import { liveToolLabel, liveToolSections, toolIcon } from './toolCalls'
import { ChatSubscriber, type ChatEvents } from './ChatSubscriber'

export type ChatSnapshot =
  | { status: 'loading' }
  | {
      status: 'ready'
      /** Undefined until the chat's metadata arrives, which can be after its messages. */
      title: string | undefined
      /**
       * The committed messages as rows, without the open turn's tail (`openTools`, `pinned`). The
       * array is unchanged while only streaming text moves.
       */
      items: ChatItem[]
      /**
       * The run of tool calls the open turn ends with, continued by the calls now being written
       * when the agent has said nothing since.
       */
      openTools: ToolsItem | undefined
      /** What the agent is thinking in the step being written, until that leads to a tool call. */
      streamingReasoning: string
      /** The assistant's reply so far, while it is still being written; empty otherwise. */
      streamingText: string
      /** The calls being written after `streamingText`, which start a run of their own. */
      streamingTools: ToolsItem | undefined
      /** Older context is being summarized before the turn can go on. */
      compacting: boolean
      /** An assistant turn is running and nothing of it shows yet. False until the metadata arrives. */
      thinking: boolean
      /** An assistant turn is running. */
      agentActive: boolean
      /** What the open turn produced or asks for, shown below everything else in it. */
      pinned: ArtefactItem[]
      /** Messages sent while the agent works that it has not read yet, oldest first. */
      queuedSteers: QueuedSteer[]
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

/** A message waiting for the running agent to read it. */
export type QueuedSteer = { text: string; from?: string }

export type ChatSessionOptions = {
  /** The signed-in user's id, so their own actions read as theirs. */
  viewerId?: string
  /** Called when an assistant turn ends, e.g. to refresh lists that show the workspace. */
  onTurnEnded?: () => void
}

/** A tool call as far as it has streamed. Nothing of it is durable until its message arrives. */
type LiveCall = {
  toolCallId: string
  toolName?: AiToolCall['toolName']
  /** The file it names, once that part of its input has streamed. */
  target?: string
  /** What a `createGadget` is making, e.g. "Document". */
  noun?: string
  /** What it is writing: code to run, or a file's new content. */
  written: string
  /** The text an edit replaces. */
  replaced?: string
  output: string
  /** Its input is complete; `executeCode` never reports this. */
  finished: boolean
}

const liveEntry = (call: LiveCall, reasoning: string | undefined): ToolEntry => ({
  type: 'call',
  key: call.toolCallId,
  icon: call.toolName ? toolIcon(call.toolName) : 'terminal',
  label: liveToolLabel(call.toolName, call.target, call.noun),
  reasoning,
  sections: liveToolSections(call),
  running: !call.finished,
})

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
  #feed: ChatFeed = EMPTY_FEED
  #compactedTo: number | undefined
  #queuedSteers: QueuedSteer[] = []
  // The step being written. All of it is provisional: its durable message replaces it.
  #streaming = ''
  #reasoning = ''
  #calls: LiveCall[] = []
  #compacting = false
  // Formats seen while a createGadget call streamed. The durable call does not carry its format,
  // so this is what lets the card it becomes say what was made.
  #outputFormats = new Map<string, OutputFormat>()
  // The feed's trailing tools with the live calls joined on, rebuilt only when either changes.
  #tail: { openTools: ToolsItem | undefined; streamingTools: ToolsItem | undefined } | undefined
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
      this.#rebuildFeed()
    } catch (error) {
      if (run !== this.#run) return
      this.#historyError = messageOf(error)
    }
    if (run !== this.#run) return
    this.#loadingEarlier = false
    this.#publishReady()
  }

  #rebuildFeed() {
    // An update to an older, unloaded card must not expose a disconnected fragment of history.
    // Retain its newer value until paging reaches it, then prefer it over the fetched snapshot.
    const loaded = [...this.#messages.values()]
      .filter((message) => this.#nextBeforeSequence === undefined || message.sequence >= this.#nextBeforeSequence)
      .toSorted((a, b) => a.sequence - b.sequence)
    const context = {
      viewerId: this.options.viewerId,
      agentActive: this.#agentActive,
      compactedTo: this.#compactedTo,
      outputFormats: this.#outputFormats,
    }
    this.#feed = toChatFeed(loaded, context, this.#feed)
    this.#tail = undefined
  }

  #discardProvisional() {
    this.#streaming = ''
    this.#reasoning = ''
    this.#calls = []
    this.#tail = undefined
  }

  #liveCall(toolCallId: string) {
    let call = this.#calls.find((candidate) => candidate.toolCallId === toolCallId)
    if (!call) {
      call = { toolCallId, written: '', output: '', finished: false }
      this.#calls.push(call)
    }
    return call
  }

  /**
   * Where the calls being written show. With nothing said since the last committed call they
   * continue that run, as they will once committed; after streamed text they start their own.
   */
  #liveTail() {
    if (this.#tail) return this.#tail
    const { openTools } = this.#feed
    if (this.#calls.length === 0) return (this.#tail = { openTools, streamingTools: undefined })
    const afterText = this.#streaming !== ''
    // Thinking that led straight to a call is kept with that call, as the committed step keeps it.
    const steps = this.#calls.map((call, index) => liveEntry(call, index === 0 && !afterText ? this.#reasoning || undefined : undefined))
    return (this.#tail = afterText
      ? { openTools, streamingTools: continueTools(undefined, steps) }
      : { openTools: continueTools(openTools, steps), streamingTools: undefined })
  }

  #reset() {
    this.#loaded = false
    this.#early = []
    this.#title = undefined
    this.#agentActive = false
    this.#liveMetadata = false
    this.#messages = new Map()
    this.#feed = EMPTY_FEED
    this.#compactedTo = undefined
    this.#queuedSteers = []
    this.#discardProvisional()
    this.#compacting = false
    this.#outputFormats = new Map()
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
      items: this.#feed.items,
      ...this.#liveTail(),
      // Shown on its own until it leads to a call; then it is that call's.
      streamingReasoning: this.#calls.length === 0 || this.#streaming !== '' ? this.#reasoning : '',
      streamingText: this.#streaming,
      compacting: this.#compacting,
      thinking: this.#agentActive && !this.#streaming && !this.#reasoning && this.#calls.length === 0 && !this.#compacting,
      agentActive: this.#agentActive,
      pinned: this.#feed.pinned,
      queuedSteers: this.#queuedSteers,
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
      this.#nextBeforeSequence = history.nextBeforeSequence
      this.#rebuildFeed()
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
        if (restarted) {
          this.#discardProvisional()
          this.#compacting = false
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
    this.#readMetadata(chat)
    this.#publishReady()
  }

  #applyMetadata(chat: AiChatMetadata) {
    // The subscription covers the whole workspace, so events for its other chats are dropped.
    if (chat.id !== this.chatId) return
    this.#liveMetadata = true
    const wasActive = this.#agentActive
    this.#readMetadata(chat)
    const turnEnded = wasActive && !this.#agentActive
    // Whatever was still streaming is not going to become a message.
    if (turnEnded) {
      this.#discardProvisional()
      this.#compacting = false
    }
    this.#publishReady()
    if (turnEnded) this.options.onTurnEnded?.()
  }

  #readMetadata(chat: AiChatMetadata) {
    this.#title = chat.title
    this.#agentActive = chat.activeAgent !== undefined
    this.#compactedTo = chat.compactedTo
    const { viewerId } = this.options
    this.#queuedSteers = (chat.queuedSteers ?? []).map(({ text, author }) => ({
      text,
      from: author.id === viewerId ? undefined : author.name,
    }))
    // Whether an error can be retried, and where the context was cut, come from the metadata.
    this.#rebuildFeed()
  }

  #applyMessage(message: AiChatMessage) {
    if (message.chatId !== this.chatId) return
    // Replayed and live delivery can overlap, so a sequence number is stored once.
    this.#messages.set(message.sequence, message)
    this.#rebuildFeed()
    // A finished step replaces what streamed of it; updates to an agent's approval/tool cards do not.
    if (message.type === 'message' && message.author.type === 'agent' &&
      (this.#nextBeforeSequence === undefined || message.sequence >= this.#nextBeforeSequence)) this.#discardProvisional()
    this.#publishReady()
  }

  #applyStream(chatId: number, event: AiChatStreamEvent) {
    if (chatId !== this.chatId) return
    switch (event.type) {
      case 'textDelta':
        // Calls written before any text continue the committed run; from here they follow the text.
        if (this.#streaming === '') this.#tail = undefined
        this.#streaming += event.delta
        break
      case 'reasoningDelta':
        this.#reasoning += event.delta
        break
      case 'toolCallStarted':
        this.#liveCall(event.toolCallId).toolName = event.toolName
        break
      case 'toolCallTarget':
        this.#liveCall(event.toolCallId).target = event.file.filename
        break
      case 'toolCallOutputFormat': {
        const { noun, icon } = event.output
        this.#liveCall(event.toolCallId).noun = noun
        this.#outputFormats.set(event.toolCallId, { noun, icon })
        break
      }
      case 'toolCodeDelta':
        this.#liveCall(event.toolCallId).written += event.delta
        break
      // A file's new content streams as a preview of the edit rather than as the call's code.
      case 'editPreviewStart': {
        const call = this.#liveCall(event.toolCallId)
        call.target = event.file.filename
        call.replaced = event.textToReplace
        break
      }
      case 'editPreviewDelta':
        this.#liveCall(event.toolCallId).written += event.delta
        break
      case 'toolOutputDelta':
        this.#liveCall(event.toolCallId).output += event.delta
        break
      case 'toolCallFinished':
        this.#liveCall(event.toolCallId).finished = true
        break
      case 'compacting':
        this.#compacting = true
        break
      case 'compacted':
        this.#compacting = false
        break
      // The request failed and will be tried again, so nothing it streamed will become durable.
      case 'streamReset':
        this.#discardProvisional()
        break
      // The rest drive the code view, which this app does not have.
      default:
        return
    }
    if (event.type !== 'textDelta' && event.type !== 'compacting' && event.type !== 'compacted') this.#tail = undefined
    this.#publishReady()
  }
}
