import type { RpcStub } from 'capnweb'
import {
  getOpenWorkspaceErrorCode,
  OPEN_WORKSPACE_ERROR_CODES,
  type ActionLogEntry,
  type AiChatAuthorInfo,
  type AiChatMessage,
  type AiChatMetadata,
  type Overseer,
} from '@gadgets/workshop-shared/api'
import { ActionUpdates, ChatSubscriber } from '@/chat/ChatSubscriber'
import { isAgentRun } from '@gadgets/workshop-shared/api'
import type { ActionEntry } from './activityEntries'

/** The history read so far, newest first by id, and whether there is more of it to read. */
export type ActivityHistory = {
  entries: readonly ActionLogEntry[]
  /** The first page has been read. */
  read: boolean
  /** Reading a page: the first, or an older one. */
  reading: boolean
  /** There are older pages to read. */
  more: boolean
  /** Why the last page could not be read. */
  problem?: string
}

export type WorkspaceActivitySnapshot =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      /** Every chat, people's and agents' runs alike. */
      chats: readonly AiChatMetadata[]
      /** Every action waiting on a decision. */
      pending: readonly ActionEntry[]
      /** The chat each action was made in, by its id, where the action does not say and a message of the chat does. */
      actionChats: ReadonlyMap<number, number>
      /** The person who last wrote in each chat, by its id: for those that wait, who is kept waiting. */
      askers: ReadonlyMap<number, AiChatAuthorInfo>
      /** The person who first wrote in each chat, by its id, as nothing else says who started it. */
      starters: ReadonlyMap<number, AiChatAuthorInfo>
      /** The latest message with words in it of each chat, by its id. */
      latest: ReadonlyMap<number, LatestMessage>
      /** What each chat last asked of a person, by its id, as words for its line: a connection, or an action to approve. */
      asks: ReadonlyMap<number, LatestMessage>
      history: ActivityHistory
    }

/** The part of a workspace's Overseer the activity uses, and the lease that must be disposed. */
export type ActivityOverseer = Pick<Overseer, 'listChats' | 'listActions' | 'getChatHistory'> & {
  subscribeToChat(subscriber: Parameters<RpcStub<Overseer>['subscribeToChat']>[0]): Promise<Disposable>
  subscribeToActions(subscriber: Parameters<RpcStub<Overseer>['subscribeToActions']>[0]): Promise<Disposable>
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
} & Disposable

export type WorkspaceActivityOptions = {
  /** The app's connection, which may be `down`: what fails meanwhile is not said, as `restart()` follows. */
  connection?: { readonly down: boolean }
}

/** A chat's latest message with words in it: its first line, who wrote it, and when. */
export type LatestMessage = { text: string; author: AiChatAuthorInfo; at: Date }

const LOADING: WorkspaceActivitySnapshot = { status: 'loading' }
const RETRY_DELAY = 1000
// How many of a waiting chat's last messages are read for who asked, and how many chats at a time.
const TAIL = 30
const TAILS_AT_ONCE = 4
// How many of the latest chats are read for who last wrote in them and what, beside those that wait;
// and how many of a chat's first messages are read for who started it, where its last do not reach.
const RECENT_TAILS = 40
const HEAD = 10
const PREVIEW = 240
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The person a chat's agent is working for: the last to have written to it.
const askerOf = (message: AiChatMessage): AiChatAuthorInfo | undefined =>
  (message.type === 'message' || message.type === 'slashCommand') && message.author.type === 'user' ? message.author : undefined

/**
 * A line of Markdown as plain words, for where it is quoted rather than drawn: a link's words
 * without where it goes, and no marks of emphasis or code, nor of a heading, a quote or a list.
 */
export const plainLine = (line: string) =>
  line
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`+([^`]+)`+/g, '$1')
    .trim()

/**
 * What a message asks of a person, while it waits, as a list's line has it beside the pill that says
 * it waits (so not "Asks for approval" again): a connection to make, and what for, or the action to
 * approve. Once decided it asks nothing.
 */
export const askOf = (message: AiChatMessage): LatestMessage | undefined => {
  const at = { author: message.author, at: message.timestamp }
  if (message.type === 'connectionRequest' && message.state === 'pending') {
    return { text: `Connect ${message.vendorName} · ${plainLine(message.reason)}`.slice(0, PREVIEW), ...at }
  }
  const log = message.type === 'action' ? message.actionLog : undefined
  if (log?.type === 'action' && log.state === 'pending') return { text: plainLine(log.description.title).slice(0, PREVIEW), ...at }
  return undefined
}

/** What a message says, as a list's line has it: its first line with words in it, if it has any. */
export const latestOf = (message: AiChatMessage): LatestMessage | undefined => {
  if (message.type !== 'message') return undefined
  const line = message.message.split('\n').map((each) => plainLine(each.trim())).find(Boolean)
  return line ? { text: line.slice(0, PREVIEW), author: message.author, at: message.timestamp } : undefined
}

/**
 * A workspace's activity, live: its chats (`listChats()`, `subscribeToChat()`), every action that
 * waits on a decision (`listActions({ filter: 'pending' })`, every page of it, and
 * `subscribeToActions()`), and its history, a page at a time as it is asked for (`loadOlder()`),
 * newest first, with what changes meanwhile laid over it. For each chat that waits, and the
 * latest, its last few messages are read once for who last wrote in it, and what: who asked for
 * what it waits on, as an action does not say, and the start of its latest message; and for a chat
 * people had, who first wrote in it, who it is by, from its first messages where the last do not
 * reach. Observable
 * through `subscribe`/`getSnapshot`. Nothing happens until `start()`; `stop()` lets the workspace
 * go, and `restart()` starts over on a new connection, keeping what is shown meanwhile.
 */
export class WorkspaceActivity {
  #snapshot: WorkspaceActivitySnapshot = LOADING
  #listeners = new Set<() => void>()
  #overseer: ActivityOverseer | undefined
  #leases: Promise<Disposable>[] = []
  #run = 0
  #retry: ReturnType<typeof setTimeout> | undefined

  #chats: Map<number, AiChatMetadata> | undefined
  #early = new Map<number, AiChatMetadata | null>()
  #pending = new Map<number, ActionEntry>()
  #actionChats = new Map<number, number>()
  #askers = new Map<number, AiChatAuthorInfo>()
  #starters = new Map<number, AiChatAuthorInfo>()
  #latest = new Map<number, LatestMessage>()
  #asks = new Map<number, LatestMessage>()
  #tailsRead = new Set<number>()
  #tailsReading = 0
  // The history read, by id; those heard of live since the subscription, which a page read later
  // does not overwrite; and where the next older page starts, once the first has been read.
  #history = new Map<number, ActionLogEntry>()
  #heard = new Set<number>()
  #before: number | undefined
  #historyRead = false
  #more = true
  #reading = false
  #problem: string | undefined

  constructor(
    private readonly open: () => ActivityOverseer,
    private readonly options: WorkspaceActivityOptions = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    this.#chats = undefined
    this.#early = new Map()
    this.#pending = new Map()
    this.#actionChats = new Map()
    this.#tailsRead = new Set()
    this.#tailsReading = 0
    this.#heard = new Set()
    this.#before = undefined
    this.#historyRead = false
    this.#more = true
    this.#reading = false
    this.#problem = undefined
    let overseer: ActivityOverseer
    try {
      overseer = this.#overseer = this.open()
    } catch (error) {
      this.#fail(error)
      return
    }
    const live = (apply: () => void) => {
      if (run === this.#run) apply()
    }
    // Subscribed to before anything is read, so that nothing that happens meanwhile is missed.
    this.#leases = [
      overseer.subscribeToChat(new ChatSubscriber({
        streamGeneration: () => {},
        stream: () => {},
        metadata: (chat) => live(() => this.#updated(run, chat)),
        deleted: (chatId) => live(() => this.#deleted(chatId)),
        message: (message) => live(() => this.#message(message)),
      })),
      overseer.subscribeToActions(new ActionUpdates((record) => live(() => this.#entry(run, record, true)))),
    ]
    for (const lease of this.#leases) lease.catch((error: unknown) => live(() => this.#fail(error)))

    overseer.listChats().then(
      (chats) => live(() => {
        this.#chats = new Map(chats.map((chat) => [chat.id, chat]))
        for (const [id, chat] of this.#early) {
          if (chat) this.#chats.set(id, chat)
          else this.#chats.delete(id)
        }
        this.#early.clear()
        this.#publish()
        this.#readTails(run)
      }),
      (error: unknown) => live(() => this.#fail(error)),
    )
    void this.#readPending(run, overseer)
    this.#readHistory(run)

    overseer.onRpcBroken(() => {
      if (run !== this.#run || this.options.connection?.down) return
      clearTimeout(this.#retry)
      this.#retry = setTimeout(() => {
        if (run === this.#run) this.restart()
      }, RETRY_DELAY)
    })
  }

  stop() {
    this.#run++
    clearTimeout(this.#retry)
    for (const lease of this.#leases) void lease.then((handle) => handle[Symbol.dispose](), () => {})
    this.#leases = []
    this.#overseer?.[Symbol.dispose]()
    this.#overseer = undefined
  }

  /** Starts over, as on a new connection, with what is shown left up until it is read again. */
  restart() {
    this.stop()
    this.start()
  }

  /** Reads the next older page of the history (or the first again, where it could not be), unless one is being read or there is none. */
  loadOlder() {
    if (this.#reading || !this.#more) return
    this.#readHistory(this.#run)
  }

  async #readPending(run: number, overseer: ActivityOverseer) {
    let before: number | undefined
    try {
      do {
        const page = await overseer.listActions({ filter: 'pending', ...(before === undefined ? {} : { beforeId: before }) })
        if (run !== this.#run) return
        for (const record of page.entries) this.#entry(run, record, false)
        before = page.nextBeforeId
      } while (before !== undefined)
    } catch {
      // What waits still says so in its chat, and arrives here as it changes.
    }
  }

  #readHistory(run: number) {
    const overseer = this.#overseer
    if (!overseer) return
    this.#reading = true
    this.#problem = undefined
    this.#publish()
    overseer.listActions(this.#before === undefined ? {} : { beforeId: this.#before }).then(
      (page) => {
        if (run !== this.#run) return
        for (const record of page.entries) {
          if (!this.#heard.has(record.id)) this.#history.set(record.id, record)
          if (record.chatId !== undefined) this.#actionChats.set(record.id, record.chatId)
        }
        // Kept from before a restart only where this read them again.
        if (!this.#historyRead) {
          const read = new Set(page.entries.map(({ id }) => id))
          const oldest = page.entries.at(-1)?.id ?? 0
          for (const id of this.#history.keys()) if (id < oldest && !read.has(id)) this.#history.delete(id)
        }
        this.#historyRead = true
        this.#before = page.nextBeforeId
        this.#more = page.nextBeforeId !== undefined
        this.#reading = false
        this.#publish()
      },
      (error: unknown) => {
        if (run !== this.#run) return
        this.#reading = false
        this.#problem = messageOf(error)
        this.#publish()
      },
    )
  }

  #updated(run: number, chat: AiChatMetadata) {
    if (!this.#chats) {
      this.#early.set(chat.id, chat)
      return
    }
    this.#chats.set(chat.id, chat)
    this.#publish()
    if (chat.awaitingDecision) this.#readTails(run)
  }

  #deleted(chatId: number) {
    if (!this.#chats) {
      this.#early.set(chatId, null)
      return
    }
    if (this.#chats.delete(chatId)) this.#publish()
  }

  #message(message: AiChatMessage) {
    const ask = askOf(message)
    if (ask) this.#asks.set(message.chatId, ask)
    if (message.type === 'action') {
      this.#actionChats.set(message.actionId, message.chatId)
      if (message.actionLog) this.#entry(this.#run, message.actionLog, true)
      else this.#publish()
      return
    }
    const latest = latestOf(message)
    if (latest) this.#latest.set(message.chatId, latest)
    const asker = askerOf(message)
    if (asker) this.#askers.set(message.chatId, asker)
    if (latest || asker || ask) this.#publish()
  }

  #entry(run: number, record: ActionLogEntry, live: boolean) {
    if (record.chatId !== undefined) this.#actionChats.set(record.id, record.chatId)
    if (record.type === 'action' && record.state === 'pending') this.#pending.set(record.id, record)
    else this.#pending.delete(record.id)
    // What changes live is the newest there is of it; what is newer than the history read belongs at its top.
    if (live) this.#heard.add(record.id)
    if (live || this.#history.has(record.id) || !this.#historyRead) this.#history.set(record.id, record)
    this.#publish()
    this.#readTails(run)
  }

  // Who last wrote in each chat and what, from its last messages, read once each: first those that
  // wait, for who is kept waiting, then the latest, for who each is by and what it last said. Who
  // first wrote in a chat people had is in those, or else in its first messages, read then.
  #readTails(run: number) {
    const overseer = this.#overseer
    if (!overseer || !this.#chats) return
    const waiting = new Set<number>()
    for (const ask of this.#pending.values()) {
      const chatId = ask.chatId ?? this.#actionChats.get(ask.id)
      if (chatId !== undefined) waiting.add(chatId)
    }
    for (const chat of this.#chats.values()) if (chat.awaitingDecision) waiting.add(chat.id)
    const recent = [...this.#chats.values()]
      .toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
      .slice(0, RECENT_TAILS)
    for (const chat of recent) waiting.add(chat.id)
    for (const chatId of waiting) {
      if (this.#tailsReading >= TAILS_AT_ONCE) return
      if (this.#tailsRead.has(chatId)) continue
      this.#tailsRead.add(chatId)
      this.#tailsReading++
      const chat = this.#chats.get(chatId)
      overseer.getChatHistory(chatId, undefined, TAIL).then(
        async ({ messages, nextBeforeSequence }) => {
          if (run !== this.#run) return
          for (const message of messages) {
            if (message.type === 'action') this.#actionChats.set(message.actionId, chatId)
          }
          const asker = messages.findLast((message) => askerOf(message) !== undefined)
          if (asker && !this.#askers.has(chatId)) this.#askers.set(chatId, asker.author)
          const latest = messages.map(latestOf).findLast((each) => each !== undefined)
          if (latest && !this.#latest.has(chatId)) this.#latest.set(chatId, latest)
          const ask = messages.map(askOf).findLast((each) => each !== undefined)
          if (ask && !this.#asks.has(chatId)) this.#asks.set(chatId, ask)
          this.#publish()
          if (!chat || isAgentRun(chat)) return
          const first = nextBeforeSequence === undefined ? messages : (await overseer.getChatHistory(chatId, HEAD, HEAD)).messages
          if (run !== this.#run) return
          const starter = first.find((message) => askerOf(message) !== undefined)
          if (starter) {
            this.#starters.set(chatId, starter.author)
            this.#publish()
          }
        },
      ).catch(
        // It is shown without who asked, started it or wrote last.
        () => {},
      ).finally(() => {
        if (run !== this.#run) return
        this.#tailsReading--
        this.#readTails(run)
      })
    }
  }

  #publish() {
    if (!this.#chats) return
    this.#emit({
      status: 'ready',
      chats: [...this.#chats.values()],
      pending: [...this.#pending.values()],
      actionChats: new Map(this.#actionChats),
      askers: new Map(this.#askers),
      starters: new Map(this.#starters),
      latest: new Map(this.#latest),
      asks: new Map(this.#asks),
      history: {
        entries: [...this.#history.values()].toSorted((a, b) => b.id - a.id),
        read: this.#historyRead,
        reading: this.#reading,
        more: this.#more,
        ...(this.#problem === undefined ? {} : { problem: this.#problem }),
      },
    })
  }

  #fail(error: unknown) {
    if (this.options.connection?.down) return
    const code = getOpenWorkspaceErrorCode(error)
    this.#emit({
      status: 'failed',
      message: code === OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied ? 'You don’t have access to this workspace.' : messageOf(error),
    })
  }

  #emit(snapshot: WorkspaceActivitySnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}
