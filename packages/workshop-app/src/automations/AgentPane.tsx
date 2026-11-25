import { useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowDown01Icon } from '@/components/icons'
import { AgentCrumb } from '@/blocks/AgentCrumb'
import { AgentMark } from '@/blocks/AgentMark'
import { AgentRunRow } from '@/blocks/AgentRunRow'
import { Banner, Button, LinkButton, ListGroup, PageLayout, Tabs, type TabsTab, formatActivity, groupByTime } from '@gadgets/ui'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useNow } from '@/hooks/useNow'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { activityWords, agentsOf, attentionWords, foldRuns, gadgetsOf, gadgetTitles, runFilterCounts, runsMatching, runsWords, STATUS_WORDS, type Agent, type AgentRun, type RunEntry, type RunFilter } from './agents'
import { useAgentRunList } from './useAgentRunList'
import { useWorkspaceAgents } from './useWorkspaceAgents'

export type AgentPaneProps = {
  workspaceId: string
  /** Which of the workspace's agents (`Agent.key`: its spawner's id). */
  agentKey: string
  onOpenWorkspace: () => void
  /** Opens one of its runs' conversation. */
  onOpenRun: (run: AgentRun) => void
  /** A run's address, for its row to link to so that it can be opened in another tab. */
  runHref?: (chatId: number) => string
  /** Shows a gadget bound to it. */
  onOpenGadget: (gadgetId: number) => void
  /** Where that gadget opens, for its link to be opened in another tab. */
  gadgetHref?: (gadgetId: number) => string
}

/**
 * One of a workspace's agents, as a page of its own (`/workspace/<id>/agent/<key>`): headed by
 * its workspace and the agent, as a chat is by its workspace, then what it is (`AgentView`). What
 * it is comes from the workspace's agents (`useWorkspaceAgents`); its runs are its own, read a
 * page at a time (`useAgentRunList`), so an agent the workspace's latest runs leave out is still
 * found by its spawner's id.
 */
export const AgentPane = (props: AgentPaneProps) => {
  const { workspaceId, agentKey } = props
  const { state, retry } = useWorkspaceAgents(workspaceId)
  const now = useNow()
  const spawnerId = /^\d+$/.test(agentKey) ? Number(agentKey) : undefined
  if (state.status === 'ready' && spawnerId !== undefined) {
    const listed = state.agents.find(({ key }) => key === agentKey)
    return <AgentPage key={spawnerId} {...props} spawnerId={spawnerId} listed={listed} pending={state.actionsWaiting} now={now} />
  }
  const view: AgentViewProps['state'] =
    state.status === 'failed' ? { status: 'failed', message: state.message, onRetry: retry }
      : state.status === 'ready' ? { status: 'gone' }
        : { status: 'loading' }
  return (
    <AgentFrame {...props}>
      <AgentView state={view} now={now} {...props} />
    </AgentFrame>
  )
}

type AgentPageProps = AgentPaneProps & {
  spawnerId: number
  /** The agent as the workspace lists it, with what it is; absent for one known only by its runs. */
  listed?: Agent
  /** The runs with an action waiting to be approved. */
  pending: ReadonlySet<number>
  now: number
}

/** An agent found, with its own runs. */
const AgentPage = ({ spawnerId, listed, pending, now, ...props }: AgentPageProps) => {
  const { state, more, retry } = useAgentRunList(props.workspaceId, spawnerId)
  const agent = state.status === 'ready' ? agentsOf(state.runs, { pending }, listed ? [listed] : [])[0] : undefined
  const view: AgentViewProps['state'] =
    state.status === 'loading' ? { status: 'loading' }
      : state.status === 'failed' ? { status: 'failed', message: state.message, onRetry: retry }
        : agent ? { status: 'ready', agent, all: state.all, more: { reading: state.reading, problem: state.problem, onMore: more } }
          : { status: 'gone' }
  return (
    <AgentFrame {...props} agent={agent}>
      <AgentView state={view} now={now} {...props} />
    </AgentFrame>
  )
}

/** The page around an agent: its workspace's crumb and, once it is known, its own. */
const AgentFrame = ({ workspaceId, onOpenWorkspace, agent, children }: Pick<AgentPaneProps, 'workspaceId' | 'onOpenWorkspace'> & { agent?: Agent; children: ReactNode }) => {
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const look = useWorkspaceLooks()[workspaceId]
  useDocumentTitle(agent?.name || 'Agent')
  return (
    <PageLayout
      header={(
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          {workspace && <WorkspaceCrumb id={workspaceId} title={workspace.title} label={workspaceLabel(workspace.title)} look={look} onOpen={onOpenWorkspace} />}
          {agent && <AgentCrumb agentKey={agent.key} name={agent.name} />}
        </nav>
      )}
    >
      {children}
    </PageLayout>
  )
}

/** Reading more of an agent's runs than those it has. */
export type MoreRuns = { reading: boolean; problem?: string; onMore: () => void }

export type AgentViewProps = {
  state:
    | { status: 'loading' }
    | { status: 'failed'; message: string; onRetry: () => void }
    /** There is no such agent in the workspace. */
    | { status: 'gone' }
    /** `all`: its runs are all of them; else `more` reads more. */
    | { status: 'ready'; agent: Agent; all: boolean; more?: MoreRuns }
  /** The clock it is shown by, which moves on while it is shown. */
  now: number
  onOpenRun: (run: AgentRun) => void
  runHref?: (chatId: number) => string
  onOpenGadget: (gadgetId: number) => void
  gadgetHref?: (gadgetId: number) => string
}

const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5 rounded-2xl p-3 text-base leading-snug sm:flex-row sm:gap-3">
    <dt className="shrink-0 text-kumo-subtle sm:w-32">{label}</dt>
    <dd className="min-w-0 text-kumo-default">{children}</dd>
  </div>
)

const FILTERS: { value: RunFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'attention', label: 'Needs you' },
  { value: 'failed', label: 'Failed' },
  { value: 'changes', label: 'Changes to keep' },
]

/**
 * What an agent is, drawn from plain props: its mark, there to be played with as the home page's
 * is, and its name, what of it wants the user (a run waiting on them, or a latest run that failed)
 * with the way to that run, then the gadgets bound to it, the model it thinks with and how often it
 * has run, then its runs by when, each saying how it stands and opening its conversation, which is
 * where what it did is seen. Nothing says when it runs: nothing tells which of a gadget's hooks, if
 * any, started a run.
 *
 * An agent can run hundreds of times, so its runs are read a page at a time, narrowed by how they
 * stand (a tab each, for those it has, counting those read), and a run that finished the same way
 * as the one after it, with the same title, is folded under that one, said once with how often,
 * there to open out. Under All, what wants the user is on top, apart from the rest.
 */
export const AgentView = ({ state, now, onOpenRun, runHref, onOpenGadget, gadgetHref }: AgentViewProps) => {
  if (state.status === 'loading') return <p role="status" className="appears-late px-4 pt-16 text-center text-base text-kumo-subtle">Loading the agent…</p>
  if (state.status === 'failed') {
    return (
      <p className="flex items-center justify-center gap-3 px-4 pt-16 text-base text-kumo-subtle">
        Couldn’t load the agent: {state.message}
        <Button variant="ghost" onClick={state.onRetry}>Try again</Button>
      </p>
    )
  }
  if (state.status === 'gone') return <p className="px-4 pt-16 text-center text-base text-kumo-subtle">There’s no such agent in this workspace, or it was deleted.</p>

  const { agent, all, more } = state
  const date = new Date(now)
  const attention = attentionWords(agent)
  const wanting = agent.runs.find(({ status }) => status === 'waiting') ?? (agent.failed ? agent.runs[0] : undefined)
  const gadgets = gadgetsOf(agent)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
      <div className="flex flex-col items-center gap-2 pt-8 text-center">
        <AgentMark size="large" interactive state={agent.running > 0 ? 'working' : agent.failed ? 'failed' : 'idle'} />
        <h1 className="max-w-full px-2.5 py-1 text-xl font-medium wrap-anywhere text-kumo-default">{agent.name}</h1>
        <p className="max-w-md text-base text-pretty text-kumo-subtle">
          {gadgets.length > 0 ? `${gadgetTitles(gadgets)} ${gadgets.length === 1 ? 'starts' : 'start'} it with a task.` : 'A gadget starts it with a task.'} Each run is a conversation of its own, there to open to see what it did.
        </p>
      </div>
      {attention && wanting && (
        <Banner
          tone={agent.waiting > 0 ? 'warning' : 'danger'}
          title={attention}
          description={agent.waiting > 1 ? 'They stopped for your approval or a connection, and go on once you answer.'
            : agent.waiting === 1 ? 'It stopped for your approval or a connection, and goes on once you answer.'
              : 'Open the run to see what went wrong.'}
          action={{ label: 'Open run', onSelect: () => onOpenRun(wanting) }}
        />
      )}
      <dl className="flex flex-col rounded-3xl bg-kumo-tint p-1.5">
        <Fact label="Started by">
          {gadgets.length > 0
            ? gadgets.map((gadget, index) => (
                <span key={gadget.id}>
                  {index > 0 && ', '}
                  <LinkButton href={gadgetHref?.(gadget.id)} onClick={() => onOpenGadget(gadget.id)} className="text-left underline underline-offset-2">
                    {gadget.title}
                  </LinkButton>
                </span>
              ))
            : <span className="text-kumo-subtle">No gadget starts it now</span>}
        </Fact>
        <Fact label="Thinks with">{agent.model ?? <span className="text-kumo-subtle">No model: its runs wait for a person to answer</span>}</Fact>
        <Fact label="Runs">{runsWords(agent, all, date)}</Fact>
      </dl>
      <AgentRuns key={agent.key} runs={agent.runs} more={all ? undefined : more} now={date} onOpenRun={onOpenRun} runHref={runHref} />
    </div>
  )
}

type AgentRunsProps = Pick<AgentViewProps, 'onOpenRun' | 'runHref'> & { runs: AgentRun[]; more?: MoreRuns; now: Date }

/** An agent's runs, narrowed, with those alike folded, and the way to read more where there are (see `AgentView`). */
const AgentRuns = ({ runs, more, now, onOpenRun, runHref }: AgentRunsProps) => {
  const [filter, setFilter] = useState<RunFilter>('all')
  // The runs opened out from under the one they are folded under, by its chat.
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const counts = runFilterCounts(runs)
  const tabs: TabsTab<RunFilter>[] = FILTERS
    .filter(({ value }) => value === 'all' || counts[value] > 0 || value === filter)
    .map((tab) => (tab.value === 'attention' && counts.attention > 0 ? { ...tab, count: { value: counts.attention, label: 'waiting on you' } } : tab))

  // Under All, what wants the user comes first, as its own group; the rest are by when.
  const pinned = filter === 'all' ? runsMatching(runs, 'attention') : []
  const pinnedIds = new Set(pinned.map(({ chatId }) => chatId))
  const listed = runsMatching(runs, filter).filter(({ chatId }) => !pinnedIds.has(chatId))
  const entries = foldRuns(listed)
  const groups = groupByTime(entries.map((entry) => ({ value: entry, at: entry.run.lastActive })), now)

  // Where any run has others folded under it, every row keeps the room of the way to open them, so
  // that when each was is in one column.
  const folds = entries.some(({ folded }) => folded.length > 0)
  const row = ({ key, run, folded }: RunEntry, time?: string) => {
    const opened = open.has(key)
    return (
      <div key={key} className="flex flex-col">
        <div className="flex items-center">
          <div className="min-w-0 flex-1">
            <AgentRunRow
              title={run.title}
              status={run.status}
              statusWords={folded.length > 0 ? `${STATUS_WORDS[run.status]} · ${folded.length + 1} runs alike` : STATUS_WORDS[run.status]}
              time={time}
              href={runHref?.(run.chatId)}
              onSelect={() => onOpenRun(run)}
            />
          </div>
          {folded.length > 0 && (
            <Button
              variant="ghost"
              icon={<ArrowDown01Icon aria-hidden="true" className={cn('transition-transform duration-150 motion-reduce:transition-none', opened && 'rotate-180')} />}
              aria-label={opened ? `Fold the ${folded.length} earlier runs` : `Show the ${folded.length} earlier runs`}
              aria-expanded={opened}
              className="ms-1 shrink-0 text-kumo-subtle"
              onClick={() => setOpen((current) => {
                const next = new Set(current)
                if (!next.delete(key)) next.add(key)
                return next
              })}
            />
          )}
          {folds && folded.length === 0 && <span aria-hidden="true" className="ms-1 w-(--control-size) shrink-0" />}
        </div>
        {opened && (
          <div className="ms-5 border-s border-kumo-line ps-2">
            {folded.map((earlier) => (
              <AgentRunRow
                key={earlier.chatId}
                title={earlier.title}
                status={earlier.status}
                statusWords={`${STATUS_WORDS[earlier.status]} · ${activityWords(earlier.lastActive, now)}`}
                href={runHref?.(earlier.chatId)}
                onSelect={() => onOpenRun(earlier)}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <section aria-label="Runs" className="flex flex-col gap-4">
      {runs.length === 0 ? (
        <>
          <h2 className="px-4 text-sm font-medium text-kumo-subtle">Runs</h2>
          <p className="px-4 text-base text-kumo-subtle">It hasn’t run yet.</p>
        </>
      ) : (
        <Tabs
          value={filter}
          onValueChange={setFilter}
          tabs={tabs}
          aria-label="Runs"
          align="start"
          scrolls
          className="gap-4"
        >
          <Tabs.Panel value={filter} className="flex flex-col gap-8">
            {pinned.length > 0 && <ListGroup label="Needs you">{pinned.map((run) => row({ key: run.chatId, run, folded: [] }, formatActivity(run.lastActive, now)))}</ListGroup>}
            {groups.map(({ key, label, entries: grouped }) => (
              <ListGroup key={key} label={label}>
                {grouped.map(({ value, time }) => row(value, time))}
              </ListGroup>
            ))}
            {more && (
              <div className="flex flex-col items-center gap-2">
                {more.problem && <p role="alert" className="text-base text-kumo-subtle">Couldn’t load more runs: {more.problem}</p>}
                <Button variant="secondary" disabled={more.reading} onClick={more.onMore}>
                  {more.reading ? 'Loading runs…' : 'Show more'}
                </Button>
              </div>
            )}
          </Tabs.Panel>
        </Tabs>
      )}
    </section>
  )
}
