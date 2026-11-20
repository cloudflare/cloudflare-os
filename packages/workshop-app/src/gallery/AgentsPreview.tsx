import { useState } from 'react'
import { AgentRow } from '@/blocks/AgentRow'
import { AgentRunRow } from '@/blocks/AgentRunRow'
import { ChatHeader } from '@/blocks/ChatHeader'
import { Banner, Button, ListGroup, Tabs } from '@gadgets/ui'
import { WorkspaceListItem } from '@/blocks/WorkspaceListItem'
import { WorkspaceRailItem } from '@/blocks/WorkspaceRailItem'
import { agentsOf, STATUS_WORDS, type Agent, type AgentRun, type AgentSetup } from '@/automations/agents'
import { AgentsTab } from '@/automations/AgentsTab'
import { AgentView } from '@/automations/AgentPane'
import type { WorkspaceAgentsSnapshot } from '@/automations/WorkspaceAgents'
import { useReport } from './previewState'
import { Section } from './Section'
import { EXAMPLE_AGENT_CHATS, EXAMPLE_AGENT_SETUPS, EXAMPLE_NOW, EXAMPLE_SIGNALS } from '@/automations/exampleAgents'

const STATES = ['ready', 'loading', 'failed', 'empty'] as const

const stateOf = (which: (typeof STATES)[number], setups: readonly AgentSetup[] = EXAMPLE_AGENT_SETUPS): WorkspaceAgentsSnapshot =>
  which === 'loading' ? { status: 'loading' }
    : which === 'failed' ? { status: 'failed', message: 'The workspace could not be reached.' }
      : which === 'empty' ? { status: 'ready', agents: [], setUpRead: true, allRuns: true, actionsWaiting: new Set() }
        : { status: 'ready', agents: agentsOf(EXAMPLE_AGENT_CHATS, EXAMPLE_SIGNALS, setups), setUpRead: true, allRuns: true, actionsWaiting: new Set() }

// An agent run on a schedule, many times over: the same digest every few hours, now and then
// failing, waiting on the user or leaving changes; more of its runs are still to be read.
const BUSY: Agent = (() => {
  const runs = Array.from({ length: 273 }, (_, index): AgentRun => {
    const lastActive = new Date(EXAMPLE_NOW.getTime() - index * 3 * 60 * 60 * 1000)
    const status = index === 2 || index === 40 ? 'waiting' : index % 37 === 5 ? 'failed' : index % 23 === 11 ? 'changes' : 'done'
    return { chatId: 10_000 - index, title: index % 9 === 4 ? 'Weekly digest' : 'Digest of new tickets', started: lastActive, lastActive, status }
  })
  return { key: 'busy', spawnerId: 99, name: 'Ticket digest', model: 'claude-sonnet-5-5', gadgets: [{ id: 99, title: 'Triage', bindingName: 'DIGEST' }], runs, waiting: 2, running: 0, failed: false }
})()

/** A workspace's agents, their runs and what of them waits on the user, in each of their states. */
export const AgentsPreview = () => {
  const { report, say } = useReport()
  const [which, setWhich] = useState<(typeof STATES)[number]>('ready')
  const [tab, setTab] = useState<'chats' | 'agents' | 'library'>('agents')
  const agents = agentsOf(EXAMPLE_AGENT_CHATS, EXAMPLE_SIGNALS, EXAMPLE_AGENT_SETUPS)
  const [shown, setShown] = useState(agents[0].key)
  const agent = shown === BUSY.key ? BUSY : agents.find(({ key }) => key === shown)

  return (
    <>
      <Section title="AgentRow in a ListGroup (an agent on a workspace’s Agents tab: a robot with a dot in the colour of what it wants of the user, or of a run at work, its name over the gadget that starts it and its runs, or over what it wants; it opens its page)">
        <div className="flex w-full max-w-3xl flex-col gap-2">
          <ListGroup label="Agents">
            <AgentRow name="Inbox helper" detail="Started by Inbox · 12 runs · latest 5 min ago" attention={{ words: 'A run is waiting on you', tone: 'warning' }} href="#" onSelect={() => say('opened Inbox helper')} />
            <AgentRow name="Release notes" detail="Started by Changelog · 4 runs · latest yesterday" attention={{ words: 'Its latest run failed', tone: 'danger' }} onSelect={() => say('opened Release notes')} />
            <AgentRow name="Ticket summarizer" detail="Started by Issue triage · 31 runs · latest 2 min ago" running onSelect={() => say('opened Ticket summarizer')} />
            <AgentRow name="An agent with a name long enough to be cut off where the row ends" detail="Started by Forecast · Hasn’t run yet" onSelect={() => say('opened the long one')} />
          </ListGroup>
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
      <Section title="AgentRunRow, in each way a run stands (its mark, its title over how it stands, and whose run it is where the list is not one agent’s; it opens the run’s conversation)">
        <div className="flex w-full max-w-3xl flex-col gap-2">
          <ListGroup label="Runs">
            {(['waiting', 'failed', 'running', 'changes', 'done'] as const).map((status) => (
              <AgentRunRow
                key={status}
                title={status === 'done' ? 'Reply to “Invoice 4471 overdue”, which is long enough to be cut off where the row ends' : `Reply to “${STATUS_WORDS[status]}”`}
                status={status}
                statusWords={STATUS_WORDS[status]}
                agent={status === 'waiting' ? 'Inbox helper' : undefined}
                time="2:14 PM"
                onSelect={() => say(`opened the ${status} run`)}
              />
            ))}
          </ListGroup>
        </div>
      </Section>
      <Section title="AgentsTab (a workspace’s Agents tab: the runs that want the user first, each opening its conversation, then every agent, those that want the user first; loading, could not load, and none yet)">
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {STATES.map((state) => <Button key={state} variant={which === state ? 'primary' : 'secondary'} onClick={() => setWhich(state)}>{state}</Button>)}
          </div>
          <div className="flex flex-col gap-8">
            <AgentsTab
              state={stateOf(which)}
              onRetry={() => say('tried again')}
              onOpenAgent={({ name }) => say(`opened ${name}`)}
              agentHref={() => '#'}
              onOpenRun={({ title }) => say(`opened the run “${title}”`)}
              now={EXAMPLE_NOW.getTime()}
            />
          </div>
        </div>
      </Section>
      <Section title="AgentView (an agent’s page: what wants the user, with the way to that run, the gadgets that start it, its model and how often it has run, then its runs by when, with the way to read more; choose an agent)">
        <div className="flex w-full flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {agents.map(({ key, name }) => <Button key={key} variant={shown === key ? 'primary' : 'secondary'} onClick={() => setShown(key)}>{name}</Button>)}
            <Button variant={shown === BUSY.key ? 'primary' : 'secondary'} onClick={() => setShown(BUSY.key)}>273 runs</Button>
            <Button variant={shown === 'gone' ? 'primary' : 'secondary'} onClick={() => setShown('gone')}>No such agent</Button>
          </div>
          <div className="w-full rounded-3xl bg-kumo-base">
            <AgentView
              state={agent === BUSY ? { status: 'ready', agent, all: false, more: { reading: false, onMore: () => say('read more runs') } } : agent ? { status: 'ready', agent, all: true } : { status: 'gone' }}
              now={EXAMPLE_NOW.getTime()}
              onOpenRun={({ title }) => say(`opened the run “${title}”`)}
              runHref={() => '#'}
              onOpenGadget={() => say('opened the gadget')}
            />
          </div>
        </div>
      </Section>
      <Section title="ChatHeader for an agent’s run (the agent’s crumb after the workspace’s, which goes to the agent’s page)">
        <ChatHeader
          workspace={{ id: 'ops', title: 'Support ops', label: 'SO', onOpen: () => say('opened Support ops') }}
          agent={{ agentKey: '41', name: 'Inbox helper', onOpen: () => say('opened Inbox helper') }}
          title="Reply to “Invoice 4471 overdue”"
          onOpenSettings={() => say('opened the run’s settings')}
        />
      </Section>
      <Section title="What waits on the user, over a workspace’s tabs (Banner’s warning, and its danger) and counted on its Agents tab">
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <Banner tone="warning" title="Inbox helper is waiting on you" description="Its run stopped for your approval or a connection." action={{ label: 'Open run', onSelect: () => say('opened the run') }} />
          <Banner title="Release notes’s latest run failed" description="Open the run to see what went wrong." action={{ label: 'Open run', onSelect: () => say('opened the failed run') }} />
          <Tabs
            value={tab}
            onValueChange={setTab}
            aria-label="Workspace"
            tabs={[{ value: 'chats', label: 'Chats' }, { value: 'agents', label: 'Agents', count: { value: 2, label: 'waiting on you' } }, { value: 'library', label: 'Library' }]}
          >
            <Tabs.Panel value={tab}><span /></Tabs.Panel>
          </Tabs>
        </div>
      </Section>
      <Section title="A workspace in the sidebar with an agent waiting on the user (said in its subtitle’s place, with a dot of its own), expanded and on the rail">
        <div className="flex w-80 flex-col gap-2 rounded-3xl bg-kumo-canvas p-2">
          <WorkspaceListItem workspaceLabel="SO" title="Support ops" subtitle="5 min ago" attention="An agent needs you" onSelect={() => say('opened Support ops')} />
          <WorkspaceListItem workspaceLabel="QF" title="Q3 Forecast" subtitle="Yesterday" unread onSelect={() => say('opened Q3 Forecast')} />
          <div className="flex gap-2">
            <WorkspaceRailItem workspaceLabel="SO" title="Support ops" attention="An agent needs you" onSelect={() => say('opened Support ops')} />
            <WorkspaceRailItem workspaceLabel="QF" title="Q3 Forecast" unread onSelect={() => say('opened Q3 Forecast')} />
          </div>
        </div>
      </Section>
    </>
  )
}
