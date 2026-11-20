import { useState } from 'react'
import { AUTOMATION_EXAMPLES } from '@/automations/AutomationsView'
import { AutomationRow } from '@/blocks/AutomationRow'
import { AutomationsEmpty } from '@/blocks/AutomationsEmpty'
import { ListGroup } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useReport } from './previewState'
import { Section } from './Section'

type Row = {
  key: string
  title: string
  description: string
  resource?: { title: string; url?: string }
  gadget: string
  enabled: boolean
  /** Its switch is refused, to show what is said. */
  refuses?: boolean
}

const ROWS: Row[] = [
  { key: 'brief', title: 'Morning brief', description: 'Gather today’s meetings and what changed overnight, and post a short brief.', gadget: 'Morning brief', enabled: true },
  { key: 'digest', title: 'Weekly digest', description: 'Sum up the week’s merged changes for the team channel.', gadget: 'Team digest', enabled: true, refuses: true },
  { key: 'report', title: 'Quarter report', description: 'Draft the quarter’s report from the forecast sheet.', gadget: 'Forecast', enabled: false },
  {
    key: 'issue', title: 'New issue in PLAT', resource: { title: 'Jira · Platform board', url: 'https://jira.example.com/projects/PLAT' },
    description: 'Write a one-line summary of each new ticket as it is created.', gadget: 'Issue triage', enabled: true,
  },
]

const GROUPS = [
  { key: 'on', label: 'On', has: (row: Row) => row.enabled },
  { key: 'paused', label: 'Paused', has: (row: Row) => !row.enabled },
] as const

/**
 * Automations as a workspace's tab and a chat's list them: those on, then those paused, one with
 * what it watches; and some for whoever may only look. Switches answer
 * after a moment, one refused to show what is said.
 */
export const AutomationsPreview = () => {
  const { report, say, later } = useReport()
  const [rows, setRows] = useState(ROWS)
  const [problems, setProblems] = useState<Record<string, string>>({})

  return (
    <>
      <Section title="AutomationRow in ListGroups (a workspace’s and a chat’s Automations tab: its name, Paused while off; what it does, what it watches and the gadget it runs, which opens it; its switch waits on the workspace and says why it was refused; and for whoever may only use the workspace, On or Off)">
        <div className="flex w-full max-w-3xl flex-col gap-8">
          {GROUPS.map(({ key, label, has }) => (
            <section key={key} className="flex flex-col gap-2">
              <h2 className="px-4 text-sm font-medium text-kumo-subtle">{label}</h2>
              <ListGroup label={label}>
                {rows.filter(has).map((row) => (
                  <AutomationRow
                    key={row.key}
                    title={row.title}
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
            <AutomationRow title="Build failed" description="Post the failing step." gadget={{ title: 'Builds', onOpen: () => say('opened Builds') }} enabled />
            <AutomationRow title="Nightly backup" gadget={{ title: 'Backups', onOpen: () => say('opened Backups') }} enabled={false} />
          </ListGroup>
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
      <Section title="AutomationRow on the Automations page (among every workspace’s, so it says which it is in, under its icon, which opens it)">
        <div className="w-full max-w-2xl">
          <ListGroup label="On">
            <AutomationRow
              title="Morning brief"
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
