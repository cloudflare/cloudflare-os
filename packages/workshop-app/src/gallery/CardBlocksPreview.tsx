import { useEffect, useState, type ReactNode } from 'react'
import { FileTextIcon, ImageIcon, WaveformIcon } from '@phosphor-icons/react'
import { ActionCard } from '@/blocks/ActionCard'
import { ConnectionRequestCard } from '@/blocks/ConnectionRequestCard'
import { HookCard } from '@/blocks/HookCard'
import { KeepChangesCard } from '@/blocks/KeepChangesCard'
import { OutputCard } from '@/blocks/OutputCard'
import { FileListItem } from '@/blocks/FileListItem'
import { FileView } from '@/blocks/FileView'
import { LibraryRow } from '@/blocks/LibraryRow'
import { ListGroup } from '@/blocks/ListGroup'
import { WorkspaceRow } from '@/blocks/WorkspaceRow'
import { BUDGET_XLSX, Q2_REVIEW_PDF, Q3_PLAN_DOCX, ROADMAP_PPTX } from '@/chat/mock/officeFiles'
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

const OFFICE_SAMPLES = [
  { kind: 'document', name: 'Q3 plan.docx', build: Q3_PLAN_DOCX },
  { kind: 'slides', name: 'Roadmap.pptx', build: ROADMAP_PPTX },
  { kind: 'workbook', name: 'Budget.xlsx', build: BUDGET_XLSX },
] as const

/** An Office file drawn by `FileView`, once its sample package is built. */
const OfficeSample = ({ sample, onDownload }: { sample: (typeof OFFICE_SAMPLES)[number]; onDownload: () => void }) => {
  const [bytes, setBytes] = useState<Uint8Array>()
  useEffect(() => void sample.build().then(setBytes), [sample])
  return bytes ? <FileView kind={sample.kind} name={sample.name} mimeType="" bytes={bytes} onDownload={onDownload} /> : null
}

const TICKETS_CSV = new TextEncoder().encode('Week,Opened,Closed\n1,42,38\n2,51,47\n3,39,44\n')

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
  const [documentStarred, setDocumentStarred] = useState(true)

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
      <Section title="LibraryRow (on the Library page: a starred document, which keeps its star out; an app with no format and a long title, both linking to their page; and one that says only what it is called. The star slides out when a row is pointed at)">
        <Column>
          <ListGroup label="Today">
            <LibraryRow title="Q3 platform review" detail="Document · Engineering Notes" icon="fileText" time="4 hours ago" starred={documentStarred} onStarredChange={setDocumentStarred} href="#q3-platform-review" onSelect={() => say('open the document')} />
            <LibraryRow title="Jira dashboard with a title long enough that it has to be cut off somewhere in the row" detail="App · Platform · Shared by Grace Hopper" time="Oct 27" starred={false} onStarredChange={() => say('star the app')} href="#jira-dashboard" onSelect={() => say('open the app')} />
            <LibraryRow title="Budget 2026" icon="table" starred={false} onStarredChange={() => say('star the spreadsheet')} onSelect={() => say('open the spreadsheet')} />
          </ListGroup>
        </Column>
      </Section>
      <Section title="ListGroup, FileListItem (a chat's files and outputs on its settings page, in a surface for each stretch of time: a busy day on its own, quieter days folded together; a name long enough that it has to be cut off)">
        <Column>
          <ListGroup label="Today">
            <FileListItem title="Q3 platform review" icon={<FileTextIcon aria-hidden="true" />} time="1 hour ago" href="#q3-platform-review" onSelect={() => say('open the document')} />
            <FileListItem title="my-favourite-image.jpg" icon={<ImageIcon aria-hidden="true" />} time="4 hours ago" onSelect={() => say('open the image')} />
          </ListGroup>
          <ListGroup label="Since Monday">
            <FileListItem title="my-song-with-a-name-long-enough-that-it-has-to-be-cut-off-somewhere-in-the-row.wav" icon={<WaveformIcon aria-hidden="true" />} time="Tuesday" onSelect={() => say('open the song')} />
            <FileListItem title="Launch checklist" icon={<FileTextIcon aria-hidden="true" />} time="Monday" onSelect={() => say('open the checklist')} />
          </ListGroup>
        </Column>
      </Section>
      <Section title="GroupedList, WorkspaceRow (the Workspaces page: the starred group, dragged or moved with Alt and an arrow key to reorder, then stretches of time; star or unstar one to see it shrink out of its group and grow into the other, and the groups fold again around it, splitting and merging; the star and more slide out when pointed at, and a starred one keeps its star)">
        <Column>
          <WorkspaceRowsPreview />
        </Column>
      </Section>
      <Section title="FileView (a file in the aside or on its own page: an image, Markdown, text or code as it was written, a PDF page by page, its text selectable and its link followed, with the page in view at the bottom, a Word document, PowerPoint deck and Excel workbook in their own layout, a CSV as a grid, and one that cannot be shown here, which offers the download)">
        <Column>
          <Surface><FileView kind="image" name="favicon.svg" url="/favicon.svg" onDownload={() => say('download the image')} /></Surface>
          <Surface><FileView kind="markdown" name="checklist.md" text={NOTES} onDownload={() => say('download the notes')} /></Surface>
          <Surface><FileView kind="text" name="export.ts" text={'export const timeout = 30_000\n\nexport async function exportAll(ids: string[]) {\n  for (const id of ids) await exportOne(id, { timeout })\n}'} onDownload={() => say('download the code')} /></Surface>
          <Surface><FileView kind="pdf" name="Q2 platform review.pdf" mimeType="application/pdf" bytes={Q2_REVIEW_PDF} onDownload={() => say('download the PDF')} /></Surface>
          {OFFICE_SAMPLES.map((sample) => <Surface key={sample.kind}><OfficeSample sample={sample} onDownload={() => say(`download ${sample.name}`)} /></Surface>)}
          <Surface><FileView kind="delimited" name="tickets.csv" mimeType="text/csv" bytes={TICKETS_CSV} onDownload={() => say('download the CSV')} /></Surface>
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
      <Section title="KeepChangesCard (a chat's changes that couldn't be kept on their own, at the end of the conversation: what they do and why they wait, Keep, and Discard, which asks again; a gadget given a connection, a blueprint's update with conflicts, and code in a workspace others work in too)">
        <Column>
          <KeepChangesCard
            changes={['Makes “Standup notes”', 'Lets “Standup notes” use “Jira · Platform board”']}
            reason="What a gadget can reach is yours to decide."
            onKeep={after('kept')}
            onDiscard={() => void after('discarded')()}
          />
          <KeepChangesCard
            changes={['Brings its blueprint’s update into “Tip Jar”', 'Leaves 2 files with conflicts']}
            reason="Look over the conflicts before keeping them."
            onKeep={after('kept')}
            onDiscard={() => void after('discarded')()}
          />
          <KeepChangesCard changes={[]} reason="Others work in this workspace too, so changes wait for you." onKeep={after('kept')} onDiscard={() => void after('discarded')()} />
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
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
