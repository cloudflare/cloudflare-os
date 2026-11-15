import { useState, type ReactNode } from 'react'
import { ActionCard } from '@/blocks/ActionCard'
import { ConnectedFileView } from '@/blocks/ConnectedFileView'
import { PendingTray, type PendingTrayGroup } from '@/blocks/PendingTray'
import type { ReviewChange } from '@/blocks/ReviewBar'
import { documentFixture } from '@/blocks/resource-preview/fixtures'
import { useOpen, useReport } from './previewState'
import { Section } from './Section'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

const append = (actionId: number, content: string) => ({
  actionId,
  title: 'Append to Google Doc',
  description: 'Adds text to the end of **Weekly notes**.',
  fields: [{ label: 'Content', kind: 'inline' as const, value: content }],
})

const GROUPS: PendingTrayGroup[] = [
  {
    key: 'doc',
    title: 'Weekly notes',
    fileKind: 'document',
    summary: '5 changes',
    holdsAgent: true,
    onReview: () => {},
    requests: [1, 2, 3, 4, 5].map((n) => append(n, `Paragraph ${n} of the summary.`)),
  },
  {
    key: 'sheet',
    title: 'Q3 budget',
    fileKind: 'spreadsheet',
    summary: 'New Google Sheet, with 2 changes',
    holdsAgent: false,
    requests: [
      { actionId: 6, title: 'Create Google Sheet', description: 'Creates **Q3 budget** in My Drive.', fields: [] },
      { actionId: 7, title: 'Write cells', description: 'Writes the totals row.', fields: [{ label: 'Range', kind: 'inline', value: 'A12:D12' }] },
      { actionId: 8, title: 'Write cells', description: 'Writes the header row.', fields: [{ label: 'Range', kind: 'inline', value: 'A1:D1' }] },
    ],
  },
  {
    key: 'jira',
    title: 'Jira · Platform board',
    summary: '1 request',
    holdsAgent: false,
    requests: [{ actionId: 9, title: 'Create issue in PLAT', description: 'Creates a new **Bug** in the Platform project.', fields: [{ label: 'Summary', kind: 'inline', value: 'Export times out' }] }],
  },
]

/** The tray, deciding as a chat would: rows close as what they hold is decided. */
const TrayPreview = ({ restricted }: { restricted?: boolean }) => {
  const { say, later } = useReport()
  const [left, setLeft] = useState(GROUPS)
  const [progress, setProgress] = useState<{ verb: 'Approving' | 'Denying'; done: number; total: number }>()
  const drop = (ids: number[]) => setLeft((groups) => groups
    .map((group) => ({ ...group, requests: group.requests.filter(({ actionId }) => !ids.includes(actionId)) }))
    .filter(({ requests }) => requests.length > 0))
  const all = async (verb: 'Approving' | 'Denying') => {
    const ids = left.flatMap(({ requests }) => requests.map(({ actionId }) => actionId))
    for (const [done] of ids.entries()) {
      setProgress({ verb, done, total: ids.length })
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    setProgress(undefined)
    drop(ids)
  }
  return (
    <div className="flex h-[26rem] flex-col justify-end rounded-xl bg-kumo-tint p-3 ring-1 ring-kumo-line">
      <PendingTray
        groups={left.map((group) => ({ ...group, onReview: group.onReview && (() => say(`review ${group.title}`)) }))}
        restricted={restricted}
        progress={progress}
        onApproveAll={() => all('Approving')}
        onDenyAll={() => all('Denying')}
        onApprove={async (id) => { await later(); drop([id]) }}
        onDeny={async (id) => { await later(); drop([id]) }}
      />
      {left.length === 0 && <button type="button" className="mx-auto text-sm text-kumo-subtle hover:underline" onClick={() => setLeft(GROUPS)}>Ask again</button>}
    </div>
  )
}

const CHANGES: ReviewChange[] = [
  append(101, 'Public launch on November 18'),
  { actionId: 102, title: 'Replace text', description: 'Marks marketing as approved.', fields: [{ label: 'Replace', kind: 'inline', value: 'In review → Approved' }] },
  append(103, 'Localization for German and Japanese'),
]

/** A Google Doc reviewed on itself: decided changes settle or are undone, and the bar moves on. */
const ReviewPreview = ({ restricted }: { restricted?: boolean }) => {
  const { later } = useReport()
  const [decided, setDecided] = useState<ReadonlyMap<number, 'approved' | 'rejected'>>(new Map())
  return (
    <div className="flex h-[30rem] w-full flex-col overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <ConnectedFileView
        preview={documentFixture}
        kind="document"
        review={{
          changes: CHANGES.filter(({ actionId }) => !decided.has(actionId)),
          decided,
          restricted,
          onDecide: async (ids, decision) => {
            await later()
            setDecided((current) => new Map([...current, ...ids.map((id) => [id, decision === 'approve' ? 'approved' : 'rejected'] as const)]))
          },
        }}
      />
      {decided.size === CHANGES.length && (
        <button type="button" className="py-2 text-sm text-kumo-subtle hover:underline" onClick={() => setDecided(new Map())}>Ask again</button>
      )}
    </div>
  )
}

/** Approvals waiting on the chat, grouped by what they change, and reviewed on the file. */
export const PendingPreview = () => {
  const { of } = useOpen(['run'])
  return (
    <>
      <Section title="PendingTray (what waits on you, over the composer, by what it changes: a Google Doc reviewed beside the chat, a new Sheet and a Jira request unfolded here; the dot pulses while the agent waits, Deny all asks once, and rows close as they are decided; then restricted, with no Approve all)">
        <Column>
          <TrayPreview />
          <TrayPreview restricted />
        </Column>
      </Section>
      <Section title="ConnectedFileView with a review, ReviewBar (a Google Doc’s waiting changes decided on it: step with the arrows or click a change on the page, decide one and the bar moves to the next, or all; then restricted, where each is read in full and only it can be approved)">
        <Column>
          <ReviewPreview />
          <ReviewPreview restricted />
        </Column>
      </Section>
      <Section title="ActionCard, folded (a run of decisions on one thing, settled as one card: five appends approved together, unfolded to each)">
        <Column>
          <ActionCard
            {...append(1, '')}
            resource={{ title: 'Weekly notes', url: 'https://docs.google.com/document/d/1' }}
            state="approved"
            resolution="Approved by Ada Lovelace"
            run={[1, 2, 3, 4, 5].map((n) => append(n, `Paragraph ${n} of the summary.`))}
            {...of('run')}
          />
        </Column>
      </Section>
    </>
  )
}
