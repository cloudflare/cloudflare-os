import type { AiChatMessage, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { formatActivity } from '@/workspaces/formatActivity'

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
}

/**
 * An agent as the workspace has set it up (an agent spawner), as far as it can be read: its
 * name and the model it thinks with, from how it was made, and the gadget that starts it, from
 * that gadget's bindings. One that no gadget is bound to has none.
 */
export type AgentSetup = {
  spawnerId: number
  name: string
  /** The model it thinks with, by name. Absent for one that thinks with none, whose runs wait for a person. */
  model?: string
  /** The gadget that starts it, and the name its code knows it by (`env.NAME`). */
  gadget?: { id: number; title: string; bindingName: string }
}

/**
 * An agent a workspace's gadgets start: what it is, as it was set up where that can be read, and
 * the runs it has had, latest first. Its key is its spawner's id, which a run started before runs
 * recorded it does not have: such runs join the agent whose latest run has their name, or are an
 * agent of that name alone.
 */
export type Agent = {
  key: string
  spawnerId?: number
  name: string
  model?: string
  gadget?: AgentSetup['gadget']
  runs: AgentRun[]
  /** Its runs waiting on a person. */
  waiting: number
  /** Its runs at work now. */
  running: number
  /** Its latest run ended on an error, which nothing has run since to put right. */
  failed: boolean
  /** The keys of spawners it replaced, whose runs are its: a run's page names its agent by one. */
  aliases?: string[]
}

/** What says how runs stand, beyond what each chat says of itself. */
export type RunSignals = {
  /** The runs with an action waiting to be approved. */
  pending: ReadonlySet<number>
  /** The runs whose last message is an error. */
  failed: ReadonlySet<number>
}

const NO_SIGNALS: RunSignals = { pending: new Set(), failed: new Set() }

/** A chat an agent had, rather than one a person started. */
export const isAgentRun = (chat: AiChatMetadata) => chat.spawnerId !== undefined || chat.spawnerName !== undefined

/** The key of an agent, by its spawner's id, for its page's address. */
export const agentKeyOf = (spawnerId: number) => String(spawnerId)

/** The key of an agent known only by its name, as one whose runs predate their spawner's id is. */
export const namedAgentKey = (name: string) => `name:${name}`

/** A message that says its turn ended on an error, other than being stopped by a person. */
export const isFailure = (message: AiChatMessage) => message.type === 'error' && message.code !== 'stopped'

/** How a run stands, from its chat and what else is known of it. */
export const runStatus = (chat: AiChatMetadata, signals: RunSignals = NO_SIGNALS): RunStatus => {
  if (chat.awaitingDecision || signals.pending.has(chat.id)) return 'waiting'
  if (chat.activeAgent) return 'running'
  if (signals.failed.has(chat.id)) return 'failed'
  if (chat.proposedChangeWorkpieces?.length) return 'changes'
  return 'done'
}

/** Whether an agent wants a person: a run waiting on them, or a latest run that failed. */
export const wantsAttention = (agent: Pick<Agent, 'waiting' | 'failed'>) => agent.waiting > 0 || agent.failed

const latestFirst = (a: { lastActive: Date }, b: { lastActive: Date }) => b.lastActive.getTime() - a.lastActive.getTime()

/**
 * A workspace's agents: those it has set up (`setups`), with the runs among its chats, and any
 * others its runs name. Those that want a person come first, then the rest by their latest run,
 * then those that have not run, by name.
 */
export const agentsOf = (chats: readonly AiChatMetadata[], signals: RunSignals = NO_SIGNALS, setups: readonly AgentSetup[] = []): Agent[] => {
  const runs = chats.filter(isAgentRun).toSorted(latestFirst)
  const agents = new Map<string, Agent>()
  const add = (key: string, agent: Omit<Agent, 'key' | 'runs' | 'waiting' | 'running' | 'failed'>) => {
    const made: Agent = { key, ...agent, runs: [], waiting: 0, running: 0, failed: false }
    agents.set(key, made)
    return made
  }
  for (const setup of setups) {
    if (!agents.has(agentKeyOf(setup.spawnerId))) add(agentKeyOf(setup.spawnerId), setup)
  }
  // A run joins its spawner's agent. One whose spawner is no longer set up (a chat that set the
  // agent up again replaced it) joins the one set-up agent of its name, as people know it by its
  // name; and a run that names only its spawner's name joins the agent whose latest run has that
  // name.
  const setUpByName = new Map<string, string | null>()
  for (const { name, spawnerId } of setups) setUpByName.set(name, setUpByName.has(name) ? null : agentKeyOf(spawnerId))
  const keyByName = new Map<string, string>()
  for (const [name, key] of setUpByName) if (key) keyByName.set(name, key)
  for (const chat of runs) {
    if (chat.spawnerId !== undefined && chat.spawnerName && !keyByName.has(chat.spawnerName)) keyByName.set(chat.spawnerName, agentKeyOf(chat.spawnerId))
  }
  for (const chat of runs) {
    const name = chat.spawnerName || 'Agent'
    const own = chat.spawnerId !== undefined ? agentKeyOf(chat.spawnerId) : undefined
    const setUp = setUpByName.get(name)
    const key = own ? (agents.has(own) || !setUp ? own : setUp) : keyByName.get(name) ?? namedAgentKey(name)
    const agent = agents.get(key) ?? add(key, { name, ...(chat.spawnerId !== undefined ? { spawnerId: chat.spawnerId } : {}) })
    if (own && own !== key && !agent.aliases?.includes(own)) agent.aliases = [...(agent.aliases ?? []), own]
    const status = runStatus(chat, signals)
    if (agent.runs.length === 0) agent.failed = status === 'failed'
    agent.runs.push({ chatId: chat.id, title: chat.title || 'Untitled run', started: chat.started, lastActive: chat.lastActive, status })
    if (status === 'waiting') agent.waiting++
    if (status === 'running') agent.running++
  }
  const latest = (agent: Agent) => agent.runs[0]?.lastActive.getTime() ?? -Infinity
  return [...agents.values()].toSorted((a, b) =>
    Number(wantsAttention(b)) - Number(wantsAttention(a))
    || latest(b) - latest(a)
    || a.name.localeCompare(b.name))
}

/** The agent `key` names: its own key, or one of a spawner it replaced. */
export const agentByKey = (agents: readonly Agent[], key: string) =>
  agents.find((agent) => agent.key === key) ?? agents.find(({ aliases }) => aliases?.includes(key))

/** The runs of a workspace's agents that want a person, latest first, each with its agent. */
export const runsWantingAttention = (agents: readonly Agent[]) =>
  agents
    .flatMap((agent) => agent.runs.filter((run, index) => run.status === 'waiting' || (index === 0 && run.status === 'failed')).map((run) => ({ agent, run })))
    .toSorted((a, b) => latestFirst(a.run, b.run))

const COUNT = new Intl.NumberFormat('en')

/** When something was, in words that can follow others: "2 hours ago", "just now", "yesterday". */
export const activityWords = (at: Date, now?: Date) => formatActivity(at, now).replace(/^(Just now|Yesterday)$/, (word) => word.toLowerCase())

/** An agent's runs, in words: how many, and when the latest was; or that it has not run. */
export const runsWords = ({ runs }: Pick<Agent, 'runs'>, now?: Date) =>
  runs.length === 0
    ? 'Hasn’t run yet'
    : `${runs.length === 1 ? 'One run' : `${COUNT.format(runs.length)} runs`} · latest ${activityWords(runs[0].lastActive, now)}`

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
