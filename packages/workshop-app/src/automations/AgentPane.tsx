import type { ReactNode } from 'react'
import { AgentCrumb } from '@/blocks/AgentCrumb'
import { AgentMark } from '@/blocks/AgentMark'
import { AgentRunRow } from '@/blocks/AgentRunRow'
import { ListGroup } from '@/blocks/ListGroup'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { LinkButton } from '@/components/LinkButton'
import { groupByTime } from '@/chat/timeGroups'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useNow } from '@/hooks/useNow'
import { PageLayout } from '@/layouts/PageLayout'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { agentByKey, attentionWords, runsWords, STATUS_WORDS, type Agent, type AgentRun } from './agents'
import { cadenceWords } from './cadence'
import { useAutomations } from './useAutomations'
import { useWorkspaceAgents } from './useWorkspaceAgents'

export type AgentPaneProps = {
  workspaceId: string
  /** Which of the workspace's agents (`Agent.key`). */
  agentKey: string
  onOpenWorkspace: () => void
  /** Opens one of its runs' conversation. */
  onOpenRun: (run: AgentRun) => void
  /** A run's address, for its row to link to so that it can be opened in another tab. */
  runHref?: (chatId: number) => string
  /** Shows the gadget that starts it. */
  onOpenGadget: (gadgetId: number) => void
  /** Where that gadget opens, for its link to be opened in another tab. */
  gadgetHref?: (gadgetId: number) => string
}

/**
 * One of a workspace's agents, as a page of its own (`/workspace/<id>/agent/<key>`): headed by
 * its workspace and the agent, as a chat is by its workspace, then what it is (`AgentView`), with
 * when it runs from the automations of the gadget that starts it.
 */
export const AgentPane = ({ workspaceId, agentKey, onOpenWorkspace, onOpenRun, runHref, onOpenGadget, gadgetHref }: AgentPaneProps) => {
  const { state, retry } = useWorkspaceAgents(workspaceId)
  const automations = useAutomations(workspaceId)
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const look = useWorkspaceLooks()[workspaceId]
  const now = useNow()
  // A run that predates its spawner's id names its agent by name, and may have joined one that has an id.
  const agent = state.status === 'ready'
    ? agentByKey(state.agents, agentKey) ?? (agentKey.startsWith('name:') ? state.agents.find(({ name }) => `name:${name}` === agentKey) : undefined)
    : undefined
  useDocumentTitle(agent?.name || 'Agent')

  // What sets off the gadget that starts it, which is when it runs, as far as anything says.
  const gadgetId = agent?.gadget?.id
  const when = gadgetId !== undefined && automations.state.status === 'ready'
    ? automations.state.automations
      .filter(({ hook }) => hook.gadgetId === gadgetId && hook.enabled)
      .map(({ hook, schedule }) => (schedule ? cadenceWords(schedule.cadence) : `When ${hook.description.title}`))
    : []

  const view: AgentViewProps['state'] =
    state.status === 'loading' ? { status: 'loading' }
      : state.status === 'failed' ? { status: 'failed', message: state.message, onRetry: retry }
        : agent ? { status: 'ready', agent }
          // Until the gadgets have said, one that has not run may yet be found.
          : state.setUpRead ? { status: 'gone' } : { status: 'loading' }

  return (
    <PageLayout
      header={(
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          {workspace && <WorkspaceCrumb id={workspaceId} title={workspace.title} label={workspaceLabel(workspace.title)} look={look} onOpen={onOpenWorkspace} />}
          {agent && <AgentCrumb agentKey={agent.key} name={agent.name} />}
        </nav>
      )}
    >
      <AgentView state={view} when={when} now={now} onOpenRun={onOpenRun} runHref={runHref} onOpenGadget={onOpenGadget} gadgetHref={gadgetHref} />
    </PageLayout>
  )
}

export type AgentViewProps = {
  state:
    | { status: 'loading' }
    | { status: 'failed'; message: string; onRetry: () => void }
    /** There is no such agent in the workspace. */
    | { status: 'gone' }
    | { status: 'ready'; agent: Agent }
  /** When it runs, in words, each a schedule of the gadget that starts it or what sets that off. */
  when: string[]
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

/**
 * What an agent is, drawn from plain props: its mark, there to be played with as the home page's is, and its name, what of it wants the user (a run
 * waiting on them, or a latest run that failed) with the way to that run, then the gadget that
 * starts it, the model it thinks with, when it runs and how often it has, then its runs by when,
 * each saying how it stands and opening its conversation, which is where what it did is seen.
 */
export const AgentView = ({ state, when, now, onOpenRun, runHref, onOpenGadget, gadgetHref }: AgentViewProps) => {
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

  const { agent } = state
  const date = new Date(now)
  const attention = attentionWords(agent)
  const wanting = agent.runs.find(({ status }) => status === 'waiting') ?? (agent.failed ? agent.runs[0] : undefined)
  const groups = groupByTime(agent.runs.map((run) => ({ value: run, at: run.lastActive })), date)
  const gadget = agent.gadget

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
      <div className="flex flex-col items-center gap-2 pt-8 text-center">
        <AgentMark size="large" interactive state={agent.running > 0 ? 'working' : agent.failed ? 'failed' : 'idle'} />
        <h1 className="max-w-full px-2.5 py-1 text-xl font-medium wrap-anywhere text-kumo-default">{agent.name}</h1>
        <p className="max-w-md text-base text-pretty text-kumo-subtle">
          {gadget ? `${gadget.title} starts it with a task.` : 'A gadget starts it with a task.'} Each run is a conversation of its own, there to open to see what it did.
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
          {gadget
            ? (
                <LinkButton href={gadgetHref?.(gadget.id)} onClick={() => onOpenGadget(gadget.id)} className="text-left underline underline-offset-2">
                  {gadget.title}
                </LinkButton>
              )
            : <span className="text-kumo-subtle">No gadget starts it now</span>}
        </Fact>
        <Fact label="Thinks with">{agent.model ?? <span className="text-kumo-subtle">No model: its runs wait for a person to answer</span>}</Fact>
        <Fact label="When it runs">
          {when.length > 0 ? when.join(' · ') : gadget ? `Whenever ${gadget.title} starts it` : <span className="text-kumo-subtle">Not known</span>}
        </Fact>
        <Fact label="Runs">{runsWords(agent, date)}</Fact>
      </dl>
      <section className="flex flex-col gap-2">
        <h2 className="px-4 text-sm font-medium text-kumo-subtle">Runs</h2>
        {agent.runs.length === 0 && <p className="px-4 text-base text-kumo-subtle">It hasn’t run yet.</p>}
        <div className="flex flex-col gap-8">
          {groups.map(({ key, label, entries }) => (
            <ListGroup key={key} label={label}>
              {entries.map(({ value: run, time }) => (
                <AgentRunRow
                  key={run.chatId}
                  title={run.title}
                  status={run.status}
                  statusWords={STATUS_WORDS[run.status]}
                  time={time}
                  href={runHref?.(run.chatId)}
                  onSelect={() => onOpenRun(run)}
                />
              ))}
            </ListGroup>
          ))}
        </div>
      </section>
    </div>
  )
}
