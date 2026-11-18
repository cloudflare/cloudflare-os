import { RpcTarget, type RpcStub } from 'capnweb'
import {
  getOpenWorkspaceErrorCode,
  OPEN_WORKSPACE_ERROR_CODES,
  type ActionLogEntry,
  type AiChatMessage,
  type AiChatMetadata,
  type GadgetBindingInfo,
  type GatekeeperCreationSpec,
  type Overseer,
  type WorkpieceSummary,
  type WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import { ActionUpdates, ChatSubscriber } from '@/chat/ChatSubscriber'
import { agentsOf, isAgentRun, isFailure, type Agent, type AgentSetup } from './agents'

export type WorkspaceAgentsSnapshot =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      agents: Agent[]
      /**
       * What the gadgets say of the agents they start has been read: until then an agent is
       * known only by its runs, with no gadget, and one that has not run is not known.
       */
      setUpRead: boolean
    }

/**
 * The part of a workspace's Overseer the agents use, and the lease that must be disposed. The
 * subscribe calls take the subscriber object itself, as a call through a stub does.
 */
export type AgentsOverseer = Pick<Overseer, 'listChats' | 'listActions' | 'getChatHistory'> & {
  subscribeToChat(subscriber: Parameters<RpcStub<Overseer>['subscribeToChat']>[0]): Promise<Disposable>
  subscribeToActions(subscriber: Parameters<RpcStub<Overseer>['subscribeToActions']>[0]): Promise<Disposable>
  subscribeToWorkpieces(subscriber: WorkpiecesSubscriber & RpcTarget): Promise<Disposable>
  getGadget(id: number): { listBindings(): Promise<GadgetBindingInfo[]> } & Disposable
  getGatekeeperById(id: number): { getCreationSpec(): Promise<GatekeeperCreationSpec> } & Disposable
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
} & Disposable

export type WorkspaceAgentsOptions = {
  /** The app's connection, which may be `down`: what fails meanwhile is not said, as `restart()` follows. */
  connection?: { readonly down: boolean }
}

const LOADING: WorkspaceAgentsSnapshot = { status: 'loading' }
// After the workspace was lost, how long until it is opened again.
const RETRY_DELAY = 1000
// How many of the latest runs that have ended are read for whether they failed, and how many at a time.
const TAILS = 30
const TAILS_AT_ONCE = 4
// How many of each one's last messages are read.
const TAIL = 10
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
 * A workspace's agents, live: the runs among its chats and how each stands (`subscribeToChat()`,
 * with the actions waiting on a person from `subscribeToActions()`, and whether the latest runs
 * that ended failed, from their last message), with what its gadgets say of the agents they start
 * (their bindings, and how each agent was made, `getCreationSpec()`). Observable through
 * `subscribe`/`getSnapshot`. Nothing happens until `start()`; `stop()` lets the workspace go, and
 * `restart()` starts over on a new connection, keeping what is shown meanwhile.
 *
 * Only the first page of the actions waiting is read, and only the latest runs that ended are
 * read for whether they failed, and for which actions are theirs where an action does not say
 * which chat it was made from: one older that failed and was never run again says Done.
 */
export class WorkspaceAgents {
  #snapshot: WorkspaceAgentsSnapshot = LOADING
  #listeners = new Set<() => void>()
  #overseer: AgentsOverseer | undefined
  #leases: Promise<Disposable>[] = []
  // Bumped by every start and stop, so what a run asked for can tell it is stale.
  #run = 0
  #retry: ReturnType<typeof setTimeout> | undefined

  // What this run has read: the agents' runs, by id, once listed.
  #chats: Map<number, AiChatMetadata> | undefined
  // Updates that arrived before the list, applied over it.
  #early = new Map<number, AiChatMetadata | null>()
  // The actions waiting on a person, by id, and the chat each was made from, by the action's id: as
  // the action says, or as a message of the chat's that names it does, as not every action says.
  #pending = new Set<number>()
  #actionChats = new Map<number, number>()
  #failed = new Set<number>()
  #tailsRead = new Set<number>()
  #tailsReading = 0
  // The workspace's gadgets, by id, and whether all have been listed.
  #gadgets = new Map<number, string>()
  #gadgetsListed = false
  // The agents each gadget starts, by the gadget's id, once read.
  #bindings = new Map<number, Array<{ name: string; spawnerId: number }>>()
  #specs = new Map<number, Promise<GatekeeperCreationSpec | undefined>>()
  // The same, once each has said.
  #made = new Map<number, GatekeeperCreationSpec | undefined>()
  #setups = new Map<number, AgentSetup>()
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
    this.#tailsRead = new Set()
    this.#tailsReading = 0
    this.#gadgets = new Map()
    this.#gadgetsListed = false
    this.#bindings = new Map()
    this.#specs = new Map()
    this.#made = new Map()
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
        metadata: (chat) => live(() => this.#updated(run, chat)),
        deleted: (chatId) => live(() => this.#deleted(chatId)),
        message: (message) => live(() => this.#message(message)),
      })),
      overseer.subscribeToActions(new ActionUpdates((record) => live(() => this.#action(record)))),
      overseer.subscribeToWorkpieces(new GadgetList({
        entry: (summary) => live(() => this.#gadget(run, summary)),
        removed: (id) => live(() => this.#gadgetRemoved(id)),
        ready: () => live(() => this.#gadgetsReady(run)),
      })),
    ]
    for (const lease of this.#leases) lease.catch((error: unknown) => live(() => this.#fail(error)))

    overseer.listChats().then(
      (chats) => live(() => {
        this.#chats = new Map(chats.filter(isAgentRun).map((chat) => [chat.id, chat]))
        for (const [id, chat] of this.#early) {
          if (chat) this.#chats.set(id, chat)
          else this.#chats.delete(id)
        }
        this.#early.clear()
        this.#publishReady()
        this.#readTails(run)
        this.#nameUnknown(run)
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

  #updated(run: number, chat: AiChatMetadata) {
    if (!isAgentRun(chat)) return
    // A turn under way has not failed, whatever the last one did.
    if (chat.activeAgent) this.#failed.delete(chat.id)
    if (!this.#chats) {
      this.#early.set(chat.id, chat)
      return
    }
    const before = this.#chats.get(chat.id)
    this.#chats.set(chat.id, chat)
    if (before === undefined && chat.spawnerId !== undefined) this.#nameUnknown(run)
    this.#publishReady()
  }

  #deleted(chatId: number) {
    if (!this.#chats) {
      this.#early.set(chatId, null)
      return
    }
    if (!this.#chats.delete(chatId)) return
    this.#failed.delete(chatId)
    this.#publishReady()
  }

  #message(message: AiChatMessage) {
    const known = this.#chats?.has(message.chatId)
    if (message.type === 'action') {
      this.#actionChats.set(message.actionId, message.chatId)
      if (message.actionLog) this.#action(message.actionLog)
      return
    }
    // What the agent says once a turn has failed is a turn that did not: an error is the last
    // thing a failed turn says.
    if (isFailure(message)) this.#failed.add(message.chatId)
    else if (message.type === 'message') this.#failed.delete(message.chatId)
    else return
    this.#tailsRead.add(message.chatId)
    if (known) this.#publishReady()
  }

  #action(record: ActionLogEntry) {
    if (record.chatId !== undefined) this.#actionChats.set(record.id, record.chatId)
    const had = this.#pending.has(record.id)
    if (record.state === 'pending') this.#pending.add(record.id)
    else this.#pending.delete(record.id)
    if (had !== this.#pending.has(record.id)) this.#publishReady()
  }

  // Whether the latest runs that have ended failed, which only their last message says, and the
  // actions their last messages name, which say which run an action that does not say is.
  #readTails(run: number) {
    const overseer = this.#overseer
    if (!overseer || !this.#chats) return
    const ended = [...this.#chats.values()]
      .filter((chat) => !chat.activeAgent && !chat.awaitingDecision)
      .toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
      .slice(0, TAILS)
      .filter((chat) => !this.#tailsRead.has(chat.id))
    for (const chat of ended) {
      if (this.#tailsReading >= TAILS_AT_ONCE) return
      this.#tailsRead.add(chat.id)
      this.#tailsReading++
      overseer.getChatHistory(chat.id, undefined, TAIL).then(
        ({ messages }) => {
          if (run !== this.#run) return
          for (const message of messages) {
            if (message.type === 'action') this.#actionChats.set(message.actionId, chat.id)
          }
          const last = messages.at(-1)
          if (last && isFailure(last)) this.#failed.add(chat.id)
          this.#publishReady()
        },
        // Left as Done, which is what it most likely is.
        () => {},
      ).finally(() => {
        if (run !== this.#run) return
        this.#tailsReading--
        this.#readTails(run)
      })
    }
  }

  #gadget(run: number, summary: WorkpieceSummary) {
    // A gadget still to be kept in a chat starts no agents the workspace has.
    if (summary.type !== 'gadget' || summary.chatId !== undefined) return
    const before = this.#gadgets.get(summary.id)
    this.#gadgets.set(summary.id, summary.title)
    if (this.#gadgetsListed) {
      // Its bindings change as a chat's changes to it are kept, which moves its head.
      this.#readBindings(run, summary.id)
      if (before !== summary.title) this.#composeSetups()
    }
  }

  #gadgetRemoved(id: number) {
    if (!this.#gadgets.delete(id)) return
    this.#bindings.delete(id)
    this.#composeSetups()
  }

  #gadgetsReady(run: number) {
    if (this.#gadgetsListed) return
    this.#gadgetsListed = true
    const reads = [...this.#gadgets.keys()].map((id) => this.#readBindings(run, id))
    void Promise.all(reads).then(() => {
      if (run !== this.#run) return
      this.#setUpRead = true
      this.#composeSetups()
      this.#nameUnknown(run)
    })
  }

  // The agents a gadget starts: its bindings to a connection with no service that was made as one.
  async #readBindings(run: number, gadgetId: number) {
    const overseer = this.#overseer
    if (!overseer) return
    const gadget = overseer.getGadget(gadgetId)
    try {
      const bindings = await gadget.listBindings()
      const agents = await Promise.all(
        bindings
          .filter((binding) => binding.vendorId === undefined && binding.chatId === undefined)
          .map(async (binding) => ((await this.#spec(binding.target))?.type === 'agentSpawner' ? [{ name: binding.name, spawnerId: binding.target }] : [])),
      )
      if (run !== this.#run) return
      this.#bindings.set(gadgetId, agents.flat())
      if (this.#setUpRead) this.#composeSetups()
    } catch {
      // Its agents are still known by their runs.
    } finally {
      gadget[Symbol.dispose]()
    }
  }

  // How a connection was made, asked once each run.
  #spec(id: number) {
    let spec = this.#specs.get(id)
    if (!spec) {
      spec = (async () => {
        const gatekeeper = this.#overseer!.getGatekeeperById(id)
        try {
          return await gatekeeper.getCreationSpec()
        } catch {
          // One deleted since says nothing, and is known by its runs.
          return undefined
        } finally {
          gatekeeper[Symbol.dispose]()
        }
      })().then((value) => {
        this.#made.set(id, value)
        return value
      }, () => undefined)
      this.#specs.set(id, spec)
    }
    return spec
  }

  // What each agent is, from how it was made, and the gadget that starts it. Each binding's
  // connection has said what it is by the time the gadget's bindings are kept.
  #composeSetups() {
    const setups = new Map<number, AgentSetup>()
    for (const [gadgetId, agents] of this.#bindings) {
      const title = this.#gadgets.get(gadgetId)
      if (title === undefined) continue
      for (const { name, spawnerId } of agents) {
        const spec = this.#made.get(spawnerId)
        if (setups.has(spawnerId) || spec?.type !== 'agentSpawner') continue
        setups.set(spawnerId, {
          spawnerId,
          name: spec.config.displayName,
          ...(spec.modelName ? { model: spec.modelName } : {}),
          gadget: { id: gadgetId, title: title || 'Untitled gadget', bindingName: name },
        })
      }
    }
    // Those only runs name keep what was read of them.
    for (const [spawnerId, setup] of this.#setups) {
      if (!setups.has(spawnerId) && setup.gadget === undefined) setups.set(spawnerId, setup)
    }
    this.#setups = setups
    this.#publishReady()
  }

  // The agents runs name that no gadget starts any more, named and given their model as they were made.
  #nameUnknown(run: number) {
    if (!this.#setUpRead || !this.#chats || !this.#overseer) return
    const unknown = new Set<number>()
    for (const chat of this.#chats.values()) {
      if (chat.spawnerId !== undefined && !this.#setups.has(chat.spawnerId)) unknown.add(chat.spawnerId)
    }
    for (const spawnerId of unknown) {
      void this.#spec(spawnerId).then((spec) => {
        if (run !== this.#run || spec?.type !== 'agentSpawner' || this.#setups.has(spawnerId)) return
        this.#setups = new Map(this.#setups).set(spawnerId, { spawnerId, name: spec.config.displayName, ...(spec.modelName ? { model: spec.modelName } : {}) })
        this.#publishReady()
      })
    }
  }

  #publishReady() {
    if (!this.#chats) return
    const pending = new Set<number>()
    for (const id of this.#pending) {
      const chatId = this.#actionChats.get(id)
      if (chatId !== undefined) pending.add(chatId)
    }
    const signals = { pending, failed: this.#failed }
    this.#publish({ status: 'ready', agents: agentsOf([...this.#chats.values()], signals, [...this.#setups.values()]), setUpRead: this.#setUpRead })
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
