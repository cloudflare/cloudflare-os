import type { RpcStub } from 'capnweb'
import { getOpenWorkspaceErrorCode, OPEN_WORKSPACE_ERROR_CODES, type AiChatMetadata, type Overseer } from '@gadgets/workshop-shared/api'
import { ChatSubscriber } from '@/chat/ChatSubscriber'

export type AgentRunListSnapshot =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      /** Its runs read so far, and those that have started or changed since, newest first by id. */
      runs: AiChatMetadata[]
      /** The last page has been read: these are all its runs. */
      all: boolean
      /** More are being read (`more()`). */
      reading: boolean
      /** Why the last `more()` read nothing. */
      problem?: string
    }

/** The part of a workspace's Overseer the list uses, and the lease that must be disposed. */
export type AgentRunsOverseer = Pick<Overseer, 'listChats'> & {
  subscribeToChat(subscriber: Parameters<RpcStub<Overseer>['subscribeToChat']>[0]): Promise<Disposable>
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
} & Disposable

export type AgentRunListOptions = {
  /** The app's connection, which may be `down`: what fails meanwhile is not said, as `restart()` follows. */
  connection?: { readonly down: boolean }
}

/** How many runs are read at first, and how many more each time more are asked for. */
export const FIRST_RUNS = 25
export const MORE_RUNS = 50

const LOADING: AgentRunListSnapshot = { status: 'loading' }
// After the workspace was lost, how long until it is opened again.
const RETRY_DELAY = 1000
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * One agent's runs, live, for its page: read a page at a time, newest first
 * (`listChats({ spawnerId, limit, beforeId })`), `FIRST_RUNS` at first and `MORE_RUNS` more on
 * `more()`, and kept up from the chat stream (`subscribeToChat()`, subscribed to before anything
 * is read): a run of the agent that starts or changes is taken in, wherever it falls, and one
 * deleted is left out. Observable through `subscribe`/`getSnapshot`. Nothing happens until
 * `start()`; `stop()` lets the workspace go, and `restart()` reads again on a new connection, as
 * many as were read, keeping what is shown meanwhile.
 */
export class AgentRunList {
  #snapshot: AgentRunListSnapshot = LOADING
  #listeners = new Set<() => void>()
  #overseer: AgentRunsOverseer | undefined
  #lease: Promise<Disposable> | undefined
  // Bumped by every start and stop, so what a run asked for can tell it is stale.
  #run = 0
  #retry: ReturnType<typeof setTimeout> | undefined

  // Its runs, by id, once the first page is read; the lowest id the pages reached, for the next.
  #chats: Map<number, AiChatMetadata> | undefined
  #before: number | undefined
  #all = false
  #reading = false
  #problem: string | undefined
  // Updates that arrived before the first page, applied over it.
  #early = new Map<number, AiChatMetadata | null>()

  constructor(
    private readonly open: () => AgentRunsOverseer,
    private readonly spawnerId: number,
    private readonly options: AgentRunListOptions = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    // As many as were read before, so that a new connection shows what was shown.
    const current = this.#snapshot
    const limit = Math.max(FIRST_RUNS, current.status === 'ready' ? current.runs.length : 0)
    this.#chats = this.#before = undefined
    this.#early = new Map()
    this.#reading = false
    this.#problem = undefined
    let overseer: AgentRunsOverseer
    try {
      overseer = this.#overseer = this.open()
    } catch (error) {
      this.#fail(error)
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
    this.#lease.catch((error: unknown) => live(() => this.#fail(error)))

    overseer.listChats({ spawnerId: this.spawnerId, limit }).then(
      (chats) => live(() => {
        this.#chats = new Map(chats.map((chat) => [chat.id, chat]))
        this.#paged(chats, limit)
        for (const [id, chat] of this.#early) {
          if (chat) this.#chats.set(id, chat)
          else this.#chats.delete(id)
        }
        this.#early.clear()
        this.#publishReady()
      }),
      (error: unknown) => live(() => this.#fail(error)),
    )

    // Last, as it can be called at once, for a workspace that cannot be reached.
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
    void this.#lease?.then((lease) => lease[Symbol.dispose](), () => {})
    this.#overseer?.[Symbol.dispose]()
    this.#lease = this.#overseer = undefined
  }

  /** Starts over, as on a new connection, with what is shown left up until it is read again. */
  restart() {
    this.stop()
    this.start()
  }

  /** Reads the next page of its runs, older than any read, unless all were or some are being. */
  more() {
    const overseer = this.#overseer
    if (!overseer || !this.#chats || this.#all || this.#reading) return
    const run = this.#run
    this.#reading = true
    this.#problem = undefined
    this.#publishReady()
    overseer.listChats({ spawnerId: this.spawnerId, beforeId: this.#before, limit: MORE_RUNS }).then(
      (chats) => {
        if (run !== this.#run) return
        for (const chat of chats) if (!this.#chats!.has(chat.id)) this.#chats!.set(chat.id, chat)
        this.#paged(chats, MORE_RUNS)
      },
      (error: unknown) => {
        if (run === this.#run) this.#problem = messageOf(error)
      },
    ).finally(() => {
      if (run !== this.#run) return
      this.#reading = false
      this.#publishReady()
    })
  }

  // Where the pages have reached: a page shorter than asked for is the last.
  #paged(page: readonly AiChatMetadata[], limit: number) {
    this.#all = page.length < limit
    const last = page.at(-1)
    if (last && (this.#before === undefined || last.id < this.#before)) this.#before = last.id
  }

  #updated(chat: AiChatMetadata) {
    if (chat.spawnerId !== this.spawnerId) return
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
    this.#publish({
      status: 'ready',
      runs: [...this.#chats.values()].toSorted((a, b) => b.id - a.id),
      all: this.#all,
      reading: this.#reading,
      ...(this.#problem ? { problem: this.#problem } : {}),
    })
  }

  #fail(error: unknown) {
    // Over a lost connection, what was read stays up until it is read again.
    if (this.options.connection?.down) return
    const code = getOpenWorkspaceErrorCode(error)
    this.#publish({
      status: 'failed',
      message: code === OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied ? 'You don’t have access to this workspace.' : messageOf(error),
    })
  }

  #publish(snapshot: AgentRunListSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}
