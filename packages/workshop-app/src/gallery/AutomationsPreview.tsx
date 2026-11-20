import { useState } from 'react'
import { AUTOMATION_EXAMPLES } from '@/automations/AutomationsView'
import type { AutomationDetails } from '@/blocks/automationDetails'
import { AutomationRow } from '@/blocks/AutomationRow'
import { AutomationsEmpty } from '@/blocks/AutomationsEmpty'
import { ListGroup } from '@/blocks/ListGroup'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useReport } from './previewState'
import { Section } from './Section'

type Row = Pick<AutomationDetails, 'kind' | 'title' | 'when' | 'next' | 'note' | 'description' | 'resource' | 'enabled'> & {
  key: string
  gadget: string
  /** Its switch and its deletion are refused, to show what is said. */
  refuses?: boolean
}

const ROWS: Row[] = [
  {
    key: 'brief', kind: 'schedule', title: 'Morning brief', when: 'Every weekday at 9:00 AM', next: { soon: 'tomorrow', at: 'tomorrow at 9:00 AM' },
    description: 'Gather today’s meetings and what changed overnight, and post a short brief.', gadget: 'Morning brief', enabled: true,
  },
  {
    key: 'hello', kind: 'schedule', title: 'Weekly hello', when: 'Every Monday at 8:00 AM, Lisbon time', next: { soon: 'in 3 days', at: 'Monday at 8:00 AM' },
    description: 'Sends “hello” into this chat every Monday at 8 am Lisbon time.', gadget: 'Weekly hello', enabled: true,
  },
  {
    key: 'digest', kind: 'schedule', title: 'Weekly digest', when: 'Every Friday at 4:30 PM, Chicago time', note: { words: 'Failed, trying again in 12 minutes', tone: 'warning' },
    description: 'Sum up the week’s merged changes for the team channel.', gadget: 'Team digest', enabled: true, refuses: true,
  },
  {
    key: 'stopped', kind: 'schedule', title: 'Inbox sweep', when: 'Every hour', note: { words: 'Stopped: it no longer had access', tone: 'warning' },
    description: 'Label new email and flag what needs a reply.', gadget: 'Inbox', enabled: true,
  },
  { key: 'report', kind: 'schedule', title: 'Quarter report', description: 'Draft the quarter’s report from the forecast sheet.', gadget: 'Forecast', enabled: false },
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
 * and how soon next, a retry warned of and one that stopped; one that is off, whose schedule is
 * not known; one an event sets off, with what it watches; and two for whoever may only look. Each
 * opens to all of it, and is deleted from there or from more. Switches and deletions answer after
 * a moment, the digest's refused to show what is said.
 */
export const AutomationsPreview = () => {
  const { report, say, later } = useReport()
  const [rows, setRows] = useState(ROWS)
  const [problems, setProblems] = useState<Record<string, string>>({})

  return (
    <>
      <Section title="AutomationRow in ListGroups (a workspace’s and a chat’s Automations tab: a clock or a bolt, its name over when it runs, or why it stopped; how soon it runs next or Off, its switch, and more, which deletes it; the row opens AutomationDialog, with Delete at its foot; and for whoever may only use the workspace, no switch)">
        <div className="flex w-full max-w-3xl flex-col gap-8">
          {GROUPS.map(({ kind, label }) => (
            <section key={kind} className="flex flex-col gap-2">
              <h2 className="px-4 text-sm font-medium text-kumo-subtle">{label}</h2>
              <ListGroup label={label}>
                {rows.filter((row) => row.kind === kind).map(({ key, gadget, refuses, ...row }) => (
                  <AutomationRow
                    key={key}
                    {...row}
                    gadget={{ title: gadget, href: '#', onOpen: () => say(`opened ${gadget}`) }}
                    problem={problems[key]}
                    onEnabledChange={async (enabled) => {
                      setProblems(({ [key]: _, ...rest }) => rest)
                      await later()
                      if (refuses) {
                        setProblems((current) => ({ ...current, [key]: `Couldn’t turn it ${enabled ? 'on' : 'off'}: The workspace isn’t answering right now.` }))
                        return
                      }
                      setRows((current) => current.map((each) => (each.key === key ? { ...each, enabled } : each)))
                      say(`turned ${row.title} ${enabled ? 'on' : 'off'}`)
                    }}
                    onDelete={async () => {
                      await later()
                      if (refuses) throw new Error('The workspace isn’t answering right now.')
                      setRows((current) => current.filter((each) => each.key !== key))
                      say(`deleted ${row.title}`)
                    }}
                  />
                ))}
              </ListGroup>
            </section>
          ))}
          <ListGroup label="Only to look at">
            <AutomationRow kind="event" title="Build failed" resource={{ title: 'GitHub · builds' }} description="Post the failing step." gadget={{ title: 'Builds', onOpen: () => say('opened Builds') }} enabled />
            <AutomationRow kind="schedule" title="Nightly backup" gadget={{ title: 'Backups', onOpen: () => say('opened Backups') }} enabled={false} />
          </ListGroup>
          <button type="button" className="self-start text-sm text-kumo-subtle underline" onClick={() => setRows(ROWS)}>Put them all back</button>
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
      <Section title="AutomationRow on the Automations page (among every workspace’s, so it says which it is in, which its dialog and more go to)">
        <div className="w-full max-w-3xl">
          <ListGroup label="Scheduled">
            <AutomationRow
              kind="schedule"
              title="Weekly Hello to Balint"
              when="Every Monday at 8:00 AM"
              next={{ soon: 'in 3 days', at: 'Monday at 8:00 AM' }}
              description="Sends ‘hello balint’ into this chat every Monday at 8 am Lisbon time."
              workspace={{ title: 'DesEng Team', icon: <WorkspaceIcon label="DT" small />, onOpen: () => say('opened DesEng Team') }}
              gadget={{ title: 'Weekly Hello Automation', onOpen: () => say('opened Weekly Hello Automation') }}
              enabled
              onEnabledChange={async () => {}}
              onDelete={async () => { await later(); say('deleted Weekly Hello to Balint') }}
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
