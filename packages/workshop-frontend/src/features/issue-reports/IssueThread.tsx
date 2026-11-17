import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Badge } from '@cloudflare/kumo'
import type { AdminAgentOrigin, IssueReport, IssueReportEntry } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { IssueImages } from './IssueImages'
import { ADMIN_ISSUE_STATUS_NAMES, ASSIGNMENT_LINES, entryAuthorLabel, ISSUE_STATUS_NAMES } from './issueLabels'

const When = ({ at }: { at: Date }) => (
  <time dateTime={at.toISOString()} className="text-xs text-kumo-subtle">{formatFullTimestamp(at)}</time>
)

// The workspace and the chat an agent's entry came from, worded as the Audit tab words them.
const AgentOrigin = ({ agent }: { agent: AdminAgentOrigin }) => (
  <dl className="flex flex-wrap gap-x-3 text-xs text-kumo-subtle">
    <div className="flex min-w-0 gap-x-1">
      <dt>From workspace</dt>
      <dd className="break-all font-mono">{agent.workspaceId}</dd>
    </div>
    {agent.chatId !== undefined && (
      <div className="flex gap-x-1">
        <dt>From chat</dt>
        <dd>{agent.chatId}</dd>
      </div>
    )}
  </dl>
)

// One entry of the thread. Its author is shown by name alone and the row is keyed by the entry's
// id: an admin's entry carries no author id where the reporter reads it. An entry is an admin's
// when it says how their call reached the deployment. Where an agent's entry came from is shown to
// the admins alone: what the reporter reads carries none of it. An entry with no text is a quiet
// line: a change of assignee, which the admins alone read, or a change of status. One that is
// neither is of a kind this client does not know, and is not shown as an empty note.
const Entry = ({ entry, forAdmins }: { entry: IssueReportEntry; forAdmins: boolean }) => {
  const statusNames = forAdmins ? ADMIN_ISSUE_STATUS_NAMES : ISSUE_STATUS_NAMES
  const author = entryAuthorLabel(entry)
  const viaCli = forAdmins && entry.via === 'cli' && <span className="text-xs text-kumo-subtle">via the CLI</span>
  const origin = forAdmins && entry.agent !== undefined && <AgentOrigin agent={entry.agent} />
  if (entry.text === '') {
    const did = entry.assignment !== undefined
      ? forAdmins && ASSIGNMENT_LINES[entry.assignment]
      : entry.status !== undefined && `set the status to ${statusNames[entry.status]}`
    if (!did) return null
    return (
      <li className="flex flex-wrap items-baseline gap-x-2 px-1 text-xs text-kumo-subtle">
        <span>{author}{entry.via === 'gatekeeper' ? ',' : ''} {did}</span>
        {forAdmins && entry.assignment === undefined && entry.visibility === 'admins' && (
          <span>(not shown to the reporter)</span>
        )}
        {viaCli}
        <When at={entry.at} />
        {origin}
      </li>
    )
  }
  const adminsOnly = entry.visibility === 'admins'
  return (
    <li
      className={[
        'rounded-xl border px-4 py-3',
        adminsOnly ? 'border-dashed border-kumo-line bg-kumo-tint' : 'border-kumo-line bg-kumo-elevated',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-kumo-default">{author}</span>
        {entry.via !== undefined && <Badge variant="outline">Admin</Badge>}
        {adminsOnly && <Badge variant="secondary">Admins only</Badge>}
        {viaCli}
        <When at={entry.at} />
      </div>
      {origin && <div className="mt-1">{origin}</div>}
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-kumo-default">{entry.text}</p>
      {entry.status !== undefined && (
        <p className="mt-2 text-xs text-kumo-subtle">Status: {statusNames[entry.status]}</p>
      )}
    </li>
  )
}

/**
 * One issue report as a conversation: what its reporter wrote, where they were, the images they
 * sent, and the thread's entries, oldest first. A written entry shows its author, time and text;
 * a bare change of status is one quiet line naming who made it. One an agent wrote for an admin
 * names its author as "Agent, for" that admin. Every text is rendered as plain text. What the
 * reader writes with is passed as children and sits beneath the thread.
 *
 * Read by the admins, an entry for admins alone is marked "Admins only" and set apart from those
 * the reporter reads, an admin's entry made through the CLI says so, an agent's says which
 * workspace and chat it came from, a status is named as the admins read it, and the workspace is
 * not linked: it is the reporter's to open, not theirs. The admins' thread holds two kinds of
 * line the reporter's never receives: a change of assignee, one quiet line naming who took, took
 * over or released the report, and a change of status that leaves what the reporter reads as it
 * was, which says it is not shown to the reporter.
 */
export const IssueThread = ({ report, entries, readImage, forAdmins = false, children }: {
  report: IssueReport
  entries: IssueReportEntry[]
  /** Reads the bytes of one of the report's images, by its id. */
  readImage: (imageId: string) => Promise<ReadableStream<Uint8Array>>
  /** Whether the admins read it, rather than its reporter. */
  forAdmins?: boolean
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
          {workspaceId === undefined ? ', outside a workspace' : forAdmins ? ', in a workspace' : (
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
          {entries.map((entry) => <Entry key={entry.id} entry={entry} forAdmins={forAdmins} />)}
        </ol>
      )}
      {children}
    </div>
  )
}
