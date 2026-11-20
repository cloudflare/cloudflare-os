import {
  matchesActionHistoryFilter,
  type ActionHistoryFilter,
  type ActionHistoryPage,
  type BoundHookInfo,
  type ActionLogEntry,
  type ActionsSubscriber,
  type AiChatHistoryPage,
  type AiChatMessage,
  type AiChatMetadata,
  type AiChatSubscriber,
  type ChatAttachmentHandle,
  type ChatReadState,
  type ChatAttachmentRef,
  type CodeChangeSubmission,
  type CollaboratorInfo,
  type CommitInfo,
  type FileAtCommit,
  type PresenceSubscriber,
  type SlashCommandRequest,
  type TreeNode,
  type UnreadStateSubscriber,
  type UnreadThread,
  type WorkpiecesSubscriber,
  type WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import type { ActionKind, GitOid } from '@gadgets/workshop-shared/gatekeeper'
import { DISCONNECTED, MockGadget, RESTARTED, UI_CODE, type Handle } from './MockGadget'
import { ScriptPlayer } from './ScriptPlayer'
import { MockChatCode } from './MockChatCode'
import { AGENT, changes, merge, revert, stamp, TEMPLATE, TEMPLATE_TAKEN, VIEWER, type MessageSource, type MockAutomation, type MockChat, type MockWorktree, type Scenario, type ScriptStep } from './scenario'

// Who else has the workspace open, beside the viewer.
const COLLABORATORS = [
  { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' },
  { type: 'user', id: 'alan@example.com', name: 'Alan Turing' },
] as const

const CHAT_ID = 0

/** The one workspace there is, which the fake API lists. */
export const MOCK_WORKSPACE_ID = 'mock'

type ChatEvents = Pick<AiChatSubscriber, 'streamGeneration' | 'metadata' | 'message' | 'stream' | 'deleted'> &
  Partial<Pick<AiChatSubscriber, 'changeApplied'>>
type ReadStateEvents = Pick<UnreadStateSubscriber, 'updated' | 'chatUpdated'>
type ActionEvents = Pick<ActionsSubscriber, 'entry'>
type ActionMessage = Extract<AiChatMessage, { type: 'action' }>

const lease = (release: () => void) => Promise.resolve({ [Symbol.dispose]: release })

// A worktree's three commits, made up from its id: where it started, its agent's last, and as kept.
const worktreeCommit = (id: number, which: 'base' | 'head' | 'kept') => `${which[0]}${String(id).padStart(39, '0')}`

// A worktree's files as the nested tree `listTree` gives, folders before what is beside them.
const treeOf = (paths: string[]): TreeNode[] => {
  const folders = new Map<string, string[]>()
  const files: TreeNode[] = []
  for (const path of paths) {
    const at = path.indexOf('/')
    if (at === -1) files.push({ name: path, kind: 'file' })
    else folders.set(path.slice(0, at), [...(folders.get(path.slice(0, at)) ?? []), path.slice(at + 1)])
  }
  return [...[...folders].map(([name, inside]): TreeNode => ({ name, kind: 'dir', children: treeOf(inside) })), ...files]
}

// A gadget's code as each of its commits kept it, oldest first: the empty one it was made with,
// then a chat's changes, each kept. Its commits are made up from its id and how far along they are.
const GADGET_SERVER = `import { DurableObject } from 'cloudflare:workers'

type Task = { text: string; done: boolean }

/** The review's to-do list, kept as the doc's tasks. */
export class Gadget extends DurableObject {
  async getDocument() {
    return (await this.ctx.storage.get<{ title: string; tasks: Task[] }>('doc')) ?? { title: 'Q3 platform review', tasks: [] }
  }

  async toggle(index: number) {
    const doc = await this.getDocument()
    const task = doc.tasks[index]
    if (task) task.done = !task.done
    await this.ctx.storage.put('doc', doc)
    return doc
  }
}
`
type KeptCode = { message: string; author: { name: string; email: string }; timestamp: Date; files: Record<string, string> }
const GADGET_HISTORY: Array<{ message: string; minutesAgo: number; files: Record<string, string> }> = [
  { message: 'Make the gadget', minutesAgo: 60 * 26, files: {} },
  {
    message: 'Start the review as a to-do list',
    minutesAgo: 60 * 25,
    files: {
      'client.js': UI_CODE.trimStart().replace("  'label:hover { background: rgb(0 0 0 / 0.04); }',\n", '').replace("left ? left + ' of ' + doc.tasks.length + ' left to do' : 'All done'", "left + ' left'"),
      'server.ts': GADGET_SERVER.replace('    await this.ctx.storage.put(\'doc\', doc)\n', ''),
    },
  },
  {
    message: 'Keep what is ticked off, and say how much is left',
    minutesAgo: 14,
    files: {
      'client.js': UI_CODE.trimStart(),
      'server.ts': GADGET_SERVER,
      'README.md': '# Q3 platform review\n\nThe review as a to-do list: tick a task off once it is done, and everyone sees it.\n',
    },
  },
]
// A gadget's commit by how far along its history it is, and the gadget and place a commit names.
const gadgetCommit = (id: number, at: number) => `g${String(at).padStart(3, '0')}${String(id).padStart(36, '0')}`
const commitPlace = (commitId: string) =>
  (/^g\d{39}$/.test(commitId) ? { id: Number(commitId.slice(4)), at: Number(commitId.slice(1, 4)) } : undefined)
// What someone else kept meanwhile, for a save to find its draft's files changed under it.
const OTHERS_CHANGE = { from: 'font-size: 28px', to: 'font-size: 32px' }
const GRACE = { name: COLLABORATORS[0].name, email: COLLABORATORS[0].id }

const logs = (messages: AiChatMessage[]) => messages.flatMap((message) => (message.type === 'action' && message.actionLog ? [message.actionLog] : []))

// How many entries a page of a workspace's history holds, as the server pages it.
const HISTORY_PAGE = 15

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// Made up, and only told apart here. Not `crypto.randomUUID()`, which a page that is not served
// securely does not have, such as the dev server opened from a phone by its address.
let made = 0
const madeUpId = (kind: string) => `${kind}-${++made}`

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
  // The chat was deleted: it is listed no more, and nothing more happens in it.
  #deleted = false
  // The viewer's notifications for the chat, as they chose them, and who hears of them, by workspace.
  #notifications: Pick<ChatReadState, 'notificationsEnabled' | 'notificationsEnabledOverride'> = { notificationsEnabled: true }
  #readStateSubscribers = new Map<ReadStateEvents, string>()
  // How many of the chat's messages the viewer has not read, which only marking it unread makes more than none.
  #unread = 0
  #actionSubscribers = new Set<ActionEvents>()
  // Standing approvals, as `gatekeeperId:tag`.
  #rules = new Set<string>()
  // What the gadget asks outside the chat, by id (`Scenario.gadgetAsks`).
  #gadgetAsks: Scenario['gadgetAsks']
  #outside = new Map<number, ActionLogEntry & { type: 'action' }>()
  // The workspace's other chats, by id, and what else was read and set up outside any chat (`Scenario.workspace`).
  #others = new Map<number, MockChat>()
  #elsewhere: ActionLogEntry[] = []
  #gadgets = new Map<number, MockGadget>()
  // The workspace's gadgets that run by itself, with their hooks (`Scenario.workspace.automations`).
  #automations: MockAutomation[] = []
  // What each gadget's code was kept as since its made-up history, by its id: saved edits, and
  // what someone else kept.
  #kept = new Map<number, KeptCode[]>()
  // The chat's code not kept yet, as the server keeps it.
  #code = new MockChatCode()
  // The gadgets the script's changes and a template's update propose something to other than
  // code, not kept yet: what they make, connect and update.
  #waiting = new Set<number>()
  // Deleted, which no longer are, whatever their id.
  #removedGadgets = new Set<number>()
  #workpieceSubscribers = new Set<WorkpiecesSubscriber>()
  #files: NonNullable<Scenario['files']>
  #worktrees: Record<number, MockWorktree>
  #blobs = new Map<GitOid, Uint8Array>()
  #refusals: string[]
  #sendDelay: number
  #title: string
  #owner: Scenario['owner']
  #restricted: boolean
  #templateUpdate: boolean
  #agents: NonNullable<Scenario['agents']>
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
    this.#title = scenario.title
    this.#owner = scenario.owner
    this.#restricted = scenario.restricted === true
    this.#templateUpdate = scenario.templateUpdate ?? false
    this.#gadgetAsks = scenario.gadgetAsks
    for (const entry of scenario.gadgetAsks?.waiting ?? []) if (entry.type === 'action') this.#outside.set(entry.id, entry)
    for (const other of scenario.workspace?.chats ?? []) this.#others.set(other.chat.id, { ...other, messages: [...other.messages] })
    this.#automations = (scenario.workspace?.automations ?? []).map((each) => ({ ...each, hooks: each.hooks.map((hook) => ({ ...hook })) }))
    for (const { gadget } of this.#automations) this.#gadgets.set(gadget.id, new MockGadget(gadget.title, () => this.#backUp()))
    for (const entry of scenario.workspace?.outside ?? []) {
      if (entry.type === 'action') this.#outside.set(entry.id, entry)
      else this.#elsewhere.push(entry)
    }
    // A copy, since files sent in the chat join them, and a restart begins from the scenario again.
    this.#files = { ...scenario.files }
    this.#worktrees = scenario.worktrees ?? {}
    this.#agents = scenario.agents ?? { setups: [], runs: [] }
    // The gadgets that start them are listed from the start.
    for (const { gadget } of this.#agents.setups) {
      if (gadget) this.#gadgets.set(gadget.id, new MockGadget(gadget.title, () => this.#backUp()))
    }
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
        if (name === 'getGatekeeperById') {
          return (id: number) => ({
            getCreationSpec: async () => {
              const setup = this.#agents.setups.find(({ spawnerId }) => spawnerId === id)
              if (!setup) throw new Error(`No connection ${id}.`)
              return { type: 'agentSpawner', config: { displayName: setup.name, modelId: setup.model ?? null }, ...(setup.model ? { modelName: setup.model } : {}) }
            },
            [Symbol.dispose]: () => {},
          })
        }
        if (name === 'getGadget') {
          return (id: number) => ({
            ...this.#gadget(id).open(handle),
            // The agents it starts, which are all it is bound to here.
            applyBlueprint: (blueprintId: string) => this.#proposeUpdate(id, blueprintId, handle),
            setTitle: (title: string) => this.#renameGadget(id, title, handle),
            remove: () => this.#removeGadget(id, handle),
            // The agents it starts, and the connection its asks go through.
            listBindings: async () => {
              if (handle.broken) throw handle.broken
              return [
                ...this.#agents.setups
                  .filter(({ gadget }) => gadget?.id === id)
                  .map(({ spawnerId, name: title, gadget }) => ({ name: gadget!.bindingName, target: spawnerId, resourceTitle: title })),
                ...(this.#gadgetAsks ? [this.#gadgetAsks.connection] : []),
                ...(this.#automations.find(({ gadget }) => gadget.id === id)?.connections ?? []),
              ]
            },
          })
        }
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

  /** Any id is a gadget, until it is deleted: the scenarios' outputs are all documents. */
  #gadget(id: number) {
    if (this.#removedGadgets.has(id)) throw new Error(`No gadget ${id}.`)
    let gadget = this.#gadgets.get(id)
    if (!gadget) {
      // As the chat has it, beside the chat, else as it is kept.
      const ui = (chatId?: number) => (chatId === CHAT_ID
        ? this.#code.files(id, (commit) => this.#filesAt(commit ?? this.#head(id)))
        : this.#filesAt(this.#head(id)))?.['client.js'] ?? UI_CODE
      this.#gadgets.set(id, (gadget = new MockGadget('Q3 platform review', () => this.#backUp(), ui, (task) => this.#ask(task))))
      for (const subscriber of this.#workpieceSubscribers) subscriber.entry(this.#gadgetSummary(id))
    }
    return gadget
  }

  #gadgetSummary(id: number) {
    const upstream = this.#templateUpdate ? { upstream: { blueprintId: TEMPLATE.id, commitId: TEMPLATE_TAKEN } } : {}
    return { id, type: 'gadget', title: this.#gadgets.get(id)?.title ?? 'Q3 platform review', commitId: this.#head(id), ...upstream } as const
  }

  // Each time a gadget's code was kept, oldest first: the history every gadget has, then its own.
  #history(id: number): KeptCode[] {
    const author = { name: VIEWER.name, email: VIEWER.id }
    const listed = GADGET_HISTORY.map(({ message, minutesAgo, files }) => ({ message, author, timestamp: new Date(Date.now() - minutesAgo * 60_000), files }))
    return [...listed, ...(this.#kept.get(id) ?? [])]
  }

  #head(id: number) {
    return gadgetCommit(id, this.#history(id).length - 1)
  }

  // A gadget's files at one of its commits.
  #filesAt(commitId: string): Record<string, string> | undefined {
    const place = commitPlace(commitId)
    return place && this.#history(place.id)[place.at]?.files
  }

  // Keeps the gadget's code as `files`, which moves its head, as those listening to the workpieces hear.
  #keep(id: number, code: Omit<KeptCode, 'timestamp'>) {
    this.#kept.set(id, [...(this.#kept.get(id) ?? []), { ...code, timestamp: new Date() }])
    for (const subscriber of this.#workpieceSubscribers) subscriber.entry(this.#gadgetSummary(id))
  }

  /**
   * Someone else keeps a change to each gadget opened so far, from another chat: its title made
   * bigger, in `client.js`, which a save of edits to that file then finds changed under it.
   */
  keepElsewhere() {
    for (const id of this.#gadgets.keys()) {
      const files = { ...this.#filesAt(this.#head(id)) }
      if (files['client.js']) files['client.js'] = files['client.js'].replace(OTHERS_CHANGE.from, OTHERS_CHANGE.to)
      this.#keep(id, { message: 'Accept changes from chat: Make the title bigger', author: GRACE, files })
    }
  }

  /**
   * One change to the chat's code, as the server takes it (`MockChatCode`): moved past what was
   * taken since it was made, each gadget pinned at its head by its first change, and told to
   * whoever listens. Not while the agent works.
   */
  async submitCodeChange(chatId: number, submission: CodeChangeSubmission) {
    if (chatId !== CHAT_ID || this.#deleted) throw new Error(`No chat ${chatId}.`)
    if (this.#metadata.activeAgent) throw new Error('Agent is running, wait for it to finish.')
    const { row, again } = this.#code.submit(submission, (id) => this.#head(id))
    if (!again) {
      this.#setMetadata({ codeBase: this.#code.base(this.#metadata.codeBase?.epoch), proposedChangeWorkpieces: this.#proposedWorkpieces() })
      this.#chatSubscribers.forEach((subscriber) => subscriber.changeApplied?.(CHAT_ID, row.generation, row.revision, VIEWER, row.change, row.submission))
    }
    return { generation: row.generation, revision: row.revision }
  }

  /**
   * Keeps what the chat proposes: stale where a gadget's head has moved past its pin, as the
   * server refuses to merge then. What was edited and not recorded yet is recorded first, as the
   * viewer's, then kept, which closes the chat's stream with its content carried over.
   */
  async mergeChanges(chatId: number) {
    if (chatId !== CHAT_ID || (!this.#code.proposes && this.#waiting.size === 0)) return { outcome: 'merged' } as const
    if (this.#code.pins.some(({ gadgetId, mergedCommit }) => mergedCommit !== this.#head(gadgetId))) return { outcome: 'stale' } as const
    const commits = this.#code.gadgets.map((id) => {
      const files = this.#code.files(id, (commit) => this.#filesAt(commit ?? this.#head(id)))
      this.#keep(id, { message: `Accept changes from chat: ${this.#metadata.title}`, author: { name: VIEWER.name, email: VIEWER.id }, files })
      return { gadgetId: id, commitId: this.#head(id) }
    })
    const recorded = this.#code.record()
    if (recorded) this.#append(changes(recorded))
    this.#append((sequence: number) => ({ ...merge()(sequence), commits }))
    this.#code.kept()
    this.#waiting.clear()
    this.#setMetadata({ codeBase: this.#code.base(this.#messages.at(-1)?.sequence), proposedChangeWorkpieces: undefined })
    return { outcome: 'merged' } as const
  }

  /** Throws away what the chat proposes from `revertFrom` on, which is all of it here. */
  async revertChanges(chatId: number, revertFrom: number) {
    if (chatId !== CHAT_ID) return
    this.#append(revert(revertFrom))
    this.#code.discarded()
    this.#waiting.clear()
    this.#setMetadata({ codeBase: this.#code.base(this.#metadata.codeBase?.epoch), proposedChangeWorkpieces: undefined })
  }

  #proposedWorkpieces() {
    const ids = new Set([...this.#code.gadgets, ...this.#waiting])
    return ids.size > 0 ? [...ids] : undefined
  }

  /** What a message the script or a template's update adds proposes, or keeps, as the server says. */
  #heard(message: AiChatMessage) {
    if (message.type === 'merge') {
      this.#waiting.clear()
      this.#code.kept()
      this.#setMetadata({ codeBase: this.#code.base(message.sequence), proposedChangeWorkpieces: undefined })
      return
    }
    if (message.type !== 'changes') return
    if (message.change) this.#code.recorded(message.change)
    const ids = [
      ...(message.createdGadgets ?? []).map(({ gadgetId }) => gadgetId),
      ...(message.blueprintMerges ?? []).map(({ gadgetId }) => gadgetId),
      ...(message.addedBindings ?? []).map(({ gadgetId }) => gadgetId),
    ]
    ids.forEach((id) => this.#waiting.add(id))
    if (ids.length || message.change) this.#setMetadata({ proposedChangeWorkpieces: this.#proposedWorkpieces() })
  }

  /** Gives the gadget another title, which those listening to the workpieces hear of. */
  async #renameGadget(id: number, title: string, handle: Handle) {
    if (handle.broken) throw handle.broken
    await this.#backUp()
    this.#gadget(id).title = title
    for (const subscriber of this.#workpieceSubscribers) subscriber.entry(this.#gadgetSummary(id))
  }

  /** Deletes the gadget, which those listening to the workpieces hear of, and which is then no more. */
  async #removeGadget(id: number, handle: Handle) {
    if (handle.broken) throw handle.broken
    await this.#backUp()
    this.#gadget(id)
    this.#gadgets.delete(id)
    this.#removedGadgets.add(id)
    for (const subscriber of this.#workpieceSubscribers) subscriber.removed(id)
  }

  /**
   * Proposes the template's latest release for the gadget after a moment, as working it out takes,
   * in this chat rather than a new one: the scenario has the one.
   */
  async #proposeUpdate(gadgetId: number, blueprintId: string, handle: Handle) {
    if (handle.broken) throw handle.broken
    await sleep(1200)
    if (handle.broken) throw handle.broken
    if (blueprintId !== TEMPLATE.id) throw new Error(`No template ${blueprintId}.`)
    const { title, version, commitId = '' } = TEMPLATE.metadata
    this.#append(changes({ blueprintMerges: [{ gadgetId, blueprintId, title, version, commitId, kind: 'fastForward', baseCommit: TEMPLATE_TAKEN, conflictPaths: [] }] }))
    this.#heard(this.#messages.at(-1)!)
    return { outcome: 'proposed', chatId: CHAT_ID } as const
  }

  /**
   * The gadgets opened so far, each with the same history of its code, and the worktrees, listed
   * as they are to the chat that made them.
   */
  subscribeToWorkpieces(subscriber: WorkpiecesSubscriber) {
    this.#workpieceSubscribers.add(subscriber)
    for (const id of this.#gadgets.keys()) subscriber.entry(this.#gadgetSummary(id))
    for (const [key, worktree] of Object.entries(this.#worktrees)) {
      const id = Number(key)
      subscriber.entry({
        id,
        type: 'worktree',
        title: worktree.title,
        chatId: CHAT_ID,
        pinBase: worktreeCommit(id, 'kept'),
        headCommit: worktreeCommit(id, 'head'),
        baseCommit: worktreeCommit(id, 'base'),
      })
    }
    subscriber.ready()
    return lease(() => void this.#workpieceSubscribers.delete(subscriber))
  }

  // The worktree a commit is one of: an agent's commit between is numbered by its worktree's id.
  #worktreeAt(commitId: string): MockWorktree | undefined {
    const number = Number(commitId.slice(1))
    return this.#worktrees[commitId.startsWith('c') ? Math.floor(number / 100) : number]
  }

  // A worktree's files at a commit: where it started, without what its agent changed since, which
  // is made up as added; any later, as kept.
  #worktreeFiles(commitId: string): Record<string, string> | undefined {
    const worktree = this.#worktreeAt(commitId)
    if (!worktree || !commitId.startsWith('b')) return worktree?.files
    return Object.fromEntries(Object.entries(worktree.files).filter(([path]) => !worktree.changed.includes(path)))
  }

  async listTree(commitId: string): Promise<TreeNode[]> {
    const kept = this.#filesAt(commitId)
    if (kept) return treeOf(Object.keys(kept))
    const files = this.#worktreeFiles(commitId)
    if (!files) throw new Error(`No commit ${commitId}`)
    return treeOf(Object.keys(files))
  }

  async readFilesAtCommit(commitId: string, paths: string[]): Promise<Array<[string, FileAtCommit]>> {
    const files = this.#filesAt(commitId) ?? this.#worktreeFiles(commitId) ?? {}
    return paths.map((path) => [path, path in files ? { kind: 'text', text: files[path] } : { kind: 'absent' }])
  }

  async listChangedPaths(fromCommit: string, toCommit: string): Promise<string[]> {
    const [from, to] = [this.#filesAt(fromCommit), this.#filesAt(toCommit)]
    if (from && to) {
      const paths = new Set([...Object.keys(from), ...Object.keys(to)])
      return [...paths].filter((path) => from[path] !== to[path])
    }
    return this.#worktreeAt(toCommit)?.changed ?? []
  }

  async getCommitLog(fromCommit: string): Promise<CommitInfo[]> {
    const place = commitPlace(fromCommit)
    if (place) {
      return this.#history(place.id).slice(0, place.at + 1).map(({ message, author, timestamp }, at): CommitInfo => ({
        oid: gadgetCommit(place.id, at),
        parents: at === 0 ? [] : [gadgetCommit(place.id, at - 1)],
        message: `${message}\n`,
        author,
        timestamp,
      })).toReversed()
    }
    const id = Number(fromCommit.slice(1))
    const worktree = this.#worktrees[id]
    if (!worktree) return []
    const author = { name: AGENT.name, email: 'agent@localhost' }
    const commits = worktree.commits.map(({ message, minutesAgo }, index): CommitInfo => ({
      oid: index === 0 ? fromCommit : `c${String(id * 100 + index).padStart(39, '0')}`,
      parents: [],
      message: `${message}\n`,
      author,
      timestamp: new Date(Date.now() - minutesAgo * 60_000),
    }))
    const log = [...commits, { oid: worktreeCommit(id, 'base'), parents: [], message: 'Where it started\n', author, timestamp: new Date(0) }]
    // Each made on the one before it.
    return log.map((commit, at) => ({ ...commit, parents: log[at + 1] ? [log[at + 1].oid] : [] }))
  }

  subscribeToPresence(subscriber: PresenceSubscriber) {
    subscriber.init([VIEWER, ...COLLABORATORS].map((user) => ({ key: user.id, user, role: 'build' })))
    return lease(() => {})
  }

  /** The workspace as its page reads it: the viewer's own, unless the scenario names its owner. */
  async getMetadata(): Promise<WorkspaceMetadata> {
    return { id: MOCK_WORKSPACE_ID, title: this.#title, owner: this.#owner, role: 'build', containsRestrictedData: this.#restricted }
  }

  /** Everyone with access but the owner: whoever else is there, each let in by the owner to edit. */
  async listCollaborators(): Promise<CollaboratorInfo[]> {
    const owner = this.#owner ?? VIEWER
    return [VIEWER, ...COLLABORATORS]
      .filter(({ id }) => id !== owner.id)
      .map((profile) => ({ profile, addedBy: [{ type: 'user', sharer: owner.id, created: new Date(0) }], access: { role: 'build' } }))
  }

  /** Set once the workspace has deleted itself, which takes it out of the list. */
  deleted = false

  async deleteSelf() {
    this.deleted = true
  }

  async listChats(): Promise<AiChatMetadata[]> {
    return [...(this.#deleted ? [] : [this.#metadata]), ...[...this.#others.values()].map(({ chat }) => chat), ...this.#agents.runs]
  }


  /** Deletes the chat, which everyone subscribed hears of, as the server tells them. */
  async deleteChat(chatId: number) {
    if (chatId !== CHAT_ID || this.#deleted) return
    this.#deleted = true
    this.player.pause()
    this.#chatSubscribers.forEach((subscriber) => subscriber.deleted(CHAT_ID))
    this.#readStateSubscribers.forEach((workspaceId, subscriber) => void subscriber.chatUpdated(workspaceId, CHAT_ID, null, this.#totals(workspaceId)))
  }

  /**
   * The viewer's read state for the chat, as a subscription scoped to `workspaceId` gives it: read,
   * unless it was marked unread since, with their notifications as they chose them.
   */
  subscribeToReadState(workspaceId: string, subscriber: ReadStateEvents) {
    this.#readStateSubscribers.set(subscriber, workspaceId)
    const { unreadChatCount, unreadMessageCount, workspace } = this.#totals(workspaceId)
    const others = [...this.#others.keys()].map((chatId) => this.#otherReadState(workspaceId, chatId))
    void subscriber.updated({ unreadChatCount, unreadMessageCount, workspaces: [workspace], chats: [...(this.#deleted ? [] : [this.#readState(workspaceId)]), ...others] })
    return lease(() => this.#readStateSubscribers.delete(subscriber))
  }

  async setChatNotificationsEnabled(chatId: number, enabled: boolean) {
    if (chatId !== CHAT_ID || this.#deleted) throw new Error('This chat is no longer available.')
    this.#notifications = { notificationsEnabled: enabled, notificationsEnabledOverride: enabled }
    this.#readStateSubscribers.forEach((workspaceId, subscriber) =>
      void subscriber.chatUpdated(workspaceId, CHAT_ID, this.#readState(workspaceId), this.#totals(workspaceId)))
  }

  /** Read through what there is: the chat is on screen whenever this is asked. */
  async markChatRead(chatId: number) {
    const other = this.#others.get(chatId)
    if (other) return this.#readOther(other)
    if (chatId !== CHAT_ID || this.#unread === 0) return
    this.#unread = 0
    this.#publishReadState()
  }

  /** The latest message, unread again. */
  async markChatUnread(chatId: number) {
    if (chatId !== CHAT_ID || this.#unread > 0) return false
    this.#unread = 1
    this.#publishReadState()
    return true
  }

  /** The workspace keeps no cache warm here. */
  async viewChat() {
    return { [Symbol.dispose]: () => {} }
  }

  #publishReadState() {
    this.#readStateSubscribers.forEach((workspaceId, subscriber) =>
      void subscriber.chatUpdated(workspaceId, CHAT_ID, this.#readState(workspaceId), this.#totals(workspaceId)))
  }

  /** Every chat of the workspace read, as marking all of it read leaves it. */
  async markWorkspaceRead() {
    for (const other of this.#others.values()) this.#readOther(other)
    await this.markChatRead(CHAT_ID)
  }

  /** The chats with something unread, as the inbox lists them. */
  unreadThreads(workspaceId: string): UnreadThread[] {
    return [...this.#others.values()].filter(({ unread }) => (unread ?? 0) > 0).map(({ chat, messages }) => {
      const latest = messages.at(-1)
      return {
        ...this.#otherReadState(workspaceId, chat.id),
        chatTitle: chat.title ?? '',
        latestSequence: latest?.sequence ?? -1,
        latestMessagePreview: latest?.type === 'message' ? latest.message.split('\n')[0] : '',
        latestActivityAt: latest?.timestamp,
      }
    })
  }

  #readOther(other: MockChat) {
    if (!other.unread) return
    other.unread = 0
    this.#readStateSubscribers.forEach((workspaceId, subscriber) =>
      void subscriber.chatUpdated(workspaceId, other.chat.id, this.#otherReadState(workspaceId, other.chat.id), this.#totals(workspaceId)))
  }

  #otherReadState(workspaceId: string, chatId: number): ChatReadState {
    const { messages, unread = 0 } = this.#others.get(chatId)!
    return { workspaceId, chatId, unreadMessageCount: unread, readThroughSequence: (messages.at(-1)?.sequence ?? -1) - unread, notificationsEnabled: true }
  }

  // The workspace's unread totals, over its chats.
  #totals(workspaceId: string) {
    const counts = [this.#deleted ? 0 : this.#unread, ...[...this.#others.values()].map(({ unread = 0 }) => unread)].filter((count) => count > 0)
    const unreadChatCount = counts.length
    const unreadMessageCount = counts.reduce((sum, count) => sum + count, 0)
    return { unreadChatCount, unreadMessageCount, workspace: { workspaceId, unreadChatCount, unreadMessageCount } }
  }

  #readState(workspaceId: string): ChatReadState {
    const last = this.#messages.at(-1)?.sequence ?? -1
    return { workspaceId, chatId: CHAT_ID, unreadMessageCount: this.#unread, readThroughSequence: last - this.#unread, ...this.#notifications }
  }

  async getChatHistory(chatId: number, beforeSequence?: number, limit?: number): Promise<AiChatHistoryPage> {
    // An agent's run that failed ends on its error, which is all of it that is kept here.
    if (this.#agents.failed?.includes(chatId)) {
      return { messages: [{ chatId, sequence: 1, timestamp: new Date(), author: AGENT, type: 'error', message: 'The model provider returned an error.' }] }
    }
    const other = this.#others.get(chatId)
    const older = (other?.messages ?? this.#messages).filter(({ sequence }) => beforeSequence === undefined || sequence < beforeSequence)
    if (other) {
      const messages = limit === undefined ? older : older.slice(-limit)
      return { messages, nextBeforeSequence: messages.length < older.length ? messages[0].sequence : undefined }
    }
    if (chatId !== CHAT_ID || limit === undefined) return { messages: chatId === CHAT_ID ? older : [] }
    const messages = older.slice(-limit)
    return { messages, nextBeforeSequence: messages.length < older.length ? messages[0].sequence : undefined }
  }

  subscribeToChat(subscriber: ChatEvents) {
    this.#chatSubscribers.add(subscriber)
    subscriber.streamGeneration(this.#generation)
    // What the chat's stream took that no message records yet, as the server sends it again.
    for (const row of this.#code.unrecorded) subscriber.changeApplied?.(CHAT_ID, row.generation, row.revision, VIEWER, row.change, row.submission)
    this.player.fire('onStart')
    return lease(() => this.#chatSubscribers.delete(subscriber))
  }

  subscribeToActions(subscriber: ActionEvents) {
    this.#actionSubscribers.add(subscriber)
    return lease(() => this.#actionSubscribers.delete(subscriber))
  }

  /** Kept by a made-up OID, until a message carries it. */
  async uploadBlob(content: Uint8Array): Promise<GitOid> {
    const oid = madeUpId('blob')
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
      const id = madeUpId('file')
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

  /**
   * The workspace's actions: what waits outside the chat, which is all a gadget's asks are read
   * from here, what the chats asked for, as their messages have it now, and one waiting for each
   * of the agents' runs that has one. All of it in one page, but for the whole history of a
   * workspace with other chats, which is paged as the server pages it.
   */
  async listActions(options: { filter?: ActionHistoryFilter; beforeId?: number } = {}): Promise<ActionHistoryPage> {
    const runs = (this.#agents.pending ?? []).map((chatId, index): ActionLogEntry => ({
      id: 9000 + index,
      type: 'action',
      chatId,
      state: 'pending',
      resourceTitle: 'Mail',
      createdAt: new Date(),
      description: { title: 'Reply to the email', description: '', implementsRevert: false, autoApprovable: true },
    }))
    const others = [...this.#others.values()].flatMap(({ messages }) => logs(messages))
    const entries = [...this.#outside.values(), ...this.#elsewhere, ...logs(this.#messages), ...others, ...runs]
      .filter((entry) => matchesActionHistoryFilter(entry, options.filter ?? 'all'))
      .filter((entry) => options.beforeId === undefined || entry.id < options.beforeId)
      .toSorted((a, b) => b.id - a.id)
    if (this.#others.size === 0 || (options.filter ?? 'all') !== 'all' || entries.length <= HISTORY_PAGE) return { entries }
    const page = entries.slice(0, HISTORY_PAGE)
    return { entries: page, nextBeforeId: page.at(-1)!.id }
  }

  async approveAction(id: number) {
    if (this.#outside.has(id)) return this.#resolveOutside(id, { state: 'approved', resolvedBy: VIEWER })
    if (this.#resolveOther(id, { state: 'approved', resolvedBy: VIEWER })) return
    this.#resolve(id, { state: 'approved', resolvedBy: VIEWER })
    this.player.fire('onApprove')
  }

  async rejectAction(id: number) {
    if (this.#outside.has(id)) return this.#resolveOutside(id, { state: 'rejected', resolvedBy: VIEWER })
    if (this.#resolveOther(id, { state: 'rejected', resolvedBy: VIEWER })) return
    this.#resolve(id, { state: 'rejected', resolvedBy: VIEWER })
    this.player.fire('onDeny')
  }

  /** Approves what is pending under the new rule, and what the script queues under it later. */
  async setAutoApprovedActionKind(gatekeeperId: number, actionKind: ActionKind) {
    this.#rules.add(`${gatekeeperId}:${actionKind.tag}`)
    const pending = this.#messages.filter((message) => this.#autoApproves(message))
    for (const { actionId } of pending) this.#resolve(actionId, { state: 'approved', resolvedBy: VIEWER, autoApproved: true })
    if (pending.length) this.player.fire('onApprove')
    for (const entry of this.#outside.values()) {
      if (this.#ruleApplies(entry)) this.#resolveOutside(entry.id, { state: 'approved', resolvedBy: VIEWER, autoApproved: true })
    }
  }

  async removeAutoApprovedActionKind(gatekeeperId: number, tag: string) {
    this.#rules.delete(`${gatekeeperId}:${tag}`)
  }

  /**
   * The gadget asks to write the task ticked off into the connection it is bound to, outside the
   * chat, as it would used on its own page. A standing rule lets it through as it is made.
   */
  #ask(task: string) {
    const asks = this.#gadgetAsks
    if (!asks) return
    const id = Math.max(1000, ...this.#outside.keys()) + 1
    const entry: ActionLogEntry & { type: 'action' } = {
      id,
      type: 'action',
      state: 'pending',
      gatekeeperId: asks.connection.target,
      resourceTitle: asks.connection.resourceTitle,
      createdAt: new Date(),
      description: {
        title: `Append “${task}” to ${asks.connection.resourceTitle}`,
        description: `Adds one line at the end of **${asks.connection.resourceTitle}**.`,
        fields: [{ label: 'Text', kind: 'text', value: `Done: ${task}` }],
        descriptionIsComplete: true,
        implementsRevert: false,
        autoApprovable: true,
        actionKind: { tag: 'append', label: 'Append to document' },
      },
    }
    this.#outside.set(id, entry)
    this.#actionSubscribers.forEach((subscriber) => subscriber.entry(entry))
    if (this.#ruleApplies(entry)) setTimeout(() => this.#resolveOutside(id, { state: 'approved', resolvedBy: VIEWER, autoApproved: true }), 300)
  }

  #ruleApplies({ state, gatekeeperId, description }: ActionLogEntry & { type: 'action' }) {
    return state === 'pending' && description.autoApprovable && this.#rules.has(`${gatekeeperId}:${description.actionKind?.tag}`)
  }

  #resolveOutside(id: number, change: Pick<ActionLogEntry & { type: 'action' }, 'state' | 'resolvedBy' | 'autoApproved'>) {
    const entry = this.#outside.get(id)
    if (entry?.state !== 'pending') throw new Error(`Action is not pending: ${id}`)
    const resolved = { ...entry, ...change, appliedAt: new Date() }
    this.#outside.set(id, resolved)
    this.#actionSubscribers.forEach((subscriber) => subscriber.entry(resolved))
  }

  /**
   * Decides an action another chat of the workspace asked for, if it is one, which its chat hears
   * of; with nothing else there to decide, the chat waits no longer.
   */
  #resolveOther(id: number, change: Pick<ActionLogEntry & { type: 'action' }, 'state' | 'resolvedBy'>) {
    for (const other of this.#others.values()) {
      const message = other.messages.find((candidate): candidate is ActionMessage => candidate.type === 'action' && candidate.actionLog?.id === id)
      if (!message?.actionLog) continue
      if (message.actionLog.state !== 'pending') throw new Error(`Action is not pending: ${id}`)
      const resolved = { ...message, actionLog: { ...message.actionLog, ...change, appliedAt: new Date() } }
      other.messages = other.messages.map((candidate) => (candidate === message ? resolved : candidate))
      this.#actionSubscribers.forEach((subscriber) => subscriber.entry(resolved.actionLog))
      this.#deliver(resolved)
      const waiting = other.messages.some((candidate) => candidate.type === 'action' && candidate.actionLog?.state === 'pending' && candidate.actionLog.type === 'action' && candidate.actionLog.description.awaitDecision)
      if (other.chat.awaitingDecision && !waiting) {
        other.chat = { ...other.chat, awaitingDecision: undefined, lastActive: new Date() }
        this.#chatSubscribers.forEach((subscriber) => subscriber.metadata(other.chat))
      }
      return true
    }
    return false
  }

  /** The hooks the conversation's cards set up, each waking the scenarios' one gadget, and the workspace's automations'. */
  async listHooks(): Promise<BoundHookInfo[]> {
    const set = this.#messages.flatMap((message) => {
      const log = message.type === 'action' ? message.actionLog : undefined
      if (log?.type !== 'bindHook' || log.hookId === undefined) return []
      const { hookId: id, gatekeeperId = 0, resourceTitle, resourceUrl, description, enabled } = log
      return [{ id, gatekeeperId, gadgetId: 1, resourceTitle, resourceUrl, description, enabled }]
    })
    return [...set, ...this.#automations.flatMap(({ gadget, hooks }) => hooks.map((hook) => ({ ...hook, gadgetId: gadget.id })))]
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
    const file = this.#files[id]
    if (!file) throw new Error(`No attachment ${id}`)
    return typeof file === 'function' ? file() : file
  }

  async setChatTitle(_chatId: number, title: string) {
    this.#setMetadata({ title })
  }

  async denyConnectionRequest(requestId: string) {
    this.#resolveConnection(requestId, { state: 'denied' })
    this.player.fire('onDenyConnection')
  }

  async approveWebFetchRequest(requestId: string) {
    this.#resolveFetch(requestId, 'approved')
  }

  async denyWebFetchRequest(requestId: string) {
    this.#resolveFetch(requestId, 'denied')
  }

  #resolveFetch(requestId: string, state: 'approved' | 'denied') {
    const request = this.#messages.find((message) => message.type === 'webFetchRequest' && message.requestId === requestId)
    if (request?.type !== 'webFetchRequest' || request.state !== 'pending') throw new Error('No such pending request.')
    const resolved = { ...request, state }
    this.#replace(resolved)
    this.#deliver(resolved)
  }

  #run(step: ScriptStep) {
    if ('restart' in step) this.#restart(step.restart)
    else if ('disconnect' in step) this.#disconnect(step.disconnect)
    else if ('stream' in step) this.#chatSubscribers.forEach((subscriber) => subscriber.stream(CHAT_ID, step.stream))
    else if ('message' in step) {
      this.#append(step.message)
      this.#heard(this.#messages.at(-1)!)
    }
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
    // Its record was made as it was, too.
    if (message.type === 'action' && message.actionLog) message = { ...message, actionLog: { ...message.actionLog, createdAt: message.timestamp } }
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
    const kept = this.#automations.flatMap(({ hooks }) => hooks).find(({ id }) => id === hookId)
    if (kept) {
      kept.enabled = enabled
      return
    }
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
