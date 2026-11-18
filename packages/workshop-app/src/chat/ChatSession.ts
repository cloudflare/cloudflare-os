import type { RpcStub } from 'capnweb'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import type { ActionLogEntry, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiToolCall, Overseer, CapsuleSpecifier, SlashCommandChoice, SlashCommandRequest } from '@gadgets/workshop-shared/api'
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
import { answerParts } from './answerParts'
import { acceptsAlone, proposedChanges, proposesOnlyCode, type ProposedChanges } from './autoAccept'
import { quotedBy } from './replyQuote'
import { liveToolLabel, liveToolSections, toolIcon } from './toolCalls'
import { uploadAttachments } from './uploadAttachments'
import { ActionUpdates, ChatSubscriber, type ChatEvents } from './ChatSubscriber'

/**
 * The chat's changes are waiting for the user to keep or discard them: they could not be kept on
 * their own (see autoAccept.ts), because of what they do or because others work on them too.
 */
export type KeepAsk = {
  changes: ProposedChanges
  /** Someone else is in the workspace, whose work in progress keeping them could overtake. */
  shared: boolean
}

export type ChatSnapshot =
  | { status: 'loading' }
  | {
      status: 'ready'
      /** Undefined until the chat's metadata arrives, which can be after its messages. */
      title: string | undefined
      /**
       * Its notifications are off for whoever has not taken part in it yet, as for a chat an
       * automation started (`AiChatMetadata.notificationsRequireParticipation`). False until the
       * metadata arrives.
       */
      notificationsRequireParticipation: boolean
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
       * What was sent to the running agent that it has not read yet, oldest first, whoever sent
       * it. Stopping the agent drops these, for whoever stops it to put back in their draft.
       */
      waiting: string[]
      /**
       * What the open turn produced or asks for, then what people did to its changes since. Shown
       * below everything else in the turn.
       */
      pinned: ChatFeed['pinned']
      /** The chat's changes wait to be kept or discarded; never while its agent works. */
      keep: KeepAsk | undefined
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
  /** The chat was deleted while it was open, by the viewer or by anyone else in the workspace. */
  | { status: 'deleted' }

type Calls =
  | 'listChats'
  | 'getChatHistory'
  | 'sendChatMessage'
  | 'listSlashCommands'
  | 'uploadBlob'
  | 'getChatAttachmentContent'
  | 'retryAgent'
  | 'stopAgent'
  | 'approveAction'
  | 'rejectAction'
  | 'denyConnectionRequest'
  | 'approveWebFetchRequest'
  | 'setAutoApprovedActionKind'
  | 'denyWebFetchRequest'
  | 'enableHook'
  | 'disableHook'
  | 'setChatTitle'
  | 'listCollaborators'
  | 'mergeChanges'
  | 'updateChatFromMainline'
  | 'revertChanges'

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
} & Disposable & {
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
}

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
  /**
   * The app's connection to the backend, which may be `down` while it is made again. Meanwhile
   * nothing asked of the session is sent, and `blocked()`, which says so, tells the user; and the
   * workspace is not tried again over the lost connection, as `reconnect()` follows once it is back.
   */
  connection?: { readonly down: boolean; blocked: () => boolean }
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
const DELETED: ChatSnapshot = { status: 'deleted' }
const HISTORY_PAGE_SIZE = 50
/** How many earlier pages are fetched in search of the message a reply quotes. */
const QUOTE_SEARCH_PAGES = 20
/** How many earlier pages are fetched to see everything a chat's changes would accept. */
const EPOCH_SEARCH_PAGES = 20
/** How many fetched files a session keeps, so a chat's tiles and what is opened share their bytes. */
const KEPT_ATTACHMENTS = 24
/**
 * How long after a turn ends its changes are left before the user is asked to keep them: the
 * workspace keeps a turn's changes on its own too, a moment after it ends, and a question that
 * came and went at once would only flash by.
 */
const KEEP_GRACE = 1500

// After the workspace was lost, it is connected to again at once, then after these, doubling.
const RETRY_DELAY = { first: 1000, most: 10_000 }

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
  #started = false
  // Between attempts to connect again after the workspace was lost: how long the next waits.
  #retryDelay = 0
  #retry: ReturnType<typeof setTimeout> | undefined

  // Events that arrive while the initial load is still running are held until the history is in,
  // so they are applied on top of it rather than replaced by it.
  #loaded = false
  #early: Array<() => void> = []

  #title: string | undefined
  #requiresParticipation = false
  // Set once the workspace says the chat was deleted: nothing it does after that is shown, and it
  // is not connected to again.
  #deleted = false
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
  // Files sent in the chat that were fetched, oldest first, by id.
  #attachments = new Map<string, Promise<Uint8Array>>()
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
  // The workpieces the chat proposes changes to, as last seen, and the accepts tried one after
  // another so two never race.
  #proposed = ''
  #accepting: Promise<void> = Promise.resolve()
  // What the user is asked to keep, and the wait before asking, from when the turn ended.
  #keep: KeepAsk | undefined
  #keepTimer: ReturnType<typeof setTimeout> | undefined
  #turnEndedAt = 0

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
    this.#started = true
    this.#reset()
    this.#publish(LOADING)
    void this.#load(run, false)
  }

  stop() {
    this.#run++
    this.#started = false
    this.#retryDelay = 0
    clearTimeout(this.#retry)
    this.#reset()
    this.#release()
  }

  /**
   * Connects to the workspace again, such as over a new connection to the backend, and reads the
   * conversation again. What is shown stays until the new history is in, which then takes its
   * place, so a reader keeps their place. Nothing, for a session that is not started.
   */
  reconnect() {
    if (!this.#started || this.#deleted) return
    this.#retryDelay = 0
    this.#reconnect(0)
  }

  /** Reconnects after `delay` milliseconds. */
  #reconnect(delay: number) {
    const run = ++this.#run
    clearTimeout(this.#retry)
    this.#release()
    const refreshing = this.#snapshot.status === 'ready'
    if (refreshing) {
      // Only what belongs to the connection is let go of now; the rest goes when the history is in.
      this.#loaded = false
      this.#early = []
      this.#generation = undefined
    } else {
      this.#reset()
      this.#publish(LOADING)
    }
    if (delay === 0) return void this.#load(run, refreshing)
    this.#retry = setTimeout(() => {
      if (run === this.#run) void this.#load(run, refreshing)
    }, delay)
  }

  /**
   * Run `run` lost the workspace, such as when it restarted, or a call to it failed. A
   * conversation that is shown is connected to again, again and again with growing waits, and
   * stays as it is until it has been read again; one that is not says why it could not be.
   */
  #lost(run: number, error: unknown) {
    if (run !== this.#run || this.#deleted) return
    // What is shown, or that it is loading, stays until the connection is back.
    if (this.options.connection?.down) return
    if (this.#snapshot.status !== 'ready') return this.#fail(messageOf(error))
    const delay = this.#retryDelay
    this.#retryDelay = Math.min(delay ? delay * 2 : RETRY_DELAY.first, RETRY_DELAY.most)
    this.#reconnect(delay)
  }

  #release() {
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
   * Sends a message to the chat, words or a skill or command with what it is given, with `files`
   * uploaded for it to carry and the connections in `capsules` given to the chat, and resolves to whether it
   * went, so that whoever drafted it can keep the draft when it did not. The message and the reply
   * come back through the subscription, not from here; a failure is reported in the snapshot's
   * `sendError`.
   */
  send = async (message: string | SlashCommandRequest, modelId: string, files: readonly File[] = [], capsules?: CapsuleSpecifier[]): Promise<boolean> => {
    if (this.options.connection?.blocked()) return false
    const overseer = this.#overseer
    if (!overseer || !this.#loaded) {
      // Shown but not loaded: what is shown is from before a reconnect, which is under way.
      if (this.#snapshot.status === 'ready') {
        this.#sendError = 'The conversation is reconnecting. Try again in a moment.'
        this.#publishReady()
      }
      return false
    }
    const run = this.#run
    this.#sendError = undefined
    // Only plain text steers a running agent; the server refuses anything else until it is done.
    if ((files.length || capsules?.length || typeof message !== 'string') && this.#agentActive) {
      this.#sendError = files.length ? 'Files can be sent once the agent has finished.'
        : capsules?.length ? 'Connections can be added once the agent has finished.'
          : 'Skills can be used once the agent has finished.'
      this.#publishReady()
      return false
    }
    try {
      const attachments = await uploadAttachments(overseer, files)
      await overseer.sendChatMessage(this.chatId, message, modelId, capsules, attachments)
    } catch (error) {
      if (run === this.#run) {
        this.#sendError = messageOf(error)
        this.#publishReady()
      }
      return false
    }
    if (run === this.#run) this.#publishReady()
    return true
  }

  /**
   * The skills and commands the chat's composer can send (`Overseer.listSlashCommands`): read
   * again on each call, as skills come and go elsewhere. Nothing while the chat is not connected.
   */
  listCommands = async (): Promise<SlashCommandChoice[]> => {
    const overseer = this.#overseer
    if (!overseer || !this.#loaded) return []
    return overseer.listSlashCommands()
  }

  /** Puts away the report of a failed send. */
  dismissSendError = () => {
    if (this.#sendError === undefined) return
    this.#sendError = undefined
    this.#publishReady()
  }

  /**
   * Stops the running turn, and with it the messages waiting for the agent (`waiting`). The
   * metadata saying so arrives before this resolves. Rejects when the workspace could not stop it.
   */
  stopAgent = async () => {
    const overseer = this.#overseer
    if (!overseer || !this.#loaded) return
    await overseer.stopAgent(this.chatId)
  }

  /** Runs the agent again on the conversation as it stands, e.g. after an error. */
  retry = (modelId: string) => this.#ask((overseer) => overseer.retryAgent(this.chatId, modelId))

  /**
   * Approves a pending action. Not one that creates something (`ActionLogEntry.creation`), which
   * needs the account to create it in: `useApproveCreation` asks for it.
   */
  approveAction = (actionId: number) => this.#ask((overseer) => overseer.approveAction(actionId))

  /**
   * Keeps the chat's changes, as asked (`keep`). When what has been accepted elsewhere has moved on
   * since, it is brought in first, and the changes are kept on top of it unless that left
   * conflicts, which then wait with the rest.
   */
  keepChanges = () => this.#ask(async (overseer) => {
    const { outcome } = await overseer.mergeChanges(this.chatId)
    if (outcome === 'merged') return
    const { conflictPaths } = await overseer.updateChatFromMainline(this.chatId)
    if (conflictPaths.length) throw new Error('The latest accepted changes conflict with these. Look over the files, then keep them.')
    const retried = await overseer.mergeChanges(this.chatId)
    if (retried.outcome !== 'merged') throw new Error('Someone else’s changes landed meanwhile. Try again.')
  })

  /** Throws away everything the chat proposes, as asked (`keep`). */
  discardChanges = () => this.#ask((overseer) => overseer.revertChanges(this.chatId, 0))

  rejectAction = (actionId: number) => this.#ask((overseer) => overseer.rejectAction(actionId))

  denyConnection = (requestId: string) => this.#ask((overseer) => overseer.denyConnectionRequest(requestId))

  /**
   * Approves this kind of action on its connection from now on, in the whole workspace. Those
   * waiting now are approved with it. Settings › Approvals lists it, to be switched off there.
   */
  alwaysApprove = ({ gatekeeperId, actionKind }: { gatekeeperId: number; actionKind: ActionKind }) =>
    this.#ask((overseer) => overseer.setAutoApprovedActionKind(gatekeeperId, actionKind))

  /** Approves each of the agent's requests to fetch a page, one after another. */
  approveWebFetches = (requestIds: readonly string[]) => this.#ask(async (overseer) => {
    for (const requestId of requestIds) await overseer.approveWebFetchRequest(requestId)
  })

  denyWebFetch = (requestId: string) => this.#ask((overseer) => overseer.denyWebFetchRequest(requestId))

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
    if (this.options.connection?.blocked()) return
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

  /**
   * The bytes of a file sent in the chat, fetched once and kept for a while: its message's tile
   * draws a glimpse of it, and the same bytes serve when it is opened. Fails, to be asked again,
   * while the workspace cannot be reached.
   */
  attachmentContent = (id: string): Promise<Uint8Array> => {
    const known = this.#attachments.get(id)
    if (known) return known
    const overseer = this.#overseer
    if (!overseer || this.options.connection?.down) return Promise.reject(new Error('The workspace can’t be reached right now.'))
    const loading = Promise.resolve(overseer.getChatAttachmentContent(this.chatId, id))
    this.#attachments.set(id, loading)
    if (this.#attachments.size > KEPT_ATTACHMENTS) this.#attachments.delete(this.#attachments.keys().next().value!)
    loading.catch(() => this.#attachments.delete(id))
    return loading
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
    if (this.#streaming) {
      // The views in it are named rather than drawn, until it is a message.
      const parts = answerParts(this.#streaming, { streaming: true })
      live.push({ type: 'writing', key: 'live:writing', text: this.#streaming, ...(parts.some(({ type }) => type === 'view') && { parts }) })
    }
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
    this.#requiresParticipation = false
    this.#deleted = false
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
    this.#proposed = ''
    this.#accepting = Promise.resolve()
    clearTimeout(this.#keepTimer)
    this.#keep = undefined
  }

  #publish(snapshot: ChatSnapshot) {
    this.#snapshot = snapshot
    this.#listeners.forEach((listener) => listener())
  }

  #fail(message: string) {
    if (this.#deleted) return
    this.#failure = message
    this.#publish({ status: 'failed', message })
  }

  // The same list while what waits is the same, so that what shows it is not drawn again for each
  // piece of a reply that streams in.
  #waiting: string[] = []
  #waitingTexts() {
    const texts = this.#steers.filter(({ unread }) => unread).map(({ text }) => text)
    const same = texts.length === this.#waiting.length && texts.every((text, index) => text === this.#waiting[index])
    if (!same) this.#waiting = texts
    return this.#waiting
  }

  #publishReady() {
    if (this.#deleted) return this.#publish(DELETED)
    if (this.#failure !== undefined) return this.#publish({ status: 'failed', message: this.#failure })
    const working = this.#agentActive || this.#streaming !== ''
    this.#publish({
      status: 'ready',
      title: this.#title,
      notificationsRequireParticipation: this.#requiresParticipation,
      items: this.#feed.items,
      activity: working ? this.#activity() : undefined,
      work: working ? this.#liveWork() : EMPTY_FEED.work,
      agentActive: this.#agentActive,
      waiting: this.#waitingTexts(),
      pinned: this.#feed.pinned,
      sendError: this.#sendError,
      keep: this.#agentActive ? undefined : this.#keep,
      actionError: this.#actionError,
      hasEarlier: this.#nextBeforeSequence !== undefined,
      loadingEarlier: this.#loadingEarlier,
      historyError: this.#historyError,
    })
  }

  /** Loads the chat for run `run`; `refreshing`, over what is shown, which stays until the history is in. */
  async #load(run: number, refreshing: boolean) {
    const overseer = this.open()
    this.#overseer = overseer
    try {
      // Subscribe before reading anything, so nothing that happens meanwhile is missed.
      const leases = [
        overseer.subscribeToChat(new ChatSubscriber(this.#eventsFor(run))),
        overseer.subscribeToActions(new ActionUpdates((record) => this.#live(run, () => this.#applyAction(record)))),
      ]
      this.#leases = leases
      for (const lease of leases) lease.catch((error) => this.#lost(run, error))
      // Without this, a workspace that restarted would leave the conversation silently still.
      // It can be called at once, for a workspace that cannot be reached.
      overseer.onRpcBroken((error) => this.#lost(run, error))
      if (run !== this.#run) return

      // The messages are shown as soon as they arrive; the title and agent state follow from the
      // list, as the workspace has no call for one chat's metadata.
      overseer.listChats().then(
        (chats) => this.#live(run, () => this.#applyListedChat(run, chats.find(({ id }) => id === this.chatId))),
        (error) => this.#lost(run, error),
      )
      const history = await overseer.getChatHistory(this.chatId, undefined, HISTORY_PAGE_SIZE)
      if (run !== this.#run) return

      // Read again over what was shown, the earlier pages that had been fetched stay, so that a
      // reader further up keeps their place.
      let earlier: AiChatMessage[] = []
      let nextBeforeSequence = history.nextBeforeSequence
      if (refreshing) {
        const pageStart = history.nextBeforeSequence
        earlier = pageStart === undefined ? [] : [...this.#messages.values()].filter(({ sequence }) => sequence < pageStart)
        if (earlier.length) nextBeforeSequence = this.#nextBeforeSequence
        // What this run has received so far goes on top of the history.
        const early = this.#early
        const generation = this.#generation
        this.#reset()
        this.#early = early
        this.#generation = generation
      }
      this.#messages = new Map([...earlier, ...history.messages].map((message) => [message.sequence, message]))
      this.#nextBeforeSequence = nextBeforeSequence
      this.#rebuildFeed()
      this.#loaded = true
      this.#retryDelay = 0
      for (const apply of this.#early.splice(0)) apply()
      this.#publishReady()
    } catch (error) {
      this.#lost(run, error)
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
      metadata: (chat) => live(() => this.#applyMetadata(run, chat)),
      message: (message) => live(() => this.#applyMessage(message)),
      stream: (chatId, event) => live(() => this.#applyStream(chatId, event)),
      // Not held for the history, which is beside the point once the chat is gone.
      deleted: (chatId) => {
        if (run !== this.#run || chatId !== this.chatId) return
        this.#deleted = true
        clearTimeout(this.#keepTimer)
        this.#publish(DELETED)
      },
    }
  }

  #applyListedChat(run: number, chat: AiChatMetadata | undefined) {
    if (!chat) return this.#fail('This chat doesn’t exist, or was deleted.')
    // The list may have been read before a live update that arrived first; live updates win, as
    // they do over fetched history.
    if (this.#liveMetadata) return
    this.#readMetadata(chat)
    this.#publishReady()
    this.#offerAccept(run, chat, false)
  }

  #applyMetadata(run: number, chat: AiChatMetadata) {
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
    this.#offerAccept(run, chat, turnEnded)
  }

  /**
   * Accepts the chat's changes once nobody is working on them: when its turn ends, or when what it
   * proposes changes while its agent is not running (as on opening), so the agent's code takes
   * effect as it is written. Changes that cannot be accepted without asking stay proposed (see
   * autoAccept.ts).
   */
  #offerAccept(run: number, chat: AiChatMetadata, turnEnded: boolean) {
    const proposed = (chat.proposedChangeWorkpieces ?? []).join()
    const changed = proposed !== this.#proposed
    this.#proposed = proposed
    if (turnEnded) this.#turnEndedAt = Date.now()
    // Kept, discarded, or worked on again: what was asked no longer stands.
    if (changed || chat.activeAgent) this.#askToKeep(undefined)
    if (proposed === '' || chat.activeAgent || !(turnEnded || changed)) return
    this.#accepting = this.#accepting.then(() => this.#accept(run))
  }

  /**
   * Asks the user to keep the changes, or stops asking. Asked no sooner than `KEEP_GRACE` after the
   * turn ended, and only if nothing has changed meanwhile.
   */
  #askToKeep(ask: KeepAsk | undefined) {
    clearTimeout(this.#keepTimer)
    if (!ask) {
      if (this.#keep === undefined) return
      this.#keep = undefined
      return void this.#publishReady()
    }
    const run = this.#run
    const proposed = this.#proposed
    this.#keepTimer = setTimeout(() => {
      if (run !== this.#run || proposed !== this.#proposed || this.#agentActive) return
      this.#keep = ask
      this.#publishReady()
    }, Math.max(0, this.#turnEndedAt + KEEP_GRACE - Date.now()))
  }

  async #accept(run: number) {
    const overseer = this.#overseer
    if (!overseer || run !== this.#run) return
    let chat: AiChatMetadata | undefined
    let alone: boolean
    try {
      // Read afresh, as this may run well after what prompted it.
      const [chats, collaborators] = await Promise.all([overseer.listChats(), overseer.listCollaborators()])
      chat = chats.find(({ id }) => id === this.chatId)
      if (!chat?.proposedChangeWorkpieces?.length || chat.activeAgent) return
      alone = acceptsAlone(chat, collaborators.length > 0)
    } catch {
      // What cannot be checked is left proposed, and asked about.
      alone = false
    }
    const epoch = chat?.codeBase?.epoch
    // What is asked about is what has been loaded, should the start of the epoch be out of reach.
    const complete = await this.#loadedSince(run, epoch)
    // The accept takes whatever is proposed by the time it lands, so a turn begun since would
    // have it take that turn's changes unchecked.
    if (run !== this.#run || this.#agentActive) return
    // `conflicts`: those bringing in what was kept elsewhere left, which the message recording it
    // may not have brought yet.
    const ask = (conflicts: string[] = []) => {
      const changes = proposedChanges([...this.#messages.values()], epoch)
      const brought = conflicts.length ? { ...changes, mainline: true, conflicts: [...new Set([...changes.conflicts, ...conflicts])] } : changes
      this.#askToKeep({ changes: brought, shared: !alone })
    }
    if (!alone || !complete || !proposesOnlyCode([...this.#messages.values()], epoch)) return ask()
    try {
      if ((await overseer.mergeChanges(this.chatId)).outcome === 'merged' || run !== this.#run || this.#agentActive) return
      // Another chat's changes to these gadgets were kept first. What it kept is brought in, as
      // keeping by hand does, and these are kept on top of it if that left no conflicts.
      const { conflictPaths } = await overseer.updateChatFromMainline(this.chatId)
      if (run !== this.#run || this.#agentActive) return
      if (conflictPaths.length) return ask(conflictPaths)
      // Stale again: yet another was kept meanwhile, which is left to the user.
      if ((await overseer.mergeChanges(this.chatId)).outcome === 'stale' && run === this.#run) ask()
    } catch (error) {
      if (run !== this.#run) return
      this.#actionError = `The changes couldn’t be accepted: ${messageOf(error)}`
      this.#publishReady()
    }
  }

  /** Fetches earlier pages until every message after `epoch` is in, or the search gives up. */
  async #loadedSince(run: number, epoch: number | undefined) {
    for (let pages = 0; ; pages++) {
      const before = this.#nextBeforeSequence
      if (before === undefined || (epoch !== undefined && before <= epoch + 1)) return true
      if (run !== this.#run || pages === EPOCH_SEARCH_PAGES) return false
      await (this.#earlier ?? this.loadEarlier())
      if (run !== this.#run || this.#nextBeforeSequence === before) return false
    }
  }

  #readMetadata(chat: AiChatMetadata) {
    this.#title = chat.title
    this.#requiresParticipation = chat.notificationsRequireParticipation === true
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
