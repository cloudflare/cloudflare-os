import type { RpcStub } from 'capnweb'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import type { ActionLogEntry, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiToolCall, ChatCodeBase, Overseer, CapsuleSpecifier, ChatArtifact, ChatConnectionUse, SlashCommandChoice, SlashCommandRequest } from '@gadgets/workshop-shared/api'
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
import { agentKeyOf } from '@/automations/agents'
import { answerParts } from './answerParts'
import { ChatCode, NotSent } from './code/ChatCode'
import type { StreamRow } from './code/changeStream'
import { epochCode } from './code/epochCode'
import { proposedChanges, type ProposedChanges } from './proposedChanges'
import { COMPACTING, THINKING, toolStatus, WRITING } from './statusWords'
import { liveToolLabel, liveToolSections, toolIcon } from './toolCalls'
import { uploadAttachments } from './uploadAttachments'
import { ActionUpdates, ChatSubscriber, type ChatEvents } from './ChatSubscriber'
import { NO_USAGE, sameUsage, usageOf, type ChatUsage } from './chatUsage'

/**
 * The chat's changes are waiting for the user to keep or discard them, as nothing is kept until
 * someone does: until then they are only beside this chat, and nobody else sees them.
 */
export type KeepAsk = {
  changes: ProposedChanges
  /** Edits made beside the chat are still on their way into it, which keeping now would leave out. */
  sending: boolean
  /** Where the chat's changes were last kept (`ChatCodeBase.epoch`), which tells one ask from the next. */
  epoch: number | undefined
}

/** What a chat has, as its workspace lists it (`Overseer.listChatArtifacts()`), every page of it. */
export type ChatArtifacts = {
  /** The gadgets and worktrees it made that the workspace still has, and the files sent in it, oldest first. */
  artifacts: ChatArtifact[]
  /** The connections it used. */
  connections: ChatConnectionUse[]
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
       * The agent whose run it is, where it names one (`AiChatMetadata.spawnerId`): its key on
       * the workspace's Agents tab, and its name as the run was started under. Undefined until the
       * metadata arrives, and for a chat someone started.
       */
      agent: { key: string; name: string } | undefined
      /**
       * The conversation as rows, without the open turn's artefacts (`pinned`): the committed
       * messages, then the messages sent to the running agent that it has not read yet. The
       * array is unchanged while only streaming text moves.
       */
      items: ChatItem[]
      /**
       * What the assistant is doing right now, in a few words and no jargon: "Floating ideas", "Running code" (`statusWords.ts`).
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
      /** What the chat has used so far: unchanged until it is, so that it can be compared. Empty until its metadata arrives. */
      usage: ChatUsage
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
      /**
       * What the chat has, all of it, however little of the conversation is loaded. Undefined
       * until it is first read, or where it could not be.
       */
      artifacts: ChatArtifacts | undefined
    }
  | { status: 'failed'; message: string }
  /** The chat was deleted while it was open, by the viewer or by anyone else in the workspace. */
  | { status: 'deleted' }

type Calls =
  | 'getChatMetadata'
  | 'listChatArtifacts'
  | 'listActions'
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
  | 'mergeChanges'
  | 'updateChatFromMainline'
  | 'revertChanges'
  | 'submitCodeChange'
  | 'markChatRead'
  | 'markChatUnread'
  | 'viewChat'

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

const sameSteer = (a: PendingSteer, b: PendingSteer) => a.text === b.text && a.from === b.from && a.replyTo === b.replyTo

/** How many of `waiting`, oldest first, are no longer in `queue`, which is read from its front. */
const readFrom = (waiting: PendingSteer[], queue: PendingSteer[]) => {
  let read = 0
  while (!waiting.slice(read).every((steer, index) => index < queue.length && sameSteer(steer, queue[index]))) read++
  return read
}

export type ChatSessionOptions = {
  /** The signed-in user's id, so their own actions read as theirs. */
  viewerId?: string
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
/** The most messages the workspace sends at once (`Overseer.getChatHistory`'s `limit`). */
const MAX_HISTORY_PAGE_SIZE = 200
/** How many rows of a chat's change stream are kept for its code, should it be shown. */
const MAX_KEPT_ROWS = 500
/** How long the code waits to read back again where a page could not be had, at first and at most. */
const CODE_RETRY = { first: 2000, most: 60_000 }
/** How many fetched files a session keeps, so a chat's tiles and what is opened share their bytes. */
const KEPT_ATTACHMENTS = 24
/**
 * How long after a turn ends its changes are left before the user is asked to keep them: what the
 * turn last changed can be recorded a moment after it ends, and another turn can start at once on
 * what was sent meanwhile, which a question asked at once would only flash by before.
 */
const KEEP_GRACE = 1500

// After the workspace was lost, it is connected to again at once, then after these, doubling.
const RETRY_DELAY = { first: 1000, most: 10_000 }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// A message that can change what the chat has (`ChatArtifacts`): a file sent, gadgets made or
// worked on, their changes kept or discarded, a connection used.
const changesArtifacts = (message: AiChatMessage) =>
  (message.type === 'message' && (message.attachments?.length ?? 0) > 0) ||
  message.type === 'changes' || message.type === 'merge' || message.type === 'revert' || message.type === 'action'

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
  #usage = NO_USAGE
  #agent: { key: string; name: string } | undefined
  #requiresParticipation = false
  // Set once the workspace says the chat was deleted: nothing it does after that is shown, and it
  // is not connected to again.
  #deleted = false
  #agentActive = false
  // Set once a live metadata update was applied, so the metadata read on loading cannot overwrite it.
  #liveMetadata = false
  #messages = new Map<number, AiChatMessage>()
  #feed: ChatFeed = EMPTY_FEED
  // The chat's actions that wait on a decision, wherever their messages are: read on loading
  // (undefined until then), and kept up here.
  #pendingActions: ActionLogEntry[] | undefined
  // The chat's action records that changed while those are read, by id, the last of each: put on
  // top of what was read, so that a decision or new pending action then is not lost.
  #actionsWhileListing = new Map<number, ActionLogEntry>()
  // Whether the metadata says the chat waits on a decision (undefined until it is read), and whether
  // this load has fetched the history back to it (`#seekWaiting`).
  #awaitingDecision: boolean | undefined
  #sought = false
  #artifacts: ChatArtifacts | undefined
  // The reads of what the chat has, one after another, and whether one is waiting to start.
  #artifactsRead: Promise<void> = Promise.resolve()
  #artifactsWanted = false
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
  // The latest message the account was told the viewer has read.
  #markedRead = -1
  // How many show the conversation (`view()`), and the workspace's word that it is shown while they do.
  #viewers = 0
  #viewLease: Promise<Disposable> | undefined
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
  // The workpieces the chat proposes changes to, as last seen, and what they do read one after
  // another so two never race.
  #proposed = ''
  #reading: Promise<void> = Promise.resolve()
  // What the user is asked to keep, and the wait before asking, from when the turn ended.
  #keep: KeepAsk | undefined
  // The epoch it is asked over, to say again what it is as more is written into it.
  #keepEpoch: number | undefined
  #keepTimer: ReturnType<typeof setTimeout> | undefined
  #turnEndedAt = 0
  // The chat's code, made once something shows it (`holdCode`), and how many do. It is fed the
  // code base its metadata last said (once it has said), and the rows of its change stream, kept
  // here meanwhile so that it can be made at any time: the history, read again, takes the older ones in.
  #code: ChatCode | undefined
  #codeHolders = 0
  // Edits made to it are on their way, so that its changes are not kept without them.
  #codeSending = false
  // The run the history is being read back for it in, and when that is tried again, having failed, and after how long.
  #codeReading: number | undefined
  #codeRetry: ReturnType<typeof setTimeout> | undefined
  #codeRetryDelay = 0
  #codeBase: { known: boolean; base?: ChatCodeBase } = { known: false }
  #codeFed = ''
  #rows: StreamRow[] = []

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
    this.#code?.dispose()
    this.#code = undefined
    this.#codeHolders = 0
    this.#codeSending = false
    clearTimeout(this.#codeRetry)
    this.#codeRetry = undefined
    this.#codeRetryDelay = 0
  }

  /**
   * The chat's code, live (`ChatCode`): while it is held, the history is read back to where the
   * chat's changes were last kept, as far as that takes. Let go of with what comes back with it,
   * which stops that, but not the code, which lives as long as the session does, so that what was
   * edited is still sent.
   */
  holdCode = (): { code: ChatCode; release: () => void } => {
    if (!this.#code) {
      this.#code = new ChatCode({ submit: this.#submitCode, reread: () => this.reconnect() })
      this.#code.subscribe(this.#heardCode)
    }
    const code = this.#code
    this.#codeHolders++
    this.#codeFed = ''
    for (const row of this.#rows) code.row(row)
    this.#feedCode()
    let held = true
    return {
      code,
      release: () => {
        if (!held) return
        held = false
        this.#codeHolders = Math.max(0, this.#codeHolders - 1)
      },
    }
  }

  #heardCode = () => {
    const snapshot = this.#code?.getSnapshot()
    const sending = snapshot?.status === 'ready' && snapshot.sending
    if (sending === this.#codeSending) return
    this.#codeSending = sending
    if (!this.#keep) return
    this.#keep = { ...this.#keep, sending }
    this.#publishReady()
  }

  #submitCode = (submission: Parameters<Overseer['submitCodeChange']>[1]) => {
    const overseer = this.#overseer
    if (!overseer || !this.#loaded) return Promise.reject(new NotSent('The conversation is reconnecting.'))
    return overseer.submitCodeChange(this.chatId, submission)
  }

  // Tells the chat's code what the history says of it, once that reaches back to its epoch and
  // has changed since it was last told, and whether the agent works.
  #feedCode() {
    const code = this.#code
    if (!code || !this.#loaded || !this.#codeBase.known) return
    code.agent(this.#agentActive)
    const base = this.#codeBase.base
    const epoch = base?.epoch
    const before = this.#nextBeforeSequence
    if (before !== undefined && (epoch === undefined || before > epoch)) {
      // Read back once at a time, and, where a page could not be had, again a while later, longer each time.
      const run = this.#run
      if (this.#codeHolders === 0 || this.#codeReading === run) return
      this.#codeReading = run
      clearTimeout(this.#codeRetry)
      this.#reading = this.#reading.then(async () => {
        const reached = await this.#loadedSince(run, epoch)
        if (this.#codeReading === run) this.#codeReading = undefined
        if (run !== this.#run) return
        if (reached) {
          this.#codeRetryDelay = 0
          return this.#feedCode()
        }
        this.#codeRetryDelay = Math.min(this.#codeRetryDelay * 2 || CODE_RETRY.first, CODE_RETRY.most)
        this.#codeRetry = setTimeout(() => this.#feedCode(), this.#codeRetryDelay)
      })
      return
    }
    const fed = JSON.stringify([base?.generation, epoch, base?.pins, base?.prior, this.#lastCodeMessage()])
    if (fed === this.#codeFed) return
    this.#codeFed = fed
    code.history(epochCode([...this.#messages.values()], base), base?.pins ?? [])
  }

  // The latest message that says something of the chat's code, so that one that changes it tells it again.
  #lastCodeMessage() {
    let latest = -1
    for (const { sequence, type } of this.#messages.values()) {
      if ((type === 'changes' || type === 'merge' || type === 'revert') && sequence > latest) latest = sequence
    }
    return latest
  }

  #applyRow(chatId: number, row: StreamRow) {
    if (chatId !== this.chatId) return
    const generation = this.#codeBase.base?.generation ?? 0
    this.#rows = [...this.#rows.filter((each) => each.generation >= generation), row].slice(-MAX_KEPT_ROWS)
    this.#code?.row(row)
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
    this.#releaseView()
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
   * uploaded for it to carry and the connections in `capsules` given to the chat, replying to the
   * message numbered `replyTo` if given, and resolves to whether it went, so that whoever drafted
   * it can keep the draft when it did not. The message and the reply come back through the
   * subscription, not from here; a failure is reported in the snapshot's `sendError`.
   */
  send = async (message: string | SlashCommandRequest, modelId: string, files: readonly File[] = [], capsules?: CapsuleSpecifier[], replyTo?: number): Promise<boolean> => {
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
      await overseer.sendChatMessage(this.chatId, message, modelId, capsules, attachments, undefined, replyTo)
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
   * Finds the message a reply answers (`UserItem.replyTo`), and resolves to its row's key. The
   * list holds history only from some message on, so to reach one before that, everything back to
   * it is fetched, in as few reads as the workspace allows. Nothing when the message has no row of
   * its own, or the history cannot be fetched.
   */
  findReplied = async (reply: UserItem): Promise<string | undefined> => {
    const sequence = reply.replyTo
    if (sequence === undefined) return undefined
    const run = this.#run
    for (let before = this.#nextBeforeSequence; before !== undefined && sequence < before; before = this.#nextBeforeSequence) {
      // A page already on its way is waited for, and then the rest fetched.
      await (this.#earlier ?? this.#loadEarlier(Math.min(MAX_HISTORY_PAGE_SIZE, before - sequence)))
      if (run !== this.#run || this.#nextBeforeSequence === before) return undefined
    }
    return this.#feed.items.find((row) => row.id === sequence && (row.kind === 'user' || row.kind === 'assistant'))?.key
  }

  /** A message as the server sent it, written out in full, for someone looking into what happened. Nothing for one not loaded. */
  rawMessage = (sequence: number): string | undefined => {
    const message = this.#messages.get(sequence)
    return message && JSON.stringify(message, null, 2)
  }

  /**
   * Tells the account the viewer has read the chat through its latest message, which clears its
   * unread marks. Said once for each message: asked again before another arrives, it does nothing.
   * Only for whoever may build in the workspace: someone who can only use it has no read state.
   */
  markRead = () => {
    const latest = Math.max(-1, ...this.#messages.keys())
    const overseer = this.#overseer
    if (!overseer || !this.#loaded || latest <= this.#markedRead || this.options.connection?.down) return
    this.#markedRead = latest
    Promise.resolve(overseer.markChatRead(this.chatId, latest)).catch(() => {
      // Said again with the next message, or when the chat is next come back to.
      if (this.#markedRead === latest) this.#markedRead = -1
    })
  }

  /**
   * Marks the chat unread for the viewer from a message on (`sequence`, a row's id): that message
   * and every one after it count as unread, until another arrives or the chat is come back to.
   * Rejects with why it could not be. Only for whoever may build in the workspace.
   */
  markUnreadFrom = async (sequence: number) => {
    const overseer = this.#overseer
    if (!overseer || !this.#loaded) throw new Error('The conversation is still loading.')
    await overseer.markChatUnread(this.chatId, sequence)
  }

  /**
   * Says the conversation is on screen until the function returned is called (`viewChat`). While
   * anyone shows it, the workspace keeps the model's cache of it warm, so that the next message
   * costs less and is answered sooner, and the viewer is told of what is new in it. Held again on
   * each new connection to the workspace. Only for whoever may build in the workspace.
   *
   * Coming back to the chat is reading it, so the first `markRead` of each showing marks what is
   * there, even what was marked unread meanwhile.
   */
  view = (): (() => void) => {
    if (this.#viewers++ === 0) this.#markedRead = -1
    this.#holdView()
    let held = true
    return () => {
      if (!held) return
      held = false
      if (--this.#viewers === 0) this.#releaseView()
    }
  }

  #holdView() {
    const overseer = this.#overseer
    if (this.#viewers === 0 || this.#viewLease || !overseer || !this.#loaded) return
    const lease = Promise.resolve(overseer.viewChat(this.chatId))
    this.#viewLease = lease
    // Without it the chat is only not kept warm: nothing shown depends on it.
    lease.catch(() => {
      if (this.#viewLease === lease) this.#viewLease = undefined
    })
  }

  #releaseView() {
    void this.#viewLease?.then((held) => held[Symbol.dispose](), () => {})
    this.#viewLease = undefined
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

  /**
   * Fetches one older page. Concurrent calls are ignored; failures are retryable, and the code,
   * should it have stopped short of where its changes were last kept for one, reads on.
   */
  loadEarlier = async () => {
    await this.#loadEarlier(HISTORY_PAGE_SIZE)
    this.#feedCode()
  }

  /** Fetches the `limit` messages before those loaded, as `loadEarlier` does a page. */
  async #loadEarlier(limit: number) {
    const overseer = this.#overseer
    const before = this.#nextBeforeSequence
    if (!overseer || !this.#loaded || this.#failure || this.#loadingEarlier || before === undefined) return
    const fetching = this.#fetchEarlier(overseer, before, limit)
    this.#earlier = fetching
    try {
      await fetching
    } finally {
      if (this.#earlier === fetching) this.#earlier = undefined
    }
  }

  /**
   * The chat's actions that wait on a decision, oldest first: every page of the workspace's pending
   * ones (`listActions`), less the other chats'. It costs what is pending, not the chat's length.
   */
  async #readPendingActions(run: number, overseer: ChatOverseer): Promise<ActionLogEntry[]> {
    const pending: ActionLogEntry[] = []
    let beforeId: number | undefined
    do {
      const page = await overseer.listActions({ filter: 'pending', beforeId })
      if (run !== this.#run) break
      pending.push(...page.entries.filter(({ chatId }) => chatId === this.chatId))
      beforeId = page.nextBeforeId
    } while (beforeId !== undefined)
    return pending.toReversed()
  }

  /**
   * Where the chat waits on a decision (`AiChatMetadata.awaitingDecision`) that none of its pending
   * actions and none of the requests loaded is, the request is further back than has been loaded:
   * the history is fetched back to it, in as few reads as the workspace allows, so that it shows,
   * at the end of its turn as any is. Once a load, when both the metadata and the pending actions
   * have been read; stopped by a read that fails, as `loadEarlier` leaves it to try again.
   */
  async #seekWaiting(run: number) {
    if (this.#sought || this.#awaitingDecision === undefined || this.#pendingActions === undefined) return
    this.#sought = true
    const waitsShown = () => {
      const before = this.#nextBeforeSequence
      return this.#pendingActions?.some(({ state }) => state === 'pending') || [...this.#messages.values()].some((message) =>
        (before === undefined || message.sequence >= before) &&
        (message.type === 'connectionRequest' || message.type === 'webFetchRequest') && message.state === 'pending')
    }
    for (let before = this.#nextBeforeSequence; before !== undefined && this.#awaitingDecision && !waitsShown(); before = this.#nextBeforeSequence) {
      // A page already on its way is waited for, and then the rest fetched.
      await (this.#earlier ?? this.#loadEarlier(MAX_HISTORY_PAGE_SIZE))
      if (run !== this.#run || this.#nextBeforeSequence === before) return
    }
  }

  async #fetchEarlier(overseer: ChatOverseer, before: number, limit: number) {
    const run = this.#run
    this.#loadingEarlier = true
    this.#historyError = undefined
    this.#publishReady()
    try {
      const page = await overseer.getChatHistory(this.chatId, before, limit)
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
    // What waits from before the loaded messages: the actions whose messages are not loaded (a
    // slash command's has none).
    const loadedActions = new Set(loaded.flatMap((message) => (message.type === 'action' ? [message.actionId] : [])))
    const waitingBefore = (this.#pendingActions ?? []).filter(({ id, state }) => state === 'pending' && !loadedActions.has(id))
    const context = {
      viewerId: this.options.viewerId,
      agentActive: this.#agentActive,
      steers: this.#steers,
      compactedTo: this.#compactedTo,
      outputFormats: this.#outputFormats,
      waitingBefore,
    }
    this.#feed = toChatFeed(loaded, context, this.#feed)
    this.#work = undefined
  }

  /**
   * Reads what the chat has, every page of it, after any read under way; while one waits to
   * start, it covers whatever asked since. What was read before stays until it is replaced, and
   * where a read fails, until the next.
   */
  #readArtifacts() {
    if (this.#artifactsWanted) return
    this.#artifactsWanted = true
    this.#artifactsRead = this.#artifactsRead.then(async () => {
      this.#artifactsWanted = false
      const run = this.#run
      const overseer = this.#overseer
      if (!overseer) return
      try {
        const first = await overseer.listChatArtifacts(this.chatId)
        const artifacts = [...first.artifacts]
        for (let after = first.nextAfterSequence; after !== undefined && run === this.#run;) {
          const page = await overseer.listChatArtifacts(this.chatId, after)
          artifacts.push(...page.artifacts)
          after = page.nextAfterSequence
        }
        if (run !== this.#run) return
        this.#artifacts = { artifacts, connections: first.connections ?? [] }
        if (this.#loaded) this.#publishReady()
      } catch {
        // Kept as last read: the next change to what the chat has reads it again.
      }
    })
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
    if (this.#compacting) return COMPACTING
    const call = this.#calls.at(-1)
    if (call) return toolStatus(call.toolName, call.noun)
    return this.#streaming === '' ? THINKING : WRITING
  }

  #reset() {
    this.#loaded = false
    this.#early = []
    this.#title = undefined
    this.#usage = NO_USAGE
    this.#requiresParticipation = false
    this.#deleted = false
    this.#agentActive = false
    this.#liveMetadata = false
    this.#messages = new Map()
    this.#feed = EMPTY_FEED
    this.#pendingActions = undefined
    this.#actionsWhileListing = new Map()
    this.#awaitingDecision = undefined
    this.#sought = false
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
    this.#reading = Promise.resolve()
    clearTimeout(this.#keepTimer)
    this.#keep = undefined
    this.#codeBase = { known: false }
    this.#codeFed = ''
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
      agent: this.#agent,
      usage: this.#usage,
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
      artifacts: this.#artifacts,
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
      // chat's metadata, and the actions it waits on from before the messages loaded, when read.
      overseer.getChatMetadata(this.chatId).then(
        (chat) => this.#live(run, () => this.#applyReadChat(run, chat)),
        (error) => this.#lost(run, error),
      )
      this.#readPendingActions(run, overseer).then(
        (pending) => this.#live(run, () => {
          // The records that changed while the pages were read, over them: one decided goes, one
          // still pending keeps its place, and one newly pending is added.
          const later = this.#actionsWhileListing
          this.#actionsWhileListing = new Map()
          const listed = new Set(pending.map(({ id }) => id))
          this.#pendingActions = [
            ...pending.map((action) => later.get(action.id) ?? action),
            ...[...later.values()].filter(({ id }) => !listed.has(id)),
          ].filter(({ state }) => state === 'pending')
          this.#rebuildFeed()
          this.#publishReady()
          void this.#seekWaiting(run)
        }),
        (error) => this.#lost(run, error),
      )
      this.#readArtifacts()
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
      this.#holdView()
      for (const apply of this.#early.splice(0)) apply()
      this.#publishReady()
      this.#feedCode()
      // What failed to be sent over the old connection goes over this one.
      this.#code?.retry()
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
      changeApplied: (chatId, generation, revision, _author, change, submission) => live(() => this.#applyRow(chatId, { generation, revision, change, submission })),
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

  #applyReadChat(run: number, chat: AiChatMetadata | undefined) {
    if (!chat) return this.#fail('This chat doesn’t exist, or was deleted.')
    // It may have been read before a live update that arrived first; live updates win, as they
    // do over fetched history.
    if (this.#liveMetadata) return
    this.#readMetadata(chat)
    this.#publishReady()
    this.#feedCode()
    this.#offerKeep(run, chat, false)
    void this.#seekWaiting(run)
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
    this.#feedCode()
    this.#offerKeep(run, chat, turnEnded)
    void this.#seekWaiting(run)
  }

  /**
   * Asks the user to keep the chat's changes once nobody is working on them: when its turn ends, or
   * when what it proposes changes while its agent is not running (as on opening). Nothing is kept
   * without asking.
   */
  #offerKeep(run: number, chat: AiChatMetadata, turnEnded: boolean) {
    const proposed = (chat.proposedChangeWorkpieces ?? []).join()
    const changed = proposed !== this.#proposed
    this.#proposed = proposed
    if (turnEnded) this.#turnEndedAt = Date.now()
    // Kept, discarded, or worked on again: what was asked no longer stands.
    if (changed || chat.activeAgent) this.#stopAsking()
    if (proposed === '' || chat.activeAgent || !(turnEnded || changed)) return
    const epoch = chat.codeBase?.epoch
    this.#reading = this.#reading.then(async () => {
      // What is asked about is what has been loaded, should the start of the epoch be out of reach.
      await this.#loadedSince(run, epoch)
      if (run === this.#run && !this.#agentActive) this.#askToKeep(epoch)
    })
  }

  #stopAsking() {
    clearTimeout(this.#keepTimer)
    if (this.#keep === undefined) return
    this.#keep = undefined
    this.#publishReady()
  }

  /**
   * Asks the user to keep the changes since `epoch`, no sooner than `KEEP_GRACE` after the turn
   * ended, and only if nothing has changed meanwhile, saying what they do by then.
   */
  #askToKeep(epoch: number | undefined) {
    // What was kept while this was worked out (a save on the gadget's own page, through its own chat, keeps at once) is not asked about.
    if (this.#proposed === '') return this.#stopAsking()
    clearTimeout(this.#keepTimer)
    const run = this.#run
    const proposed = this.#proposed
    this.#keepTimer = setTimeout(() => {
      if (run !== this.#run || proposed !== this.#proposed || this.#agentActive) return
      this.#keep = { changes: proposedChanges([...this.#messages.values()], epoch), sending: this.#codeSending, epoch }
      this.#keepEpoch = epoch
      this.#publishReady()
    }, Math.max(0, this.#turnEndedAt + KEEP_GRACE - Date.now()))
  }

  /** Fetches earlier pages until every message after `epoch` is in, or one cannot be fetched. */
  async #loadedSince(run: number, epoch: number | undefined) {
    for (;;) {
      const before = this.#nextBeforeSequence
      if (before === undefined || (epoch !== undefined && before <= epoch)) return true
      if (run !== this.#run) return false
      await (this.#earlier ?? this.#loadEarlier(MAX_HISTORY_PAGE_SIZE))
      if (run !== this.#run || this.#nextBeforeSequence === before) return false
    }
  }

  #readMetadata(chat: AiChatMetadata) {
    this.#title = chat.title
    this.#codeBase = { known: true, base: chat.codeBase }
    const usage = usageOf(chat)
    if (!sameUsage(this.#usage, usage)) this.#usage = usage
    // A run from before runs named their spawner has no agent to go to.
    this.#agent = chat.spawnerId !== undefined ? { key: agentKeyOf(chat.spawnerId), name: chat.spawnerName || 'Agent' } : undefined
    this.#requiresParticipation = chat.notificationsRequireParticipation === true
    this.#agentActive = chat.activeAgent !== undefined
    this.#awaitingDecision = chat.awaitingDecision === true
    this.#compactedTo = chat.compactedTo
    const { viewerId } = this.options
    const queue = (chat.queuedSteers ?? []).map(({ text, author, replyToSequence }): PendingSteer => ({
      text,
      from: author.id === viewerId ? undefined : author.name,
      unread: true,
      replyTo: replyToSequence,
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
    // What is asked about says what more was written into it meanwhile, such as edits typed beside the chat.
    if (message.type === 'changes' && this.#keep) this.#keep = { ...this.#keep, changes: proposedChanges([...this.#messages.values()], this.#keepEpoch) }
    if (changesArtifacts(message)) this.#readArtifacts()
    // A finished step replaces what streamed of it; updates to an agent's approval/tool cards do not.
    if (message.type === 'message' && message.author.type === 'agent' &&
      (this.#nextBeforeSequence === undefined || message.sequence >= this.#nextBeforeSequence)) this.#discardProvisional()
    this.#publishReady()
    if (message.type === 'changes' || message.type === 'merge' || message.type === 'revert') this.#feedCode()
  }

  /**
   * Refreshes the copy of an action's record that its chat message carries, and that of one the
   * chat waits on. One of the chat's decided may have used a connection.
   */
  #applyAction(record: ActionLogEntry) {
    let changed = false
    for (const [sequence, message] of this.#messages) {
      if (message.type !== 'action' || message.actionId !== record.id) continue
      this.#messages.set(sequence, { ...message, actionLog: record })
      changed = true
    }
    if (record.chatId === this.chatId) {
      const actions = this.#pendingActions
      const at = actions?.findIndex(({ id }) => id === record.id) ?? -1
      if (!actions) this.#actionsWhileListing.set(record.id, record)
      else if (at !== -1 || record.state === 'pending') {
        this.#pendingActions = at === -1 ? [...actions, record] : actions.with(at, record)
        changed = true
      }
      if (record.type === 'action' && record.state !== 'pending') this.#readArtifacts()
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
