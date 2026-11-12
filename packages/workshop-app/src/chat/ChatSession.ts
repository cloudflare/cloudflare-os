import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiToolCall, Overseer } from '@gadgets/workshop-shared/api'
import {
  EMPTY_FEED,
  toChatFeed,
  type ChatFeed,
  type ChatItem,
  type OutputFormat,
  type PendingSteer,
  type ToolEntry,
  type UserItem,
  type WorkEntry,
} from './chatItems'
import { quotedBy } from './replyQuote'
import { liveToolLabel, liveToolSections, toolIcon } from './toolCalls'
import { ActionUpdates, ChatSubscriber, type ChatEvents } from './ChatSubscriber'

export type ChatSnapshot =
  | { status: 'loading' }
  | {
      status: 'ready'
      /** Undefined until the chat's metadata arrives, which can be after its messages. */
      title: string | undefined
      /**
       * The conversation as rows, without the open turn's artefacts (`pinned`): the committed
       * messages, then the messages sent to the running agent that it has not read yet. The
       * array is unchanged while only streaming text moves.
       */
      items: ChatItem[]
      /**
       * What the assistant is doing right now, in a few words: "Thinking…", "Running code…".
       * Undefined while it is not working, and until the chat's metadata arrives.
       */
      activity: string | undefined
      /**
       * The making of the reply being worked on: the steps taken since the last message, oldest
       * first, then the step now being written (what it is thinking, the reply it is drafting,
       * the calls it is making). A reply joins the conversation only once it is written, and the
       * steps behind it are then gone. Empty while the assistant is not working.
       */
      work: WorkEntry[]
      /** An assistant turn is running. */
      agentActive: boolean
      /**
       * What the open turn produced or asks for, then what people did to its changes since. Shown
       * below everything else in the turn.
       */
      pinned: ChatFeed['pinned']
      /** Why the last send failed, until the next send. */
      sendError: string | undefined
      /** Why the last thing asked of a row (approve, deny, retry, a hook's switch) failed, until the next. */
      actionError: string | undefined
      /** Older history is fetched separately from the live tail. */
      hasEarlier: boolean
      loadingEarlier: boolean
      historyError: string | undefined
    }
  | { status: 'failed'; message: string }

type Calls =
  | 'listChats'
  | 'getChatHistory'
  | 'sendChatMessage'
  | 'retryAgent'
  | 'approveAction'
  | 'rejectAction'
  | 'denyConnectionRequest'
  | 'enableHook'
  | 'disableHook'
  | 'setChatTitle'

/**
 * The part of a workspace's Overseer a session uses, and the lease that must be disposed. The
 * subscribe calls take the subscriber object itself, as a call through a stub does: the stub for
 * it is made and released by the RPC system.
 */
export type ChatOverseer = Pick<Overseer, Calls> & {
  subscribeToChat(
    subscriber: Parameters<RpcStub<Overseer>['subscribeToChat']>[0],
    startAfter?: Date,
  ): ReturnType<Overseer['subscribeToChat']>
  subscribeToActions(
    subscriber: Parameters<RpcStub<Overseer>['subscribeToActions']>[0],
    startAfter?: Date,
  ): ReturnType<Overseer['subscribeToActions']>
} & Disposable

const sameSteer = (a: PendingSteer, b: PendingSteer) => a.text === b.text && a.from === b.from

/** How many of `waiting`, oldest first, are no longer in `queue`, which is read from its front. */
const readFrom = (waiting: PendingSteer[], queue: PendingSteer[]) => {
  let read = 0
  while (!waiting.slice(read).every((steer, index) => index < queue.length && sameSteer(steer, queue[index]))) read++
  return read
}

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
/** How many earlier pages are fetched in search of the message a reply quotes. */
const QUOTE_SEARCH_PAGES = 20

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
  #leases: Promise<Disposable>[] = []
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
  // The messages sent to the running agent that are not among `#messages` yet: first those it has
  // read whose message has not arrived, then those still waiting to be read.
  #steers: PendingSteer[] = []
  // The step being written. All of it is provisional: its durable message replaces it.
  #streaming = ''
  #reasoning = ''
  #calls: LiveCall[] = []
  #compacting = false
  // Formats seen while a createGadget call streamed. The durable call does not carry its format,
  // so this is what lets the card it becomes say what was made.
  #outputFormats = new Map<string, OutputFormat>()
  // The steps since the last message with the step being written joined on, rebuilt only when
  // either changes.
  #work: WorkEntry[] | undefined
  #generation: number | undefined
  #sendError: string | undefined
  #actionError: string | undefined
  #nextBeforeSequence: number | undefined
  #loadingEarlier = false
  // The fetch of an earlier page that is under way, for whoever needs to wait for it.
  #earlier: Promise<void> | undefined
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
    for (const lease of this.#leases.splice(0)) {
      void lease.then(
        (held) => held[Symbol.dispose](),
        () => {},
      )
    }
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

  /** Runs the agent again on the conversation as it stands, e.g. after an error. */
  retry = (modelId: string) => this.#ask((overseer) => overseer.retryAgent(this.chatId, modelId))

  /**
   * Approves a pending action.
   *
   * TODO: approving a creation (`ActionLogEntry.creation`) also needs the account to create it in.
   * The server refuses one until this app can ask; the refusal shows as `actionError`.
   */
  approveAction = (actionId: number) => this.#ask((overseer) => overseer.approveAction(actionId))

  rejectAction = (actionId: number) => this.#ask((overseer) => overseer.rejectAction(actionId))

  denyConnection = (requestId: string) => this.#ask((overseer) => overseer.denyConnectionRequest(requestId))

  setHookEnabled = (hookId: number, enabled: boolean) =>
    this.#ask((overseer) => (enabled ? overseer.enableHook(hookId) : overseer.disableHook(hookId)))

  /**
   * Gives the chat a title of its own. It is shown at once, and put back, with the promise
   * rejected, when the workspace refuses it.
   */
  rename = async (title: string) => {
    const overseer = this.#overseer
    if (!overseer || !this.#loaded) throw new Error('The chat is still loading.')
    const run = this.#run
    const before = this.#title
    this.#title = title
    this.#publishReady()
    try {
      await overseer.setChatTitle(this.chatId, title)
    } catch (error) {
      // Unless it has been renamed again since, or the chat was left.
      if (run === this.#run && this.#title === title) {
        this.#title = before
        this.#publishReady()
      }
      throw error
    }
  }

  /**
   * Asks the workspace for something a row offers. What it changes comes back through the
   * subscriptions, not from here; a failure is reported in the snapshot's `actionError`.
   */
  async #ask(call: (overseer: ChatOverseer) => Promise<unknown>) {
    const overseer = this.#overseer
    if (!overseer || !this.#loaded) return
    const run = this.#run
    this.#actionError = undefined
    try {
      await call(overseer)
    } catch (error) {
      if (run !== this.#run) return
      this.#actionError = messageOf(error)
    }
    if (run === this.#run) this.#publishReady()
  }

  /**
   * Finds the message a reply answers, and resolves to its row's key. A reply carries only a line
   * of that message (see replyQuote.ts), and the message may be further back than has been
   * loaded, so earlier history is fetched a page at a time until it turns up. The search gives up
   * at the start of the conversation, when a page cannot be fetched, and after
   * `QUOTE_SEARCH_PAGES`: a quote that far back is more likely not of a message here at all.
   */
  findQuoted = async (reply: UserItem): Promise<string | undefined> => {
    const run = this.#run
    for (let pages = 0; ; pages++) {
      const quoted = quotedBy(reply, this.#feed.items)
      if (quoted || run !== this.#run || pages === QUOTE_SEARCH_PAGES) return quoted?.key
      const before = this.#nextBeforeSequence
      // A page already on its way counts as this one.
      await (this.#earlier ?? this.loadEarlier())
      if (this.#nextBeforeSequence === before) return undefined
    }
  }

  /** Fetches one older page. Concurrent calls are ignored; failures are retryable. */
  loadEarlier = async () => {
    const overseer = this.#overseer
    const before = this.#nextBeforeSequence
    if (!overseer || !this.#loaded || this.#failure || this.#loadingEarlier || before === undefined) return
    const fetching = this.#fetchEarlier(overseer, before)
    this.#earlier = fetching
    try {
      await fetching
    } finally {
      if (this.#earlier === fetching) this.#earlier = undefined
    }
  }

  async #fetchEarlier(overseer: ChatOverseer, before: number) {
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
      steers: this.#steers,
      compactedTo: this.#compactedTo,
      outputFormats: this.#outputFormats,
    }
    this.#feed = toChatFeed(loaded, context, this.#feed)
    this.#work = undefined
  }

  #discardProvisional() {
    this.#streaming = ''
    this.#reasoning = ''
    this.#calls = []
    this.#work = undefined
  }

  #liveCall(toolCallId: string) {
    let call = this.#calls.find((candidate) => candidate.toolCallId === toolCallId)
    if (!call) {
      call = { toolCallId, written: '', output: '', finished: false }
      this.#calls.push(call)
    }
    return call
  }

  /** The steps since the last message, ending with the step being written. */
  #liveWork() {
    if (this.#work) return this.#work
    const { work } = this.#feed
    if (!this.#reasoning && !this.#streaming && this.#calls.length === 0) return (this.#work = work)
    // Thinking that led straight to a call is kept with that call, as the committed step keeps it.
    const withCall = this.#streaming === '' && this.#calls.length > 0
    const live: WorkEntry[] = []
    // It is still thinking only until it starts to write.
    if (this.#reasoning && !withCall) live.push({ type: 'thinking', key: 'live:thinking', text: this.#reasoning, running: this.#streaming === '' })
    if (this.#streaming) live.push({ type: 'writing', key: 'live:writing', text: this.#streaming })
    this.#calls.forEach((call, index) => live.push(liveEntry(call, index === 0 && withCall ? this.#reasoning || undefined : undefined)))
    return (this.#work = [...work, ...live])
  }

  #activity() {
    if (this.#compacting) return 'Compacting the conversation…'
    const call = this.#calls.at(-1)
    if (call) return liveToolLabel(call.toolName, call.target, call.noun)
    return this.#streaming === '' ? 'Thinking…' : 'Writing…'
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
    this.#steers = []
    this.#discardProvisional()
    this.#compacting = false
    this.#outputFormats = new Map()
    this.#generation = undefined
    this.#sendError = undefined
    this.#actionError = undefined
    this.#nextBeforeSequence = undefined
    this.#loadingEarlier = false
    this.#earlier = undefined
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
    const working = this.#agentActive || this.#streaming !== ''
    this.#publish({
      status: 'ready',
      title: this.#title,
      items: this.#feed.items,
      activity: working ? this.#activity() : undefined,
      work: working ? this.#liveWork() : EMPTY_FEED.work,
      agentActive: this.#agentActive,
      pinned: this.#feed.pinned,
      sendError: this.#sendError,
      actionError: this.#actionError,
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
      const leases = [
        overseer.subscribeToChat(new ChatSubscriber(this.#eventsFor(run))),
        overseer.subscribeToActions(new ActionUpdates((record) => this.#live(run, () => this.#applyAction(record)))),
      ]
      this.#leases = leases
      for (const lease of leases) {
        lease.catch((error) => {
          if (run === this.#run) this.#fail(messageOf(error))
        })
      }

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
    const queue = (chat.queuedSteers ?? []).map(({ text, author }): PendingSteer => ({
      text,
      from: author.id === viewerId ? undefined : author.name,
      unread: true,
    }))
    // A steer leaves the queue when the agent reads it, and its message follows separately. It is
    // kept in between, as read, so the row it is shown as does not go and come back. With the
    // agent stopped nothing will follow: the steers were dropped, or will prompt a turn afresh.
    const read = this.#steers.filter(({ unread }) => !unread)
    const waiting = this.#steers.filter(({ unread }) => unread)
    const justRead = waiting.slice(0, readFrom(waiting, queue)).map((steer) => ({ ...steer, unread: false }))
    this.#steers = this.#agentActive ? [...read, ...justRead, ...queue] : queue
    // Whether an error can be retried, and where the context was cut, come from the metadata.
    this.#rebuildFeed()
  }

  #applyMessage(message: AiChatMessage) {
    if (message.chatId !== this.chatId) return
    // Replayed and live delivery can overlap, so a sequence number is stored once.
    this.#messages.set(message.sequence, message)
    // A steer's message has arrived: it is no longer pending, whichever of the two came first.
    if (message.type === 'message' && message.author.type !== 'agent') {
      const arrived = this.#steers.findIndex(({ text }) => text === message.message)
      if (arrived !== -1) this.#steers = this.#steers.toSpliced(arrived, 1)
    }
    this.#rebuildFeed()
    // A finished step replaces what streamed of it; updates to an agent's approval/tool cards do not.
    if (message.type === 'message' && message.author.type === 'agent' &&
      (this.#nextBeforeSequence === undefined || message.sequence >= this.#nextBeforeSequence)) this.#discardProvisional()
    this.#publishReady()
  }

  /** Refreshes the copy of an action's record that its chat message carries. */
  #applyAction(record: ActionLogEntry) {
    let changed = false
    for (const [sequence, message] of this.#messages) {
      if (message.type !== 'action' || message.actionId !== record.id) continue
      this.#messages.set(sequence, { ...message, actionLog: record })
      changed = true
    }
    if (!changed) return
    this.#rebuildFeed()
    this.#publishReady()
  }

  #applyStream(chatId: number, event: AiChatStreamEvent) {
    if (chatId !== this.chatId) return
    switch (event.type) {
      case 'textDelta':
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
    this.#work = undefined
    this.#publishReady()
  }
}
