import { useState } from 'react'
import { AUTOMATION_EXAMPLES } from '@/automations/AutomationsView'
import type { AutomationDetails } from '@/blocks/automationDetails'
import { OutsideAsksRow } from '@/automations/OutsideAsksRow'
import { AutomationRow } from '@/blocks/AutomationRow'
import { AutomationsEmpty } from '@/blocks/AutomationsEmpty'
import { ListGroup } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { ActionEntry } from '@/workspaces/activity/activityEntries'
import { useReport } from './previewState'
import { Section } from './Section'

type Row = Pick<AutomationDetails, 'title' | 'description' | 'resource' | 'enabled'> & {
  key: string
  gadget: string
  /** Its switch and its deletion are refused, to show what is said. */
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
 * what it watches; and two for whoever may only look. Each opens to all of it, and is deleted from
 * there or from more. Switches and deletions answer after a moment, the digest's refused to show
 * what is said.
 */
// Asked outside any chat through a connection no automation is bound to.
const OUTSIDE_ASKS = [40, 90].map((minutes, index) => ({
  id: 900 + index,
  type: 'action',
  gatekeeperId: 15,
  resourceTitle: 'cloudflare/workshop',
  createdAt: new Date(Date.now() - minutes * 60_000),
  state: 'pending',
  description: { title: index === 0 ? 'Open an issue “Flaky export test”' : 'Label PR #2210 as ready', description: '', implementsRevert: false, autoApprovable: true },
}) as ActionEntry)

export const AutomationsPreview = () => {
  const { report, say, later } = useReport()
  const [rows, setRows] = useState(ROWS)
  const [problems, setProblems] = useState<Record<string, string>>({})

  return (
    <>
      <Section title="Waiting on you (first on a workspace’s Automations tab: what was asked outside any chat, put down to the automation whose gadget is bound to the connection it went through, with a pill and the first ask as its second line; and what no one automation could have asked, in a row of its own that goes to the workspace’s apps)">
        <div className="flex w-full max-w-3xl flex-col gap-2">
          <h2 className="px-4 text-sm font-medium text-kumo-subtle">Waiting on you</h2>
          <ListGroup label="Waiting on you">
            <OutsideAsksRow asks={OUTSIDE_ASKS} href="#" onOpen={() => say('went to the apps')} />
            <AutomationRow
              title="When a meeting is booked"
              description="Adds a design review the day before, for whoever is presenting."
              resource={{ title: 'Google Calendar · Team' }}
              gadget={{ title: 'Team calendar', href: '#', onOpen: () => say('opened Team calendar') }}
              enabled
              onEnabledChange={() => say('switched it')}
              onDelete={() => say('deleted it')}
              waiting={{ words: '2 approvals', first: 'Add “Design review” to Team calendar and 1 more' }}
            />
          </ListGroup>
        </div>
      </Section>
      <Section title="AutomationRow in ListGroups (a workspace’s and a chat’s Automations tab: a bolt, its name over what it watches; Off for whoever has no switch, its switch, and more, which deletes it; the row opens AutomationDialog, with Delete at its foot; and for whoever may only use the workspace, no switch)">
        <div className="flex w-full max-w-3xl flex-col gap-8">
          {GROUPS.map(({ key, label, has }) => (
            <section key={key} className="flex flex-col gap-2">
              <h2 className="px-4 text-sm font-medium text-kumo-subtle">{label}</h2>
              <ListGroup label={label}>
                {rows.filter(has).map(({ key, gadget, refuses, ...row }) => (
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
            <AutomationRow title="Build failed" resource={{ title: 'GitHub · builds' }} description="Post the failing step." gadget={{ title: 'Builds', onOpen: () => say('opened Builds') }} enabled />
            <AutomationRow title="Nightly backup" gadget={{ title: 'Backups', onOpen: () => say('opened Backups') }} enabled={false} />
          </ListGroup>
          <button type="button" className="self-start text-sm text-kumo-subtle underline" onClick={() => setRows(ROWS)}>Put them all back</button>
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
      <Section title="AutomationRow on the Automations page (among every workspace’s, so it says which it is in, which its dialog and more go to)">
        <div className="w-full max-w-3xl">
          <ListGroup label="On">
            <AutomationRow
              title="Morning brief"
              description="Gather today’s meetings and what changed overnight, and post a short brief."
              workspace={{ title: 'Q3 Forecast', icon: <WorkspaceIcon label="QF" small />, onOpen: () => say('opened Q3 Forecast') }}
              gadget={{ title: 'Morning brief', onOpen: () => say('opened Morning brief') }}
              enabled
              onEnabledChange={async () => {}}
              onDelete={async () => { await later(); say('deleted Morning brief') }}
            />
          </ListGroup>
        </div>
      </Section>
      <Section title="AutomationsEmpty (the Automations page with nothing on it: what an automation does, and things to ask for, each starting a chat with it written in the composer)">
        <div className="w-full max-w-2xl">
          <AutomationsEmpty examples={AUTOMATION_EXAMPLES} onTry={(prompt) => say(`started a chat with “${prompt}”`)} onAdd={() => say('started a chat with “Set up an automation that ”')} />
        </div>
      </Section>
    </>
  )
}
