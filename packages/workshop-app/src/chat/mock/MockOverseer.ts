import type {
  ActionLogEntry,
  ActionsSubscriber,
  AiChatHistoryPage,
  AiChatMessage,
  AiChatMetadata,
  AiChatSubscriber,
  ChatAttachmentHandle,
  ChatAttachmentRef,
  PresenceSubscriber,
  SlashCommandRequest,
} from '@gadgets/workshop-shared/api'
import type { ActionKind, GitOid } from '@gadgets/workshop-shared/gatekeeper'
import { DISCONNECTED, MockGadget, RESTARTED, type Handle } from './MockGadget'
import { ScriptPlayer } from './ScriptPlayer'
import { AGENT, stamp, VIEWER, type MessageSource, type Scenario, type ScriptStep } from './scenario'

// Who else has the workspace open, beside the viewer.
const COLLABORATORS = [
  { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' },
  { type: 'user', id: 'alan@example.com', name: 'Alan Turing' },
] as const

const CHAT_ID = 0

type ChatEvents = Pick<AiChatSubscriber, 'streamGeneration' | 'metadata' | 'message' | 'stream'>
type ActionEvents = Pick<ActionsSubscriber, 'entry'>
type ActionMessage = Extract<AiChatMessage, { type: 'action' }>

const lease = (release: () => void) => Promise.resolve({ [Symbol.dispose]: release })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A workspace's Overseer for one scripted chat, holding what a server would: the messages, the
 * chat's metadata and who is subscribed. It answers the calls a chat makes and reports them to the
 * scenario's script as triggers, so the script can have the agent react.
 *
 * Updates leave the way the real server sends them: a decided action or a toggled hook through
 * the actions subscription, a resolved connection request as its chat message again.
 */
export class MockOverseer {
  readonly player: ScriptPlayer
  #messages: AiChatMessage[]
  #metadata: AiChatMetadata
  #chatSubscribers = new Set<ChatEvents>()
  #actionSubscribers = new Set<ActionEvents>()
  // Standing approvals, as `gatekeeperId:tag`.
  #rules = new Set<string>()
  #gadgets = new Map<number, MockGadget>()
  #files: Record<string, Uint8Array>
  #blobs = new Map<GitOid, Uint8Array>()
  #refusals: string[]
  #sendDelay: number
  #handles = new Set<Handle>()
  // Bumped by each restart, as the server's stream generation is.
  #generation = 1
  // While the workspace is restarting, until this time, calls wait for it to be back.
  #downUntil = 0
  // While the app's connection is down: how to have it back at once.
  #offline: { reconnect: () => void } | undefined

  /**
   * Told when the app's connection to the backend drops, and when it is back, as for a
   * `disconnect` step. Whoever plays the scenario stands in for the app's connection, making a new
   * API and connecting what holds stubs again.
   */
  onConnection?: (connected: boolean) => void

  constructor(scenario: Scenario) {
    this.#messages = [...scenario.history]
    this.#refusals = [...(scenario.refusals ?? [])]
    this.#sendDelay = scenario.sendDelay ?? 0
    // A copy, since files sent in the chat join them, and a restart begins from the scenario again.
    this.#files = { ...scenario.files }
    this.#metadata = {
      id: CHAT_ID,
      title: scenario.title,
      started: scenario.history[0]?.timestamp ?? new Date(0),
      lastActive: scenario.history.at(-1)?.timestamp ?? new Date(0),
    }
    this.player = new ScriptPlayer(scenario.script, (step) => this.#run(step))
  }

  /**
   * What `openWorkspace` gives out: this workspace, as an RPC stub would be. When it restarts (a
   * `restart` step), each handle out says it is broken and its calls fail, and calls through a
   * new one wait until it is back.
   */
  open(): this {
    // Over a dropped connection, a stub is broken from the start.
    const handle: Handle = { broken: this.#offline && DISCONNECTED, onBroken: new Set() }
    this.#handles.add(handle)
    return new Proxy(this, {
      get: (target, name) => {
        if (name === Symbol.dispose) return () => void this.#handles.delete(handle)
        if (name === 'onRpcBroken') {
          return (callback: (error: unknown) => void) => (handle.broken ? callback(handle.broken) : handle.onBroken.add(callback))
        }
        if (name === 'getGadget') return (id: number) => this.#gadget(id).open(handle)
        const value: unknown = Reflect.get(target, name, target)
        if (typeof value !== 'function' || typeof name === 'symbol' || name === 'then') return value
        return async (...args: unknown[]) => {
          if (handle.broken) throw handle.broken
          await this.#backUp()
          if (handle.broken) throw handle.broken
          return (value as (...args: unknown[]) => unknown).apply(target, args)
        }
      },
    })
  }

  /** Waits for a workspace that is restarting to be back. */
  async #backUp() {
    const wait = this.#downUntil - Date.now()
    if (wait > 0) await sleep(wait)
  }

  /** Any id is a gadget: the scenarios' outputs are all documents. */
  #gadget(id: number) {
    let gadget = this.#gadgets.get(id)
    if (!gadget) this.#gadgets.set(id, (gadget = new MockGadget('Q3 platform review', () => this.#backUp())))
    return gadget
  }

  /** The scenarios' gadgets keep their code. */
  subscribeToWorkpieces() {
    return lease(() => {})
  }

  subscribeToPresence(subscriber: PresenceSubscriber) {
    subscriber.init([VIEWER, ...COLLABORATORS].map((user) => ({ key: user.id, user, role: 'build' })))
    return lease(() => {})
  }

  async listChats(): Promise<AiChatMetadata[]> {
    return [this.#metadata]
  }

  async getChatHistory(chatId: number, beforeSequence?: number, limit?: number): Promise<AiChatHistoryPage> {
    const older = this.#messages.filter(({ sequence }) => beforeSequence === undefined || sequence < beforeSequence)
    if (chatId !== CHAT_ID || limit === undefined) return { messages: chatId === CHAT_ID ? older : [] }
    const messages = older.slice(-limit)
    return { messages, nextBeforeSequence: messages.length < older.length ? messages[0].sequence : undefined }
  }

  subscribeToChat(subscriber: ChatEvents) {
    this.#chatSubscribers.add(subscriber)
    subscriber.streamGeneration(this.#generation)
    this.player.fire('onStart')
    return lease(() => this.#chatSubscribers.delete(subscriber))
  }

  subscribeToActions(subscriber: ActionEvents) {
    this.#actionSubscribers.add(subscriber)
    return lease(() => this.#actionSubscribers.delete(subscriber))
  }

  /** Kept by a made-up OID, until a message carries it. */
  async uploadBlob(content: Uint8Array): Promise<GitOid> {
    const oid = crypto.randomUUID()
    this.#blobs.set(oid, content)
    return oid
  }

  async sendChatMessage(
    _chatId: number,
    message: string | SlashCommandRequest,
    _modelId?: string | null,
    _capsules?: unknown,
    handles?: ChatAttachmentHandle[],
  ) {
    if (this.#sendDelay) await new Promise((resolve) => setTimeout(resolve, this.#sendDelay))
    const refusal = this.#refusals.shift()
    if (refusal !== undefined) throw new Error(refusal)
    const attachments = handles?.map((handle): ChatAttachmentRef => {
      const content = 'oid' in handle ? this.#blobs.get(handle.oid) : undefined
      if (!('oid' in handle) || !content) throw new Error('Chat attachment not found.')
      const id = crypto.randomUUID()
      this.#files[id] = content
      const image = handle.mimeType.startsWith('image/')
      return { id, oid: handle.oid, mimeType: handle.mimeType, name: handle.name, size: content.byteLength, content: image ? content : undefined }
    })
    if (typeof message !== 'string') {
      this.#append({ type: 'slashCommand', request: message, author: VIEWER })
    } else if (attachments?.length) {
      if (this.#metadata.activeAgent) throw new Error('The agent is still running.')
      this.#append({ type: 'message', message, author: VIEWER, attachments })
    } else if (this.#metadata.activeAgent) {
      // A running agent is steered: the message waits in the metadata until the script reads it.
      const queuedSteers = [...(this.#metadata.queuedSteers ?? []), { text: message, author: VIEWER }]
      this.#setMetadata({ queuedSteers })
    } else {
      this.#append({ type: 'message', message, author: VIEWER })
    }
    this.player.fire('onSend')
  }

  async approveAction(id: number) {
    this.#resolve(id, { state: 'approved', resolvedBy: VIEWER })
    this.player.fire('onApprove')
  }

  async rejectAction(id: number) {
    this.#resolve(id, { state: 'rejected', resolvedBy: VIEWER })
    this.player.fire('onDeny')
  }

  /** Approves what is pending under the new rule, and what the script queues under it later. */
  async setAutoApprovedActionKind(gatekeeperId: number, actionKind: ActionKind) {
    this.#rules.add(`${gatekeeperId}:${actionKind.tag}`)
    const pending = this.#messages.filter((message) => this.#autoApproves(message))
    for (const { actionId } of pending) this.#resolve(actionId, { state: 'approved', resolvedBy: VIEWER, autoApproved: true })
    if (pending.length) this.player.fire('onApprove')
  }

  async enableHook(id: number) {
    this.#setHookEnabled(id, true)
  }

  async disableHook(id: number) {
    this.#setHookEnabled(id, false)
  }

  async retryAgent() {
    this.player.fire('onRetry')
  }

  async stopAgent() {
    this.#setMetadata({ activeAgent: undefined, queuedSteers: undefined })
    this.player.fire('onStop')
  }

  async acceptConnectionRequest(requestId: string, result: { gatekeeperId: number }) {
    this.#resolveConnection(requestId, { state: 'accepted', gatekeeperId: result.gatekeeperId })
    this.player.fire('onAcceptConnection')
  }

  async getChatAttachmentContent(_chatId: number, id: string): Promise<Uint8Array> {
    const bytes = this.#files[id]
    if (!bytes) throw new Error(`No attachment ${id}`)
    return bytes
  }

  async setChatTitle(_chatId: number, title: string) {
    this.#setMetadata({ title })
  }

  async denyConnectionRequest(requestId: string) {
    this.#resolveConnection(requestId, { state: 'denied' })
    this.player.fire('onDenyConnection')
  }

  #run(step: ScriptStep) {
    if ('restart' in step) this.#restart(step.restart)
    else if ('disconnect' in step) this.#disconnect(step.disconnect)
    else if ('stream' in step) this.#chatSubscribers.forEach((subscriber) => subscriber.stream(CHAT_ID, step.stream))
    else if ('message' in step) this.#append(step.message)
    else if ('metadata' in step) this.#setMetadata(step.metadata)
    else if (step.agentActive) this.#setMetadata({ activeAgent: AGENT })
    else this.#endTurn()
  }

  /**
   * Restarts the workspace, which is back after `downFor` milliseconds, as a deploy or a crash
   * would: every handle out breaks, and whoever was subscribed is forgotten. What the chat holds
   * is kept, as the server's storage is.
   */
  #restart(downFor: number) {
    this.#generation++
    this.#downUntil = Date.now() + downFor
    this.#breakHandles(RESTARTED)
  }

  /**
   * Drops the app's connection, which is back after `downFor` milliseconds or when asked
   * (`reconnectNow`). The workspace carries on meanwhile, as the server does, unheard: whoever was
   * subscribed went with the connection, and every handle out breaks, as does any made meanwhile.
   */
  #disconnect(downFor: number) {
    if (this.#offline) return
    const timer = setTimeout(() => this.reconnectNow(), downFor)
    this.#offline = {
      reconnect: () => {
        clearTimeout(timer)
        this.#offline = undefined
        this.onConnection?.(true)
      },
    }
    this.onConnection?.(false)
    this.#breakHandles(DISCONNECTED)
  }

  /** Has a dropped connection back now. */
  reconnectNow() {
    this.#offline?.reconnect()
  }

  #breakHandles(error: Error) {
    this.#chatSubscribers.clear()
    this.#actionSubscribers.clear()
    const handles = [...this.#handles]
    this.#handles.clear()
    for (const handle of handles) {
      handle.broken = error
      handle.onBroken.forEach((callback) => callback(error))
    }
  }

  #endTurn() {
    const unread = this.#metadata.queuedSteers ?? []
    this.#setMetadata({ activeAgent: undefined, queuedSteers: undefined })
    // A steer the agent never read prompts the next turn as an ordinary message.
    for (const { text, author } of unread) this.#append({ type: 'message', message: text, author })
    if (unread.length) this.player.fire('onSend')
  }

  #append(source: MessageSource) {
    let message = stamp(source, (this.#messages.at(-1)?.sequence ?? -1) + 1)
    message.timestamp = new Date()
    if (this.#autoApproves(message)) {
      message = { ...message, actionLog: { ...message.actionLog, state: 'approved', resolvedBy: VIEWER, autoApproved: true } }
    }
    this.#messages.push(message)
    this.#deliver(message)
  }

  #autoApproves(message: AiChatMessage): message is ActionMessage & { actionLog: ActionLogEntry & { type: 'action' } } {
    if (message.type !== 'action' || message.actionLog?.type !== 'action') return false
    const { state, gatekeeperId, description } = message.actionLog
    return state === 'pending' && description.autoApprovable === true &&
      this.#rules.has(`${gatekeeperId}:${description.actionKind?.tag}`)
  }

  #deliver(message: AiChatMessage) {
    this.#chatSubscribers.forEach((subscriber) => subscriber.message(message))
  }

  #setMetadata(change: Partial<AiChatMetadata>) {
    this.#metadata = { ...this.#metadata, ...change, lastActive: new Date() }
    this.#chatSubscribers.forEach((subscriber) => subscriber.metadata(this.#metadata))
  }

  #replace(message: AiChatMessage) {
    this.#messages = this.#messages.map((existing) => (existing.sequence === message.sequence ? message : existing))
  }

  #action(matches: (log: ActionLogEntry) => boolean) {
    const message = this.#messages.find(
      (candidate): candidate is ActionMessage => candidate.type === 'action' && !!candidate.actionLog && matches(candidate.actionLog),
    )
    if (!message?.actionLog) throw new Error('No such action.')
    return { message, log: message.actionLog }
  }

  #updateAction(message: ActionMessage, actionLog: ActionLogEntry) {
    this.#replace({ ...message, actionLog })
    this.#actionSubscribers.forEach((subscriber) => subscriber.entry(actionLog))
  }

  #resolve(id: number, change: Pick<ActionLogEntry & { type: 'action' }, 'state' | 'resolvedBy' | 'autoApproved'>) {
    const { message, log } = this.#action((candidate) => candidate.id === id)
    if (log.type !== 'action' || log.state !== 'pending') throw new Error(`Action is not pending: ${id}`)
    this.#updateAction(message, { ...log, ...change, appliedAt: new Date() })
  }

  #setHookEnabled(hookId: number, enabled: boolean) {
    const { message, log } = this.#action((candidate) => candidate.type === 'bindHook' && candidate.hookId === hookId)
    if (log.type === 'bindHook') this.#updateAction(message, { ...log, enabled })
  }

  #resolveConnection(
    requestId: string,
    change: Pick<Extract<AiChatMessage, { type: 'connectionRequest' }>, 'state' | 'gatekeeperId'>,
  ) {
    const request = this.#messages.find((message) => message.type === 'connectionRequest' && message.requestId === requestId)
    if (request?.type !== 'connectionRequest' || request.state !== 'pending') throw new Error('No such pending request.')
    const resolved = { ...request, ...change }
    this.#replace(resolved)
    this.#deliver(resolved)
  }
}
