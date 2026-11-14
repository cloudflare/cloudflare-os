import { useState, type ReactNode } from 'react'
import { ActionCard } from '@/blocks/ActionCard'
import { ConnectionRequestCard } from '@/blocks/ConnectionRequestCard'
import { HookCard } from '@/blocks/HookCard'
import { KeepChangesCard } from '@/blocks/KeepChangesCard'
import { ReportMessage } from '@/blocks/ReportMessage'
import { OutputCard } from '@/blocks/OutputCard'
import { FileView } from '@/blocks/FileView'
import { WorkspaceRow } from '@/blocks/WorkspaceRow'
import { groupByTime } from '@/chat/timeGroups'
import { GroupedList, type GroupedListGroup } from '@/components/GroupedList'
import { formatActivity } from '@/workspaces/formatActivity'
import { useOpen, useReport } from './previewState'
import { Section } from './Section'
import { fields } from './ToolBlocksPreview'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

// The pane's surface, as tall as a pane would be short.
const Surface = ({ children }: { children: ReactNode }) => (
  <div className="flex h-80 w-full flex-col overflow-hidden rounded-xl bg-kumo-tint ring-1 ring-kumo-line">{children}</div>
)

const NOTES = `# Launch checklist

- [x] Error rates under **0.1%** for a week
- [ ] Docs reviewed by \`@grace\`

> Ship it on a Tuesday.`

const request = {
  title: 'Create issue in PLAT',
  description: 'Creates a new **Bug** in the Platform project.',
  resource: { title: 'Jira · Platform board', url: 'https://jira.example.com/projects/PLAT' },
  fields: fields.slice(0, 5),
}

// Hours before now that each was last active: today's, yesterday's, and older ones, so that starring
// one can fold a day too quiet to stand alone into the one before it.
const previewWorkspaces = [
  { id: 'engineering', title: 'Engineering', label: 'EN', hoursAgo: 1 },
  { id: 'design', title: 'Design', label: 'DE', hoursAgo: 26 },
  { id: 'one', title: 'Workspace 1', label: 'W1', hoursAgo: 2 },
  { id: 'two', title: 'Workspace 2 with a title long enough that it has to be cut off somewhere in the row', label: 'W2', hoursAgo: 3 },
  { id: 'three', title: 'Workspace 3', label: 'W3', hoursAgo: 30 },
  { id: 'four', title: 'Workspace 4', label: 'W4', hoursAgo: 50 },
  { id: 'five', title: 'Workspace 5', label: 'W5', hoursAgo: 75 },
]

const WorkspaceRowsPreview = () => {
  const { say } = useReport()
  const [now] = useState(() => Date.now())
  const [starred, setStarred] = useState(['engineering', 'design'])
  const rowOf = (workspace: (typeof previewWorkspaces)[number], time?: string) => ({
    key: workspace.id,
    content: (
      <WorkspaceRow
        workspaceLabel={workspace.label}
        title={workspace.title}
        time={time}
        starred={starred.includes(workspace.id)}
        onStarredChange={(on) => setStarred((current) => (on ? [workspace.id, ...current] : current.filter((other) => other !== workspace.id)))}
        href={`#${workspace.id}`}
        onSelect={() => say(`open ${workspace.title}`)}
      />
    ),
  })
  const at = (workspace: (typeof previewWorkspaces)[number]) => new Date(now - workspace.hoursAgo * 60 * 60 * 1000)
  const rest = groupByTime(previewWorkspaces.filter(({ id }) => !starred.includes(id)).map((workspace) => ({ value: workspace, at: at(workspace) })))
  const groups: GroupedListGroup[] = [
    ...(starred.length > 0
      ? [{
          key: 'starred',
          label: 'Starred',
          rows: starred.map((id) => {
            const workspace = previewWorkspaces.find((candidate) => candidate.id === id)!
            return rowOf(workspace, formatActivity(at(workspace)))
          }),
          onReorder: setStarred,
        }]
      : []),
    ...rest.map(({ key, label, entries }) => ({ key: `time:${key}`, label, rows: entries.map(({ value, time }) => rowOf(value, time)) })),
  ]

  return <GroupedList groups={groups} />
}

/** What an answer produces or asks for: the cards kept under it. */
export const CardBlocksPreview = () => {
  const { of } = useOpen()
  const { report, say, after, later } = useReport()
  const [hookEnabled, setHookEnabled] = useState(true)

  return (
    <>
      <Section title="OutputCard (draft document, accepted document that links to its page so it opens in another tab with a modifier, app with no format, worktree)">
        <Column>
          <OutputCard title="Q3 platform review" kind="gadget" draft format={{ noun: 'Document', icon: 'fileText' }} onOpen={() => say('open the draft document')} />
          <OutputCard title="Q3 platform review" kind="gadget" format={{ noun: 'Document', icon: 'fileText' }} href="#q3-platform-review" onOpen={() => say('open the document')} />
          <OutputCard title="Jira dashboard with a title long enough that it has to be cut off" kind="gadget" draft onOpen={() => say('open the app')} />
          <OutputCard title="Fix export timeout" kind="worktree" onOpen={() => say('open the worktree')} />
        </Column>
      </Section>
      <Section title="GroupedList, WorkspaceRow (the Workspaces page: the starred group, dragged or moved with Alt and an arrow key to reorder, then stretches of time; star or unstar one to see it shrink out of its group and grow into the other, and the groups fold again around it, splitting and merging; the star and more slide out when pointed at, and a starred one keeps its star)">
        <Column>
          <WorkspaceRowsPreview />
        </Column>
      </Section>
      <Section title="FileView (a file in the aside or on its own page: an image, Markdown, text or code as it was written, and one that cannot be shown here, which offers the download)">
        <Column>
          <Surface><FileView kind="image" name="favicon.svg" url="/favicon.svg" onDownload={() => say('download the image')} /></Surface>
          <Surface><FileView kind="markdown" name="checklist.md" text={NOTES} onDownload={() => say('download the notes')} /></Surface>
          <Surface><FileView kind="text" name="export.ts" text={'export const timeout = 30_000\n\nexport async function exportAll(ids: string[]) {\n  for (const id of ids) await exportOne(id, { timeout })\n}'} onDownload={() => say('download the code')} /></Surface>
          <Surface><FileView kind="none" name="Q3 forecast.xlsx" details="application/vnd.ms-excel · 48KB" onDownload={() => say('download the spreadsheet')} /></Surface>
        </Column>
      </Section>
      <Section title="ActionCard (the request opens from every card but the restricted one, which shows it in full: pending, with a standing approval, incomplete, restricted and incomplete, approved, denied)">
        <Column>
          <ActionCard {...request} state="pending" onApprove={after('approved')} onDeny={after('denied')} {...of('pending')} />
          <ActionCard
            title="Add label “dashboard” to PLAT-212"
            description=""
            fields={[{ label: 'Label', kind: 'inline', value: 'dashboard' }]}
            state="pending"
            onApprove={after('approved')}
            onDeny={after('denied')}
            onAlwaysApprove={after('always approve')}
            {...of('standing')}
          />
          <ActionCard {...request} state="pending" incomplete onApprove={after('approved')} onDeny={after('denied')} {...of('incomplete')} />
          <ActionCard {...request} fields={fields} state="pending" restricted incomplete onApprove={after('approved')} onDeny={after('denied')} onAlwaysApprove={after('always approve')} {...of('restricted')} />
          <ActionCard {...request} state="approved" resolution="Approved by Ada Lovelace" {...of('approved')} />
          <ActionCard {...request} state="denied" resolution="Denied by Ada Lovelace" {...of('denied')} />
        </Column>
      </Section>
      <Section title="HookCard (switchable, off, deleted)">
        <Column>
          <HookCard
            title="New issue in PLAT"
            description="Runs `OnNewIssue` when a ticket is created on the board."
            resource={{ title: 'Jira · Platform board', url: 'https://jira.example.com/projects/PLAT' }}
            enabled={hookEnabled}
            onEnabledChange={async (enabled) => {
              await later()
              setHookEnabled(enabled)
            }}
          />
          <HookCard title="Daily digest" enabled={false} onEnabledChange={after('hook switched')} />
          <HookCard title="Old webhook" description="Removed from the gadget." enabled={false} />
        </Column>
      </Section>
      <Section title="ConnectionRequestCard (pending, connected, denied, no logo)">
        <Column>
          <ConnectionRequestCard vendorName="Cloudflare" logoUrl="/favicon.svg" scope="Workers account" reason="To read last week’s error rates." state="pending" onSetUp={after('set up')} onDeny={after('connection denied')} />
          <ConnectionRequestCard vendorName="Cloudflare" logoUrl="/favicon.svg" scope="Workers account" reason="To read last week’s error rates." state="connected" />
          <ConnectionRequestCard vendorName="Grafana" logoUrl="/missing.svg" scope="Grafana dashboard" reason="To overlay deploy markers on the error-rate chart." state="denied" />
        </Column>
      </Section>
      <Section title="KeepChangesCard (changes that give access, an update with conflicts, code others work on too; Discard asks again)">
        <Column>
          <KeepChangesCard
            changes={['Makes “Standup notes”', 'Gives “Standup notes” access to env.JIRA']}
            reason="What a gadget can reach is yours to decide."
            onKeep={after('kept')}
            onDiscard={after('discarded')}
          />
          <KeepChangesCard
            changes={['Brings its blueprint’s update into “Tip Jar”', 'Leaves 2 files with conflicts']}
            reason="Look over the conflicts before keeping them."
            onKeep={after('kept')}
            onDiscard={after('discarded')}
          />
          <KeepChangesCard changes={[]} reason="Others work on these gadgets too, so changes wait for you." onKeep={after('kept')} onDiscard={after('discarded')} />
        </Column>
      </Section>
      <Section title="ReportMessage (what an agent the chat set up found on a run, with the way into the run)">
        <Column>
          <ReportMessage
            agentName="Morning digest"
            text={'Three new issues in **PLAT** since yesterday:\n\n- PLAT-231 Login loop on Safari\n- PLAT-232 Export times out\n- PLAT-233 Typo on pricing page'}
            href="#run"
            onOpenRun={after('run opened')}
          />
        </Column>
      </Section>
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
