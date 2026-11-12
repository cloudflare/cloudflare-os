import { useState, type ReactNode } from 'react'
import { FileTextIcon, ImageIcon, WaveformIcon } from '@phosphor-icons/react'
import { ActionCard } from '@/blocks/ActionCard'
import { ConnectionRequestCard } from '@/blocks/ConnectionRequestCard'
import { HookCard } from '@/blocks/HookCard'
import { OutputCard } from '@/blocks/OutputCard'
import { FileListItem } from '@/blocks/FileListItem'
import { FileView } from '@/blocks/FileView'
import { ListGroup } from '@/blocks/ListGroup'
import { OutputListItem } from '@/blocks/OutputListItem'
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
      <Section title="OutputListItem (in the library: a document, an app with no format and a long title, both linking to their page)">
        <Column>
          <OutputListItem title="Q3 platform review" subtitle="Document · Engineering Notes · 4 hours ago" icon="fileText" href="#q3-platform-review" onSelect={() => say('open the document')} />
          <OutputListItem title="Jira dashboard with a title long enough that it has to be cut off" subtitle="App · Platform · Shared by Grace Hopper · Oct 27" href="#jira-dashboard" onSelect={() => say('open the app')} />
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
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
