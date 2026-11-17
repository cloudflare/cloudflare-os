import { useState } from 'react'
import { AgentRow } from '@/blocks/AgentRow'
import { AutomationRow } from '@/blocks/AutomationRow'
import { ChatHeader } from '@/blocks/ChatHeader'
import { ListGroup } from '@/blocks/ListGroup'
import { Button } from '@/components/Button'
import { useReport } from './previewState'
import { Section } from './Section'

type Row = {
  key: string
  kind: 'schedule' | 'event'
  title: string
  when?: string
  standing?: { words: string; tone: 'quiet' | 'warning' }
  description: string
  resource?: { title: string; url?: string }
  gadget: string
  enabled: boolean
  /** Its switch is refused, to show what is said. */
  refuses?: boolean
}

const ROWS: Row[] = [
  {
    key: 'brief', kind: 'schedule', title: 'Morning brief', when: 'Every weekday at 9:00 AM', standing: { words: 'next tomorrow at 9:00 AM', tone: 'quiet' },
    description: 'Gather today’s meetings and what changed overnight, and post a short brief.', gadget: 'Morning brief', enabled: true,
  },
  {
    key: 'digest', kind: 'schedule', title: 'Weekly digest', when: 'Every Friday at 4:30 PM, Chicago time', standing: { words: 'trying again in 12 minutes', tone: 'warning' },
    description: 'Sum up the week’s merged changes for the team channel.', gadget: 'Team digest', enabled: true, refuses: true,
  },
  { key: 'report', kind: 'schedule', title: 'Quarter report', description: 'Draft the quarter’s report from the forecast sheet.', gadget: 'Forecast', enabled: false },
  {
    key: 'stopped', kind: 'schedule', title: 'Inbox sweep', when: 'Every hour', standing: { words: 'Stopped: it no longer had access', tone: 'warning' },
    description: 'Label new email and flag what needs a reply.', gadget: 'Inbox', enabled: true,
  },
  {
    key: 'issue', kind: 'event', title: 'New issue in PLAT', resource: { title: 'Jira · Platform board', url: 'https://jira.example.com/projects/PLAT' },
    description: 'Write a one-line summary of each new ticket as it is created.', gadget: 'Issue triage', enabled: true,
  },
]

const GROUPS = [
  { kind: 'schedule', label: 'Scheduled' },
  { kind: 'event', label: 'When something happens' },
] as const

/**
 * Automations as a workspace's tab and a chat's list them: scheduled ones, saying when they run
 * and when next, a retry warned of and one that stopped; a paused one whose schedule is not known;
 * one an event sets off, with what it watches; and one for whoever may only look. Switches answer
 * after a moment, one refused to show what is said. Then the agents, and a chat's header with its
 * clock, which pops in as the chat's first automation is set up.
 */
export const AutomationsPreview = () => {
  const { report, say, later } = useReport()
  const [rows, setRows] = useState(ROWS)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [count, setCount] = useState(0)

  return (
    <>
      <Section title="AutomationRow in ListGroups (a workspace’s and a chat’s Automations tab: a clock or a bolt, when it runs and when next or why it stopped, or Paused; what it does, what it watches and the gadget it runs, which opens it; its switch waits on the workspace and says why it was refused; and for whoever may only use the workspace, On or Off)">
        <div className="flex w-full max-w-3xl flex-col gap-8">
          {GROUPS.map(({ kind, label }) => (
            <section key={kind} className="flex flex-col gap-2">
              <h2 className="px-4 text-sm font-medium text-kumo-subtle">{label}</h2>
              <ListGroup label={label}>
                {rows.filter((row) => row.kind === kind).map((row) => (
                  <AutomationRow
                    key={row.key}
                    kind={row.kind}
                    title={row.title}
                    when={row.enabled ? row.when : undefined}
                    standing={row.standing}
                    description={row.description}
                    resource={row.resource}
                    gadget={{ title: row.gadget, href: '#', onOpen: () => say(`opened ${row.gadget}`) }}
                    enabled={row.enabled}
                    problem={problems[row.key]}
                    onEnabledChange={async (enabled) => {
                      setProblems(({ [row.key]: _, ...rest }) => rest)
                      await later()
                      if (row.refuses) {
                        setProblems((current) => ({ ...current, [row.key]: `Couldn’t turn it ${enabled ? 'on' : 'off'}: The workspace isn’t answering right now.` }))
                        return
                      }
                      setRows((current) => current.map((each) => (each.key === row.key ? { ...each, enabled } : each)))
                      say(`turned ${row.title} ${enabled ? 'on' : 'off'}`)
                    }}
                  />
                ))}
              </ListGroup>
            </section>
          ))}
          <ListGroup label="Only to look at">
            <AutomationRow kind="event" title="Build failed" description="Post the failing step." gadget={{ title: 'Builds', onOpen: () => say('opened Builds') }} enabled />
            <AutomationRow kind="schedule" title="Nightly backup" gadget={{ title: 'Backups', onOpen: () => say('opened Backups') }} enabled={false} />
          </ListGroup>
          <section className="flex flex-col gap-2">
            <h2 className="px-4 text-sm font-medium text-kumo-subtle">Agents</h2>
            <ListGroup label="Agents">
              <AgentRow name="Inbox helper" runs="12 runs · latest 5 min ago" href="#" onSelect={() => say('opened Inbox helper’s latest run')} />
              <AgentRow name="Ticket summarizer with a name long enough to be cut off where the row ends" runs="One run · latest yesterday" onSelect={() => say('opened the summarizer’s run')} />
            </ListGroup>
          </section>
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
      <Section title="ChatHeader with automations (a clock with how many, after the title, once the chat has set something up to run by itself; it opens the chat’s Automations tab)">
        <div className="flex w-full flex-col items-start gap-3">
          <ChatHeader
            workspace={{ id: 'q3', title: 'Q3 Forecast', label: 'QF', onOpen: () => say('opened Q3 Forecast') }}
            title="Morning brief"
            onOpenSettings={() => say('opened the chat’s settings')}
            automations={count > 0 ? { count, onOpen: () => say('opened the chat’s automations') } : undefined}
          />
          <div className="flex gap-2">
            <Button onClick={() => setCount((current) => current + 1)}>Set one up</Button>
            <Button variant="ghost" disabled={count === 0} onClick={() => setCount(0)}>Delete them</Button>
          </div>
        </div>
      </Section>
    </>
  )
}
