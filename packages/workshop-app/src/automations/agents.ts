import { isAgentRun, type AgentSpawnerInfo, type AiChatMetadata } from '@gadgets/workshop-shared/api'
import { formatActivity } from '@gadgets/ui'

/**
 * How one run stands: its agent at work (`running`), stopped on a decision only a person can make
 * or with an action waiting to be approved (`waiting`), ended on an error (`failed`), done with
 * changes still to be kept (`changes`), or done.
 */
export type RunStatus = 'running' | 'waiting' | 'failed' | 'changes' | 'done'

/** One run of an agent: the conversation it had, as its workspace lists it. */
export type AgentRun = {
  chatId: number
  title: string
  started: Date
  lastActive: Date
  status: RunStatus
  /** The chat whose agent started it, where one did (`AiChatMetadata.spawnedByChatId`). */
  spawnedByChatId?: number
}

/** A gadget bound to an agent, and the name its code knows the agent by (`env.NAME`). */
export type AgentGadget = { id: number; title: string; bindingName: string }

/**
 * An agent as the workspace has set it up: one of its agent spawners (`listAgentSpawners()`),
 * which is the agent, with its name and the model it thinks with as it was made, and every gadget
 * bound to it. One that no gadget is bound to has none.
 */
export type AgentSetup = {
  /** The agent's spawner, as its runs name it (`AiChatMetadata.spawnerId`). */
  spawnerId: number
  name: string
  /** The model it thinks with, by name. Absent for one that thinks with none, whose runs wait for a person. */
  model?: string
  gadgets: AgentGadget[]
}

/**
 * An agent of a workspace: as it was set up where its spawner is listed, else as its runs name
 * it, with those of its runs that were read, latest first. Its key is its spawner's id.
 */
export type Agent = AgentSetup & {
  key: string
  runs: AgentRun[]
  /** Its runs waiting on a person. */
  waiting: number
  /** Its runs at work now. */
  running: number
  /** Its latest run ended on an error, which nothing has run since to put right. */
  failed: boolean
}

/** What says how runs stand, beyond what each chat says of itself. */
export type RunSignals = {
  /** The runs with an action waiting to be approved. */
  pending: ReadonlySet<number>
}

const NO_SIGNALS: RunSignals = { pending: new Set() }

/** The key of an agent, by its spawner's id, for its page's address. */
export const agentKeyOf = (spawnerId: number) => String(spawnerId)

/**
 * What a workspace's agent spawners set up: one agent each, bound to every gadget it is bound to
 * that `gadgets` lists (by id, with its title). A binding still waiting in a chat is not the
 * agent's yet.
 */
export const setupsOf = (spawners: readonly AgentSpawnerInfo[], gadgets: ReadonlyMap<number, string>): AgentSetup[] =>
  spawners.map(({ id, config, modelName, bindings }) => ({
    spawnerId: id,
    name: config.displayName,
    ...(modelName ? { model: modelName } : {}),
    gadgets: bindings.flatMap(({ gadgetId, name, chatId }) => {
      const title = gadgets.get(gadgetId)
      return chatId === undefined && title !== undefined ? [{ id: gadgetId, title: title || 'Untitled gadget', bindingName: name }] : []
    }),
  }))

/** The gadgets bound to an agent, each once, though it may know the agent by two names. */
export const gadgetsOf = ({ gadgets }: Pick<AgentSetup, 'gadgets'>) => [...new Map(gadgets.map((gadget) => [gadget.id, gadget])).values()]

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })

/** Gadgets' titles, in words: "Inbox, Changelog and Triage". */
export const gadgetTitles = (gadgets: readonly Pick<AgentGadget, 'title'>[]) => LIST.format(gadgets.map(({ title }) => title))

/** How a run stands, from its chat and what else is known of it. */
export const runStatus = (chat: AiChatMetadata, signals: RunSignals = NO_SIGNALS): RunStatus => {
  if (chat.awaitingDecision || signals.pending.has(chat.id)) return 'waiting'
  if (chat.activeAgent) return 'running'
  if (chat.lastTurnFailed) return 'failed'
  if (chat.proposedChangeWorkpieces?.length) return 'changes'
  return 'done'
}

/** Whether an agent wants a person: a run waiting on them, or a latest run that failed. */
export const wantsAttention = (agent: Pick<Agent, 'waiting' | 'failed'>) => agent.waiting > 0 || agent.failed

const latestFirst = (a: { lastActive: Date }, b: { lastActive: Date }) => b.lastActive.getTime() - a.lastActive.getTime()

/**
 * A workspace's agents: those it has set up (`setups`), with their runs among `chats`, and any
 * others those runs are of (their `spawnerId`), named as the latest of them names its spawner. A
 * run with no `spawnerId` joins none. Those that want a person come first, then the rest by their
 * latest run, then those that have not run, by name.
 */
export const agentsOf = (chats: readonly AiChatMetadata[], signals: RunSignals = NO_SIGNALS, setups: readonly AgentSetup[] = []): Agent[] => {
  const agents = new Map<string, Agent>()
  const add = (setup: AgentSetup) => {
    const made: Agent = { ...setup, key: agentKeyOf(setup.spawnerId), runs: [], waiting: 0, running: 0, failed: false }
    agents.set(made.key, made)
    return made
  }
  for (const setup of setups) if (!agents.has(agentKeyOf(setup.spawnerId))) add(setup)
  for (const chat of chats.filter(isAgentRun).toSorted(latestFirst)) {
    const { spawnerId } = chat
    if (spawnerId === undefined) continue
    const agent = agents.get(agentKeyOf(spawnerId)) ?? add({ spawnerId, name: chat.spawnerName || 'Agent', gadgets: [] })
    const status = runStatus(chat, signals)
    if (agent.runs.length === 0) agent.failed = status === 'failed'
    agent.runs.push({
      chatId: chat.id,
      title: chat.title || 'Untitled run',
      started: chat.started,
      lastActive: chat.lastActive,
      status,
      ...(chat.spawnedByChatId !== undefined ? { spawnedByChatId: chat.spawnedByChatId } : {}),
    })
    if (status === 'waiting') agent.waiting++
    if (status === 'running') agent.running++
  }
  const latest = (agent: Agent) => agent.runs[0]?.lastActive.getTime() ?? -Infinity
  return [...agents.values()].toSorted((a, b) =>
    Number(wantsAttention(b)) - Number(wantsAttention(a))
    || latest(b) - latest(a)
    || a.name.localeCompare(b.name))
}

/** The runs of a workspace's agents that want a person, latest first, each with its agent. */
export const runsWantingAttention = (agents: readonly Agent[]) =>
  agents
    .flatMap((agent) => agent.runs.filter((run, index) => run.status === 'waiting' || (index === 0 && run.status === 'failed')).map((run) => ({ agent, run })))
    .toSorted((a, b) => latestFirst(a.run, b.run))

const COUNT = new Intl.NumberFormat('en')

/** When something was, in words that can follow others: "2 hours ago", "just now", "yesterday". */
export const activityWords = (at: Date, now?: Date) => formatActivity(at, now).replace(/^(Just now|Yesterday)$/, (word) => word.toLowerCase())

/**
 * An agent's runs, in words: how many, and when the latest was; or that it has not run. Unless
 * `all` of them were read, it says only what was: at least so many, or none of late.
 */
export const runsWords = ({ runs }: Pick<Agent, 'runs'>, all: boolean, now?: Date) => {
  if (runs.length === 0) return all ? 'Hasn’t run yet' : 'No recent runs'
  const count = runs.length === 1 ? (all ? 'One run' : 'At least one run') : `${all ? '' : 'At least '}${COUNT.format(runs.length)} runs`
  return `${count} · latest ${activityWords(runs[0].lastActive, now)}`
}

/** How a run stands, in a word or two. */
export const STATUS_WORDS: Record<RunStatus, string> = {
  running: 'Running',
  waiting: 'Waiting on you',
  failed: 'Failed',
  changes: 'Changes to keep',
  done: 'Done',
}

/** What an agent wants of a person, in words, where it wants anything: "2 runs waiting on you". */
export const attentionWords = (agent: Pick<Agent, 'waiting' | 'failed'>) =>
  agent.waiting > 0
    ? agent.waiting === 1 ? 'A run is waiting on you' : `${COUNT.format(agent.waiting)} runs are waiting on you`
    : agent.failed ? 'Its latest run failed' : undefined

/** Which of an agent's runs its page lists: all of them, those that want the user, those that failed, or those with changes to keep. */
export type RunFilter = 'all' | 'attention' | 'failed' | 'changes'

/** Whether a run wants the user: it waits on them, or it is the latest and failed. */
const wantsUser = (run: AgentRun, index: number) => run.status === 'waiting' || (index === 0 && run.status === 'failed')

/** An agent's runs a filter keeps, latest first, as they were. */
export const runsMatching = (runs: readonly AgentRun[], filter: RunFilter): AgentRun[] =>
  filter === 'all' ? [...runs]
    : filter === 'attention' ? runs.filter(wantsUser)
      : runs.filter(({ status }) => status === filter)

/** How many of an agent's runs each filter keeps, for its tab to say. */
export const runFilterCounts = (runs: readonly AgentRun[]): Record<RunFilter, number> => ({
  all: runs.length,
  attention: runs.filter(wantsUser).length,
  failed: runs.filter(({ status }) => status === 'failed').length,
  changes: runs.filter(({ status }) => status === 'changes').length,
})

/** A run as its agent's page lists it, with the runs folded under it: those just before it that went the same way. */
export type RunEntry = { key: number; run: AgentRun; folded: AgentRun[] }

/**
 * Runs as a list of them, latest first, each run after another with the same title that also
 * finished with nothing to do folded under that one: an agent started on a schedule runs the same
 * task again and again, and what is the same is said once, with how often.
 */
export const foldRuns = (runs: readonly AgentRun[]): RunEntry[] => {
  const entries: RunEntry[] = []
  for (const run of runs) {
    const last = entries.at(-1)
    if (last && run.status === 'done' && last.run.status === 'done' && last.run.title === run.title) last.folded.push(run)
    else entries.push({ key: run.chatId, run, folded: [] })
  }
  return entries
}
