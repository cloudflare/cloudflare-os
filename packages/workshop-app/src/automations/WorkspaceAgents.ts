import { RpcTarget, type RpcStub } from 'capnweb'
import {
  getOpenWorkspaceErrorCode,
  isAgentRun,
  OPEN_WORKSPACE_ERROR_CODES,
  type ActionLogEntry,
  type AgentSpawnerInfo,
  type AiChatMessage,
  type AiChatMetadata,
  type Overseer,
  type WorkpieceSummary,
  type WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import { ActionUpdates, ChatSubscriber } from '@/chat/ChatSubscriber'
import { agentsOf, setupsOf, type Agent, type AgentSetup } from './agents'

export type WorkspaceAgentsSnapshot =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      agents: Agent[]
      /**
       * The workspace's agent spawners have been read: until then an agent is known only by its
       * runs, with no gadget, and one that has not run is not known.
       */
      setUpRead: boolean
      /**
       * Every run of the workspace was read. Otherwise only the latest `RUNS_READ` and those
       * since were: what is said of an agent's runs is of those, and an agent known only by
       * older runs is not listed.
       */
      allRuns: boolean
      /** The chats with an action waiting to be approved, runs and people's alike, by id. */
      actionsWaiting: ReadonlySet<number>
    }

/**
 * The part of a workspace's Overseer the agents use, and the lease that must be disposed. The
 * subscribe calls take the subscriber object itself, as a call through a stub does.
 */
export type AgentsOverseer = Pick<Overseer, 'listChats' | 'listActions' | 'listAgentSpawners'> & {
  subscribeToChat(subscriber: Parameters<RpcStub<Overseer>['subscribeToChat']>[0]): Promise<Disposable>
  subscribeToActions(subscriber: Parameters<RpcStub<Overseer>['subscribeToActions']>[0]): Promise<Disposable>
  subscribeToWorkpieces(subscriber: WorkpiecesSubscriber & RpcTarget): Promise<Disposable>
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
} & Disposable

export type WorkspaceAgentsOptions = {
  /** The app's connection, which may be `down`: what fails meanwhile is not said, as `restart()` follows. */
  connection?: { readonly down: boolean }
}

/** How many of the workspace's latest runs are read, newest first by id. */
export const RUNS_READ = 100

const LOADING: WorkspaceAgentsSnapshot = { status: 'loading' }
// After the workspace was lost, how long until it is opened again.
const RETRY_DELAY = 1000
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What the server calls as the workspace's workpieces change: here, its gadgets, and once all were listed. */
class GadgetList extends RpcTarget implements WorkpiecesSubscriber {
  constructor(private readonly events: { entry(summary: WorkpieceSummary): void; removed(id: number): void; ready(): void }) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    this.events.entry(summary)
  }

  removed(id: number) {
    this.events.removed(id)
  }

  ready() {
    this.events.ready()
  }
}

/**
 * A workspace's agents, live: its agent spawners (`listAgentSpawners()`, read again as its
 * workpieces change, as a gadget's bindings do when changes to it are kept), each an agent,
 * with every gadget bound to it; and its latest runs (`listChats({ kind: 'runs', limit })`) and
 * how each stands (`subscribeToChat()`, whose metadata says whether a run's last turn failed and
 * brings new ones, with the actions waiting on a person from `subscribeToActions()`). Observable
 * through `subscribe`/`getSnapshot`. Nothing happens until `start()`; `stop()` lets the workspace
 * go, and `restart()` starts over on a new connection, keeping what is shown meanwhile.
 *
 * Only the first page of the runs (see `allRuns`) and of the actions waiting is read.
 */
export class WorkspaceAgents {
  #snapshot: WorkspaceAgentsSnapshot = LOADING
  #listeners = new Set<() => void>()
  #overseer: AgentsOverseer | undefined
  #leases: Promise<Disposable>[] = []
  // Bumped by every start and stop, so what a run asked for can tell it is stale.
  #run = 0
  #retry: ReturnType<typeof setTimeout> | undefined

  // What this run has read: the runs, by id, once listed, and whether they are all of them.
  #chats: Map<number, AiChatMetadata> | undefined
  #allRuns = false
  // Updates that arrived before the list, applied over it.
  #early = new Map<number, AiChatMetadata | null>()
  // The actions waiting on a person, by id, and the chat each was made from, by the action's id: as
  // the action says, or as a message of the chat's that names it does, as not every action says.
  #pending = new Set<number>()
  #actionChats = new Map<number, number>()
  // The workspace's gadgets' titles, by id, and whether all have been listed.
  #gadgets = new Map<number, string>()
  #gadgetsListed = false
  // Its agent spawners, once read, and whether they are being read, or are to be again after.
  #spawners: AgentSpawnerInfo[] | undefined
  #readingSpawners = false
  #spawnersAgain = false
  #setups: AgentSetup[] = []
  #setUpRead = false

  constructor(
    private readonly open: () => AgentsOverseer,
    private readonly options: WorkspaceAgentsOptions = {},
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
    this.#pending = new Set()
    this.#actionChats = new Map()
    this.#gadgets = new Map()
    this.#gadgetsListed = false
    this.#spawners = undefined
    this.#readingSpawners = this.#spawnersAgain = false
    let overseer: AgentsOverseer
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
        metadata: (chat) => live(() => this.#updated(chat)),
        deleted: (chatId) => live(() => this.#deleted(chatId)),
        message: (message) => live(() => this.#message(message)),
      })),
      overseer.subscribeToActions(new ActionUpdates((record) => live(() => this.#action(record)))),
      overseer.subscribeToWorkpieces(new GadgetList({
        entry: (summary) => live(() => this.#gadget(run, summary)),
        removed: (id) => live(() => this.#gadgetRemoved(id)),
        ready: () => live(() => this.#gadgetsReady()),
      })),
    ]
    for (const lease of this.#leases) lease.catch((error: unknown) => live(() => this.#fail(error)))

    overseer.listChats({ kind: 'runs', limit: RUNS_READ }).then(
      (chats) => live(() => {
        this.#chats = new Map(chats.map((chat) => [chat.id, chat]))
        this.#allRuns = chats.length < RUNS_READ
        for (const [id, chat] of this.#early) {
          if (chat) this.#chats.set(id, chat)
          else this.#chats.delete(id)
        }
        this.#early.clear()
        this.#publishReady()
      }),
      (error: unknown) => live(() => this.#fail(error)),
    )
    // Read as well as subscribed to: those waiting already are not sent again.
    overseer.listActions({ filter: 'pending' }).then(
      (page) => live(() => {
        for (const record of page.entries) this.#action(record)
      }),
      // A run that waits on an action still says so once it stops for it.
      () => {},
    )
    this.#readSpawners(run)

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

  #updated(chat: AiChatMetadata) {
    // People's chats are the Chats tab's.
    if (!isAgentRun(chat)) return
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

  #message(message: AiChatMessage) {
    if (message.type !== 'action') return
    this.#actionChats.set(message.actionId, message.chatId)
    if (message.actionLog) this.#action(message.actionLog)
    // The chat an action waiting on a person was made from, which the action may not say.
    else if (this.#pending.has(message.actionId)) this.#publishReady()
  }

  #action(record: ActionLogEntry) {
    if (record.chatId !== undefined) this.#actionChats.set(record.id, record.chatId)
    const had = this.#pending.has(record.id)
    if (record.state === 'pending') this.#pending.add(record.id)
    else this.#pending.delete(record.id)
    if (had !== this.#pending.has(record.id)) this.#publishReady()
  }

  #gadget(run: number, summary: WorkpieceSummary) {
    // A gadget still to be kept in a chat has no agents the workspace has.
    if (summary.type !== 'gadget' || summary.chatId !== undefined) return
    const before = this.#gadgets.get(summary.id)
    this.#gadgets.set(summary.id, summary.title)
    if (!this.#gadgetsListed) return
    if (before !== summary.title) this.#compose()
    // Its bindings change as a chat's changes to it are kept, which moves its head.
    this.#readSpawners(run)
  }

  #gadgetRemoved(id: number) {
    if (this.#gadgets.delete(id)) this.#compose()
  }

  #gadgetsReady() {
    if (this.#gadgetsListed) return
    this.#gadgetsListed = true
    this.#compose()
  }

  // One read at a time: what changes meanwhile is read once, after it.
  #readSpawners(run: number) {
    const overseer = this.#overseer
    if (!overseer) return
    if (this.#readingSpawners) {
      this.#spawnersAgain = true
      return
    }
    this.#readingSpawners = true
    overseer.listAgentSpawners().then(
      (spawners) => {
        if (run === this.#run) this.#spawners = spawners
      },
      // Its agents are still known by their runs.
      () => {
        if (run === this.#run) this.#spawners ??= []
      },
    ).finally(() => {
      if (run !== this.#run) return
      this.#readingSpawners = false
      this.#compose()
      if (!this.#spawnersAgain) return
      this.#spawnersAgain = false
      this.#readSpawners(run)
    })
  }

  // What each agent is, once both its spawners and the gadgets they are bound to are known.
  #compose() {
    if (!this.#gadgetsListed || !this.#spawners) return
    this.#setups = setupsOf(this.#spawners, this.#gadgets)
    this.#setUpRead = true
    this.#publishReady()
  }

  #publishReady() {
    if (!this.#chats) return
    const actionsWaiting = new Set<number>()
    for (const id of this.#pending) {
      const chatId = this.#actionChats.get(id)
      if (chatId !== undefined) actionsWaiting.add(chatId)
    }
    this.#publish({
      status: 'ready',
      agents: agentsOf([...this.#chats.values()], { pending: actionsWaiting }, this.#setups),
      setUpRead: this.#setUpRead,
      allRuns: this.#allRuns,
      actionsWaiting,
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

  #publish(snapshot: WorkspaceAgentsSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}
