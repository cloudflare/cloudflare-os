import { useState } from 'react'
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
  place: { kind: 'chat' | 'gadget'; label: string }
  enabled: boolean
  /** Its switch is refused, to show what is said. */
  refuses?: boolean
}

const ROWS: Row[] = [
  {
    key: 'brief', kind: 'schedule', title: 'Morning brief', when: 'Every weekday at 9:00 AM', standing: { words: 'next tomorrow at 9:00 AM', tone: 'quiet' },
    description: 'Gather today’s meetings and what changed overnight, and post a short brief.', place: { kind: 'chat', label: 'Morning brief · Q3 Forecast' }, enabled: true,
  },
  {
    key: 'digest', kind: 'schedule', title: 'Weekly digest', when: 'Every Friday at 4:30 PM, Chicago time', standing: { words: 'trying again in 12 minutes', tone: 'warning' },
    description: 'Sum up the week’s merged changes for the team channel.', place: { kind: 'gadget', label: 'Team digest' }, enabled: true, refuses: true,
  },
  {
    key: 'report', kind: 'schedule', title: 'Quarter report', when: 'Once, on Dec 1 at 8:00 AM',
    description: 'Draft the quarter’s report from the forecast sheet.', place: { kind: 'chat', label: 'Quarter report' }, enabled: false,
  },
  {
    key: 'stopped', kind: 'schedule', title: 'Inbox sweep', when: 'Every hour', standing: { words: 'Stopped: it no longer had access', tone: 'warning' },
    description: 'Label new email and flag what needs a reply.', place: { kind: 'chat', label: 'Inbox' }, enabled: true,
  },
  {
    key: 'issue', kind: 'event', title: 'New issue in PLAT', when: 'Watches Jira · Platform board',
    description: 'Write a one-line summary of each new ticket as it is created.', place: { kind: 'gadget', label: 'Issue triage' }, enabled: true,
  },
]

/**
 * Automations as their tabs list them: scheduled ones, saying when they run and when next, a retry
 * warned of and one that stopped; a paused one; and one an event sets off. Switches answer after a
 * moment, one refused to show what is said, and Delete asks first. Then a chat's header with its
 * clock, which pops in as the chat's first automation is set up.
 */
export const AutomationsPreview = () => {
  const { report, say, later } = useReport()
  const [rows, setRows] = useState(ROWS)
  const [count, setCount] = useState(0)
  const set = (key: string, change: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)))

  return (
    <>
      <Section title="AutomationRow in ListGroups (the Automations tabs of the Library, a workspace, a chat and a gadget: a clock or a bolt, when it runs and when next or why it stopped, what it does and where it reports; its switch waits on the server and says why it was refused; More opens where it reports and deletes it once asked)">
        <div className="flex w-full max-w-3xl flex-col gap-6">
          {(['schedule', 'event'] as const).map((kind) => (
            <section key={kind} className="flex flex-col gap-2">
              <h2 className="px-4 text-sm font-medium text-kumo-subtle">{kind === 'schedule' ? 'Scheduled' : 'When something happens'}</h2>
              <ListGroup label={kind === 'schedule' ? 'Scheduled' : 'When something happens'}>
                {rows.filter((row) => row.kind === kind).map((row) => (
                  <AutomationRow
                    key={row.key}
                    kind={row.kind}
                    title={row.title}
                    when={row.when}
                    standing={row.standing}
                    description={row.description}
                    place={{ ...row.place, href: '#', onOpen: () => say(`opened ${row.place.label}`) }}
                    enabled={row.enabled}
                    onEnabledChange={async (enabled) => {
                      await later()
                      if (row.refuses) throw new Error('The scheduler isn’t answering right now.')
                      set(row.key, { enabled })
                      say(`turned ${row.title} ${enabled ? 'on' : 'off'}`)
                    }}
                    onDelete={async () => {
                      await later()
                      setRows((current) => current.filter(({ key }) => key !== row.key))
                      say(`deleted ${row.title}`)
                      return true
                    }}
                  />
                ))}
              </ListGroup>
            </section>
          ))}
          <AutomationRow kind="event" title="Build failed" description="Post the failing step." enabled place={{ kind: 'chat', label: 'Builds', onOpen: () => {} }} />
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
          {rows.length < ROWS.length && <Button className="self-start" onClick={() => setRows(ROWS)}>Bring them back</Button>}
        </div>
      </Section>
      <Section title="ChatHeader with automations (a clock at the far end once the chat has set something up to run by itself, which opens the chat’s Automations tab)">
        <div className="flex w-full flex-col items-start gap-3">
          <div className="flex w-full items-center gap-1.5">
            <ChatHeader
              workspace={{ id: 'q3', title: 'Q3 Forecast', label: 'QF', onOpen: () => say('opened Q3 Forecast') }}
              title="Morning brief"
              onOpenSettings={() => say('opened the chat’s settings')}
              automations={count > 0 ? { count, onOpen: () => say('opened the chat’s automations') } : undefined}
              onShare={() => say('opened sharing')}
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setCount((current) => current + 1)}>Set one up</Button>
            <Button variant="ghost" disabled={count === 0} onClick={() => setCount(0)}>Delete them</Button>
          </div>
        </div>
      </Section>
      <Section title="ChatHeader with agents the chat’s agent started (AgentsMenu in the clock’s place, saying which ran last and when; its menu leads to each one’s runs, then the chat’s automations). In a narrow chat, such as one with a gadget beside it, the spark alone">
        <div className="flex w-full flex-col items-start gap-3">
          {['w-full', 'w-96'].map((width) => (
            <div key={width} className={`@container relative flex ${width} items-center gap-1.5`}>
              <ChatHeader
                workspace={{ id: 'q3', title: 'Q3 Forecast', label: 'QF', onOpen: () => say('opened Q3 Forecast') }}
                title="Morning brief"
                onOpenSettings={() => say('opened the chat’s settings')}
                automations={{ count: 1, onOpen: () => say('opened the chat’s automations') }}
                agents={{
                  agents: [{ key: '9', name: 'Inbox sorter', runs: '31 runs · latest 12 min ago' }],
                  latest: '12 min ago',
                  onOpenAgent: () => say('opened Inbox sorter’s page, with its runs'),
                  onOpenAutomations: () => say('opened the chat’s automations'),
                }}
                onShare={() => say('opened sharing')}
              />
            </div>
          ))}
        </div>
      </Section>
    </>
  )
}
