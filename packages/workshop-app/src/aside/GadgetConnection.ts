import { RpcTarget, newMessagePortRpcSession, type RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AiChatMetadata,
  AiChatSubscriber,
  Overseer,
  PresenceParticipant,
  PresenceSubscriber,
  UiBundle,
  WorkpieceSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import type { CodeChange } from '@gadgets/workshop-shared/code-change'
import { ESCAPE_MESSAGE, HANDSHAKE_MESSAGE, gadgetPage } from './gadgetSandbox'

/** A gadget's UI, as far as it has got. */
export type GadgetUi =
  | { status: 'loading' }
  /**
   * The page to show it in a frame. `load` is different each time it is loaded, for a frame that
   * is made again with it: its page starts over, and connects again.
   */
  | { status: 'ready'; page: string; load: number }
  /** The gadget has no UI: it is new, or an agent with no code. */
  | { status: 'none' }
  | { status: 'failed'; message: string }

export type GadgetSnapshot = {
  ui: GadgetUi
  /** Who else has the gadget's workspace open, each once. */
  people: AiChatAuthorInfo[]
  /** The gadget's title as it is now, once the workspace has said. */
  title?: string
}

/** The part of a gadget the pane uses, and the lease that must be disposed. */
export type GadgetHandle = {
  getUiBundle(chatId?: number): Promise<UiBundle | null>
  /** Its server side, for its page to call. */
  connectToGadget(chatId?: number): Promise<Disposable>
} & Disposable

/** The part of a workspace's Overseer the pane uses, and the lease that must be disposed. */
export type GadgetOverseer = {
  getGadget(id: number): GadgetHandle
  subscribeToPresence(subscriber: Parameters<RpcStub<Overseer>['subscribeToPresence']>[0]): Promise<Disposable>
  subscribeToChat(subscriber: Parameters<RpcStub<Overseer>['subscribeToChat']>[0]): Promise<Disposable>
  subscribeToWorkpieces(subscriber: Parameters<RpcStub<Overseer>['subscribeToWorkpieces']>[0]): Promise<Disposable>
} & Disposable

export type GadgetConnectionOptions = {
  /** Shows the gadget with the changes proposed in this chat. */
  chatId?: number
  /** The signed-in user, who is not among the `people`. */
  viewerId?: string
  /** Escape was pressed in the gadget's page, which keeps its keys from the app. */
  onEscape?: () => void
}

// Not a latency budget: past this, the reply is taken to be never coming, and a retry is offered.
const UI_TIMEOUT = 20_000
// The agent edits a file at a time, often several in a row: the gadget is loaded again once they
// have stopped coming for this long, not for each.
const REFRESH_DELAY = 300
const LOADING: GadgetUi = { status: 'loading' }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What the server calls as people open and leave the workspace. A class, for a single stub. */
class PresenceListener extends RpcTarget implements PresenceSubscriber {
  constructor(private readonly changed: (participants: Map<string, PresenceParticipant>) => void) {
    super()
  }

  #participants = new Map<string, PresenceParticipant>()

  init(participants: PresenceParticipant[]) {
    this.#participants = new Map(participants.map((participant) => [participant.key, participant]))
    this.changed(this.#participants)
  }

  add(participant: PresenceParticipant) {
    this.#participants.set(participant.key, participant)
    this.changed(this.#participants)
  }

  remove(key: string) {
    this.#participants.delete(key)
    this.changed(this.#participants)
  }
}

/**
 * What the server calls with chat activity, of which only what changes the gadget's code in the
 * chat it is shown with is of interest: a change to one of its files, and the chat's changes
 * being accepted, reverted or discarded, which starts the chat's stream of changes over.
 */
class ChangeListener extends RpcTarget implements AiChatSubscriber {
  constructor(
    private readonly chatId: number,
    private readonly gadgetId: number,
    private readonly changed: () => void,
  ) {
    super()
  }

  #generation: number | undefined

  metadata(chat: AiChatMetadata) {
    if (chat.id !== this.chatId) return
    const generation = chat.codeBase?.generation ?? 0
    if (this.#generation !== undefined && generation !== this.#generation) this.changed()
    this.#generation = generation
  }

  changeApplied(chatId: number, _generation: number, _revision: number, _author: AiChatAuthorInfo, change: CodeChange) {
    if (chatId === this.chatId && Object.hasOwn(change, this.gadgetId)) this.changed()
  }

  streamGeneration() {}
  message() {}
  stream() {}
  deleted() {}
}

/** What the server calls as the workspace's workpieces change: here, the gadget's head moving, and its title. */
class HeadListener extends RpcTarget implements WorkpiecesSubscriber {
  constructor(
    private readonly gadgetId: number,
    private readonly changed: () => void,
    private readonly titled: (title: string) => void,
  ) {
    super()
  }

  #head: { commitId?: string } | undefined

  entry(summary: WorkpieceSummary) {
    if (summary.id !== this.gadgetId || summary.type !== 'gadget') return
    this.titled(summary.title)
    // Its other changes, such as a new title, leave the code as it was.
    if (this.#head && summary.commitId !== this.#head.commitId) this.changed()
    this.#head = { commitId: summary.commitId }
  }

  removed() {}
  ready() {}
}

/**
 * One gadget's UI, live: its code, loaded into a page for a sandboxed frame, and the page
 * connected to the gadget's server side once it asks. When its code changes, in the chat it is
 * shown with or by its head moving, it is loaded again, and the new page takes the old one's place
 * once it is there. Observable through `subscribe`/`getSnapshot` (for `useSyncExternalStore`).
 */
export class GadgetConnection {
  #listeners = new Set<() => void>()
  #snapshot: GadgetSnapshot = { ui: LOADING, people: [] }
  #run = 0
  #loads = 0
  #overseer: GadgetOverseer | undefined
  #gadget: GadgetHandle | undefined
  #subscriptions: Promise<Disposable>[] = []
  #refresh: ReturnType<typeof setTimeout> | undefined
  // The page's connection to the gadget's server side, and which handshake made it: one that is
  // overtaken by another, or by a reload, is let go as soon as it is made.
  #handshakes = 0
  #link: { session: Disposable; server: Disposable } | undefined
  #frame: () => Window | null | undefined = () => undefined

  /** `open` connects to the gadget's workspace; the connection disposes what it returns. */
  constructor(
    private readonly open: () => GadgetOverseer,
    private readonly workpieceId: number,
    private readonly options: GadgetConnectionOptions = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  /**
   * Says which window the page is showing in. Only that one is listened to: anything can post to
   * this window.
   */
  showIn = (frame: () => Window | null | undefined) => {
    this.#frame = frame
  }

  start() {
    const run = ++this.#run
    const overseer = (this.#overseer = this.open())
    this.#gadget = overseer.getGadget(this.workpieceId)
    window.addEventListener('message', this.#received)
    const changed = () => {
      if (run !== this.#run) return
      clearTimeout(this.#refresh)
      this.#refresh = setTimeout(() => void this.#load(run, true), REFRESH_DELAY)
    }
    const { chatId } = this.options
    // Before the code is loaded, so that no change can come between.
    this.#subscriptions = [
      overseer.subscribeToWorkpieces(new HeadListener(this.workpieceId, changed, (title) => {
        if (run === this.#run && title !== this.#snapshot.title) this.#publish({ title })
      })),
      ...(chatId === undefined ? [] : [overseer.subscribeToChat(new ChangeListener(chatId, this.workpieceId, changed))]),
      overseer.subscribeToPresence(
        new PresenceListener((participants) => {
          if (run === this.#run) this.#seen(participants)
        }),
      ),
    ]
    // Each is extra: the gadget shows without them.
    for (const subscription of this.#subscriptions) subscription.catch(() => {})
    void this.#load(run)
  }

  stop() {
    this.#run++
    clearTimeout(this.#refresh)
    window.removeEventListener('message', this.#received)
    this.#unlink()
    for (const subscription of this.#subscriptions.splice(0)) {
      void subscription.then(
        (lease) => lease[Symbol.dispose](),
        () => {},
      )
    }
    this.#gadget?.[Symbol.dispose]()
    this.#overseer?.[Symbol.dispose]()
    this.#gadget = this.#overseer = undefined
  }

  /** Loads the UI again, and starts its page over. */
  reload = () => {
    clearTimeout(this.#refresh)
    if (this.#gadget) void this.#load(this.#run)
  }

  #publish(snapshot: Partial<GadgetSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...snapshot }
    for (const listener of this.#listeners) listener()
  }

  #seen(participants: Map<string, PresenceParticipant>) {
    const people = new Map<string, AiChatAuthorInfo>()
    for (const { user } of participants.values()) if (user.id !== this.options.viewerId) people.set(user.id, user)
    const before = this.#snapshot.people
    if (before.length === people.size && before.every(({ id }) => people.has(id))) return
    this.#publish({ people: [...people.values()] })
  }

  /**
   * Loads the UI into a new page. `quietly`, for code that changed, the page shown stays until the
   * new one is there, connected as it was: the new page's handshake lets that connection go.
   */
  async #load(run: number, quietly = false) {
    const load = ++this.#loads
    const current = () => run === this.#run && load === this.#loads
    if (!quietly) {
      this.#unlink()
      this.#publish({ ui: LOADING })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const bundle = await Promise.race([
        this.#gadget!.getUiBundle(this.options.chatId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out loading this view.')), UI_TIMEOUT)
        }),
      ])
      if (!current()) return
      if (!bundle) this.#unlink()
      this.#publish({ ui: bundle ? { status: 'ready', page: gadgetPage(bundle.jsCode), load } : { status: 'none' } })
    } catch (error) {
      if (!current()) return
      this.#unlink()
      this.#publish({ ui: { status: 'failed', message: messageOf(error) } })
    } finally {
      clearTimeout(timer)
    }
  }

  #received = (event: MessageEvent) => {
    // The frame has no origin, which reads as "null". It cannot browse away, but just in case.
    if (!event.source || event.source !== this.#frame() || event.origin !== 'null') return
    if (event.data === HANDSHAKE_MESSAGE && event.ports[0]) void this.#connect(event.ports[0])
    else if (event.data?.type === ESCAPE_MESSAGE) this.options.onEscape?.()
  }

  async #connect(port: MessagePort) {
    this.#unlink()
    const handshake = this.#handshakes
    try {
      const server = await this.#gadget!.connectToGadget(this.options.chatId)
      if (handshake !== this.#handshakes) {
        server[Symbol.dispose]()
        port.close()
        return
      }
      this.#link = { server, session: newMessagePortRpcSession(port, server) }
    } catch (error) {
      port.close()
      if (handshake === this.#handshakes) this.#publish({ ui: { status: 'failed', message: `Couldn’t connect to the gadget: ${messageOf(error)}` } })
    }
  }

  #unlink() {
    this.#handshakes++
    this.#link?.session[Symbol.dispose]()
    this.#link?.server[Symbol.dispose]()
    this.#link = undefined
  }
}
