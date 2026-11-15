import { useState } from 'react'
import { AgentRow } from '@/blocks/AgentRow'
import { AgentView, type AgentViewRun } from '@/blocks/AgentView'
import { ListGroup } from '@/blocks/ListGroup'
import { SetUpAgentDialog } from '@/blocks/SetUpAgentDialog'
import { Button } from '@/components/Button'
import { useReport } from './previewState'
import { Section } from './Section'

const MODELS = [
  { id: 'opus', name: 'Claude Opus 5.5' },
  { id: 'sonnet', name: 'Claude Sonnet 5.5' },
  { id: 'haiku', name: 'Claude Haiku 5.5' },
]

const runsOf = (say: (what: string) => void, ...runs: Array<Omit<AgentViewRun, 'onOpen' | 'href'>>) =>
  runs.map((run) => ({ ...run, href: '#', onOpen: () => say(`opened ${run.title}`) }))

/**
 * Agents, as Automations shows them: setting one up from a chat that asked for it, rows among
 * automations (one with runs waiting on a person, one called on by a gadget, one that hasn't run),
 * and an agent's own page, renamed and its model changed after a moment, with its conversations by
 * when, and the same page for one that has done nothing yet.
 */
export const AgentsPreview = () => {
  const { report, say, later } = useReport()
  const [setUp, setSetUp] = useState(false)
  const [name, setName] = useState('Inbox helper')
  const [model, setModel] = useState('sonnet')

  return (
    <>
      <Section title="SetUpAgentDialog (a chat asked for an agent: it is named, given a model, and reports back in the chat unless told not to; set up after a moment)">
        <div className="flex flex-col items-start gap-3">
          <Button onClick={() => setSetUp(true)}>Set up an agent</Button>
          <SetUpAgentDialog
            open={setUp}
            onOpenChange={setSetUp}
            reason="To answer each new support email with a draft, without seeing the others."
            models={MODELS}
            initialModel="sonnet"
            onSetUp={async ({ name: chosen, modelId, reportHere }) => {
              await later()
              say(`set up ${chosen} on ${modelId}${reportHere ? ', reporting here' : ''}`)
            }}
          />
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
      <Section title="AgentRow in a ListGroup (the Agents group of an Automations tab: its model, what calls on it, its runs and how many wait on you; opens its page)">
        <div className="flex w-full max-w-3xl flex-col gap-2">
          <h2 className="px-4 text-sm font-medium text-kumo-subtle">Agents</h2>
          <ListGroup label="Agents">
            <AgentRow name="Inbox helper" model="Claude Sonnet 5.5" calledBy="Called on by Support inbox" runs="48 runs · latest 5 min ago" waiting={2} href="#" onOpen={() => say('opened Inbox helper')} />
            <AgentRow name="Ticket summarizer" model="Claude Haiku 5.5" calledBy="Called on by Issue triage and 2 more" runs="One run · latest yesterday" href="#" onOpen={() => say('opened Ticket summarizer')} />
            <AgentRow name="Research assistant" model="Claude Opus 5.5" runs="Hasn’t run yet" href="#" onOpen={() => say('opened Research assistant')} />
          </ListGroup>
        </div>
      </Section>
      <Section title="AgentView (an agent's page: renamed in place and its model changed, each after a moment; what calls on it, what it can use, and its conversations by when, those waiting on you marked)">
        <div className="w-full rounded-3xl ring-1 ring-kumo-line">
          <AgentView
            name={name}
            onRename={async (next) => { await later(); setName(next); say(`renamed it ${next}`) }}
            models={MODELS}
            modelId={model}
            onModelChange={async (next) => { await later(); setModel(next); say(`changed its model to ${next}`) }}
            calledBy={[
              { title: 'Support inbox', href: '#', onOpen: () => say('opened Support inbox') },
              { title: 'Set up support replies', href: '#', onOpen: () => say('opened the chat') },
            ]}
            access={['Gmail · support@', 'Help center articles']}
            runs={[
              { key: 'today', label: 'Today', runs: runsOf(say, { key: '1', title: 'Refund for order 4417', time: '5 min ago', waiting: true }, { key: '2', title: 'Can’t sign in after reset', time: '2 hours ago' }) },
              { key: 'week', label: 'Since Monday', runs: runsOf(say, { key: '3', title: 'Invoice address change', time: 'Tuesday', waiting: true }, { key: '4', title: 'Shipping to Canada', time: 'Monday' }) },
            ]}
          />
        </div>
      </Section>
      <Section title="AgentView with nothing yet (no model, nothing calling on it, no access, no runs)">
        <div className="w-full rounded-3xl ring-1 ring-kumo-line">
          <AgentView name="Research assistant" models={MODELS} modelId={null} calledBy={[]} access={[]} runs={[]} />
        </div>
      </Section>
    </>
  )
}
