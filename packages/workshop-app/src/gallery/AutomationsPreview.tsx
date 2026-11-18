import { useState } from 'react'
import { AUTOMATION_EXAMPLES } from '@/automations/AutomationsView'
import { AutomationRow } from '@/blocks/AutomationRow'
import { AutomationsEmpty } from '@/blocks/AutomationsEmpty'
import { ListGroup } from '@/blocks/ListGroup'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
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
 * after a moment, one refused to show what is said.
 */
export const AutomationsPreview = () => {
  const { report, say, later } = useReport()
  const [rows, setRows] = useState(ROWS)
  const [problems, setProblems] = useState<Record<string, string>>({})

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
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
      <Section title="AutomationRow on the Automations page (among every workspace’s, so it says which it is in, under its icon, which opens it)">
        <div className="w-full max-w-2xl">
          <ListGroup label="Scheduled">
            <AutomationRow
              kind="schedule"
              title="Morning brief"
              when="Every weekday at 9:00 AM"
              standing={{ words: 'next tomorrow at 9:00 AM', tone: 'quiet' }}
              description="Gather today’s meetings and what changed overnight, and post a short brief."
              workspace={{ title: 'Q3 Forecast', icon: <WorkspaceIcon label="QF" small />, onOpen: () => say('opened Q3 Forecast') }}
              gadget={{ title: 'Morning brief', onOpen: () => say('opened Morning brief') }}
              enabled
              onEnabledChange={async () => {}}
            />
          </ListGroup>
        </div>
      </Section>
      <Section title="AutomationsEmpty (the Automations page with nothing on it: what an automation does, and things to ask for, each starting a chat with it written in the composer)">
        <div className="w-full max-w-2xl">
          <AutomationsEmpty examples={AUTOMATION_EXAMPLES} onTry={(prompt) => say(`started a chat with “${prompt}”`)} />
        </div>
      </Section>
    </>
  )
}
