import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Badge } from '@cloudflare/kumo'
import type { IssueReport, IssueReportEntry } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { IssueImages } from './IssueImages'
import { ISSUE_STATUS_NAMES } from './issueLabels'

const When = ({ at }: { at: Date }) => (
  <time dateTime={at.toISOString()} className="text-xs text-kumo-subtle">{formatFullTimestamp(at)}</time>
)

// One entry of the thread. Its author is shown by name alone and the row is keyed by the entry's
// id: an admin's entry carries no author id where the reporter reads it. An entry is an admin's
// when it says how their call reached the deployment.
const Entry = ({ entry }: { entry: IssueReportEntry }) => {
  if (entry.text === '') {
    if (entry.status === undefined) return null
    return (
      <li className="flex flex-wrap items-baseline gap-x-2 px-1 text-xs text-kumo-subtle">
        <span>{entry.author.name} set the status to {ISSUE_STATUS_NAMES[entry.status]}</span>
        <When at={entry.at} />
      </li>
    )
  }
  return (
    <li className="rounded-xl border border-kumo-line bg-kumo-elevated px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-kumo-default">{entry.author.name}</span>
        {entry.via !== undefined && <Badge variant="outline">Admin</Badge>}
        <When at={entry.at} />
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-kumo-default">{entry.text}</p>
      {entry.status !== undefined && (
        <p className="mt-2 text-xs text-kumo-subtle">Status: {ISSUE_STATUS_NAMES[entry.status]}</p>
      )}
    </li>
  )
}

/**
 * One issue report as a conversation: what its reporter wrote, where they were, the images they
 * sent, and the thread's entries, oldest first. A written entry shows its author, time and text;
 * a bare change of status is one quiet line naming who made it. Every text is rendered as plain
 * text. What the reader writes with is passed as children and sits beneath the thread.
 */
export const IssueThread = ({ report, entries, readImage, children }: {
  report: IssueReport
  entries: IssueReportEntry[]
  /** Reads the bytes of one of the report's images, by its id. */
  readImage: (imageId: string) => Promise<ReadableStream<Uint8Array>>
  children?: ReactNode
}) => {
  const { workspaceId } = report.context
  return (
    <div className="space-y-4">
      <section aria-label="Report" className="space-y-3">
        <p className="whitespace-pre-wrap break-words text-sm text-kumo-default">{report.text}</p>
        <p className="text-xs text-kumo-subtle">
          Filed by {report.reporter.name}{' '}
          <When at={report.filedAt} />
          {workspaceId === undefined ? ', outside a workspace' : (
            <>
              {' in '}
              <Link to="/workspace/$id" params={{ id: workspaceId }} className="text-kumo-brand hover:underline">
                this workspace
              </Link>
            </>
          )}
        </p>
        {/* Keyed by the report, so that one report's images are let go of when another is shown. */}
        <IssueImages key={report.id} images={report.images} read={readImage} />
      </section>
      {entries.length === 0 ? (
        <p className="text-sm text-kumo-subtle">Nobody has replied yet.</p>
      ) : (
        <ol aria-label="Thread" className="space-y-3">
          {entries.map((entry) => <Entry key={entry.id} entry={entry} />)}
        </ol>
      )}
      {children}
    </div>
  )
}
