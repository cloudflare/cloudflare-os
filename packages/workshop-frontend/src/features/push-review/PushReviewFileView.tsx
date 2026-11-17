import { useState, type ReactNode } from 'react'
import type { RpcStub } from 'capnweb'
import { Loader } from '@cloudflare/kumo'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { ExactText } from '../../components/ExactText'
import { formatSize } from '../../components/ActionFields'
import { WorkshopButton } from '../../components/WorkshopControls'
import CodeDiffEditor from '../code/CodeDiffEditor'
import type { CommitFile } from '../code/commitFileStore'
import { useFilesAtCommit } from '../code/useCommitContent'
import { rpcFailureDescription } from '../../rpcErrors'
import {
  ROOT_LABEL, comparableParent, pathChange, pathNotes, shortOid,
  type CommitRow, type PathNotesContext, type PathRow,
} from './pushReviewModel'
import type { PushFileState } from './usePushReviewFiles'

const headingClass = 'm-0 text-[12px] font-semibold leading-4 text-kumo-default'
const statementClass = 'm-0 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle'
const errorClass = 'm-0 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-danger'

const CHANGE_HEADINGS = { added: 'Added', modified: 'Modified', deleted: 'Deleted', mode: 'Mode changed' } as const

const Failure = ({ message, onRetry }: { message: string, onRetry?: () => void }) => (
  <div role="alert" className="flex flex-wrap items-center gap-2">
    <p className={errorClass}>{message}</p>
    {onRetry && <WorkshopButton onClick={onRetry}>Retry</WorkshopButton>}
  </div>
)

// The diff editor fills its container, so it gets a box with a height of its own: the rest of
// the pane, and never less than a readable one. Every editor in the review wraps its lines and
// draws what cannot otherwise be seen, so nothing of the text the push sends is off screen.
const ReadOnlyDiff = ({ editorKey, path, original, text }: {
  editorKey: string, path: string, original: string | null, text: string,
}) => (
  <div className="relative min-h-[320px] flex-1">
    <div className="absolute inset-0">
      <CodeDiffEditor
        key={editorKey}
        filename={path}
        original={original}
        text={text}
        readOnly
        showInvisibles
        wrapLines
      />
    </div>
  </div>
)

// What a read that is not of text says in place of the content.
const notShown = (file: Exclude<CommitFile, { kind: 'text' }>): ReactNode =>
  file.kind === 'blob' ? `Not text: ${formatSize(file.blob.byteLength)}.`
    : file.kind === 'unreadable' ? <ExactText text={file.message} />
      : 'Nothing is at this path.'

/**
 * One path of a commit: what it is, in plain statements, and its content when that is text. A
 * file the push sends shows as a diff against a parent's version, or whole when there is none; a
 * deleted file shows what is removed, and so does a directory where a parent has a file. What
 * the push sends is the review's own read (`state`); the parent's side, and a file the push does
 * not send, are read here when shown.
 */
export const PushReviewFileView = ({ overseer, commit, row, beneath, state, onRequest, onRetry }: {
  overseer: RpcStub<Overseer>
  commit: CommitRow
  row: PathRow
  beneath: PathNotesContext['beneath']
  state: PushFileState
  onRequest: () => void
  onRetry: () => void
}) => {
  const [parentIndex, setParentIndex] = useState(() => comparableParent(row))
  // A file the push does not send is read only when the approver asks to see it.
  const [shown, setShown] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const retryRead = () => setRetryToken(token => token + 1)

  // A deletion, or a directory where a parent has a file: the one row that file has.
  const removes = !row.entry || row.entry.kind === 'dir'
  const sentText = typeof state === 'object' && 'text' in state ? state.text : undefined
  const paths = [row.path]

  // The parent's version is read once there is something to set it against.
  const chosen = parentIndex === undefined ? undefined : row.parents[parentIndex]
  const hasFile = chosen?.kind === 'file' || chosen?.kind === 'executable' || chosen?.kind === 'symlink'
  const comparing = hasFile && (removes || sentText !== undefined)
  const parentRead = useFilesAtCommit(
    overseer, comparing ? commit.parents[parentIndex!] : undefined, paths, retryToken)
  const earlier = comparing ? parentRead.files.get(row.path) : undefined
  const earlierFailed = comparing && (parentRead.error !== null || earlier?.kind === 'absent')
  const earlierLoading = comparing && earlier === undefined && parentRead.error === null

  const canShow = row.entry && !row.sent &&
    (row.entry.kind === 'file' || row.entry.kind === 'executable' || row.entry.kind === 'symlink')
  const ownRead = useFilesAtCommit(overseer, shown ? row.commit : undefined, paths, retryToken)
  const own = shown ? ownRead.files.get(row.path) : undefined

  const editorKey = `${row.commit}:${row.path}:${parentIndex}`
  const earlierNote = earlierFailed ? (
    <Failure
      message="The earlier version could not be read."
      onRetry={parentRead.error !== null ? retryRead : undefined}
    />
  ) : earlier?.kind === 'text' ? (
    <p className={statementClass}>
      Removed lines are the earlier version&apos;s, not sent; long ones are cut at the edge.
    </p>
  ) : earlier ? (
    <p className={statementClass}>The earlier version is not text, so the whole file is shown.</p>
  ) : null

  let content: ReactNode = null
  if (removes) {
    if (earlierLoading) {
      content = <Loader aria-label="Loading the removed file" />
    } else if (earlierFailed) {
      content = <Failure message="The removed file could not be read." onRetry={parentRead.error !== null ? retryRead : undefined} />
    } else if (earlier?.kind === 'text') {
      content = <ReadOnlyDiff editorKey={editorKey} path={row.path} original={earlier.text} text="" />
    } else if (earlier && earlier.kind !== 'absent') {
      content = <p className={statementClass}>The removed file: {notShown(earlier)}</p>
    } else if (comparableParent(row) !== undefined) {
      content = <p className={statementClass}>This parent has no file at this path.</p>
    }
  } else if (sentText !== undefined) {
    content = earlierLoading ? <Loader aria-label="Loading the earlier version" /> : (
      <>
        <ReadOnlyDiff
          editorKey={editorKey}
          path={row.path}
          original={earlier?.kind === 'text' ? earlier.text : null}
          text={sentText}
        />
        {earlierNote}
      </>
    )
  } else if (state === 'loading') {
    content = <Loader aria-label="Loading the file" />
  } else if (typeof state === 'object' && 'failed' in state) {
    content = <Failure message={state.failed} onRetry={onRetry} />
  } else if (typeof state === 'object' && 'mismatch' in state) {
    content = <p role="alert" className={errorClass}><ExactText text={state.mismatch} singleLine /></p>
  } else if (typeof state === 'object' && 'link' in state) {
    content = <p className={statementClass}><ExactText text={state.link} /></p>
  } else if (typeof state === 'object' && 'notText' in state) {
    content = <p className={statementClass}>Not text: {formatSize(state.notText)}. Its content cannot be shown.</p>
  } else if (row.sent?.kind === 'text' || row.sent?.kind === 'large') {
    content = <div><WorkshopButton onClick={onRequest}>Show file</WorkshopButton></div>
  } else if (canShow) {
    content = !shown ? (
      <div><WorkshopButton onClick={() => setShown(true)}>Show file</WorkshopButton></div>
    ) : ownRead.error !== null ? (
      <Failure message={rpcFailureDescription(ownRead.error) ?? 'This file could not be read.'} onRetry={retryRead} />
    ) : own === undefined ? (
      <Loader aria-label="Loading the file" />
    ) : own.kind === 'text' ? (
      <ReadOnlyDiff editorKey={editorKey} path={row.path} original={null} text={own.text} />
    ) : (
      <p className={statementClass}>{notShown(own)}</p>
    )
  }

  const merge = commit.parents.length > 1 && (!removes || comparableParent(row) !== undefined)
  return (
    <div className="flex min-h-full flex-col gap-3 p-4">
      <div>
        <h3 className={headingClass}>{CHANGE_HEADINGS[pathChange(row)]}</h3>
        <p className="m-0 mt-1 font-mono text-[12px] leading-[18px] text-kumo-default">
          {row.path === '' ? ROOT_LABEL : <ExactText text={row.path} singleLine />}
        </p>
      </div>

      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {pathNotes(row, { parents: commit.parents, beneath }).map(note => (
          <li key={note} className={statementClass}>{note}</li>
        ))}
      </ul>

      {merge && (
        <div role="group" aria-label="Parent to compare with" className="flex flex-wrap gap-1.5">
          {commit.parents.map((parent, index) => (
            <button
              key={index}
              type="button"
              aria-pressed={index === parentIndex}
              onClick={() => setParentIndex(index)}
              className={`cursor-pointer rounded-md border px-2 py-1 font-mono text-[12px] leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
                index === parentIndex
                  ? 'border-kumo-line bg-kumo-tint text-kumo-default'
                  : 'border-transparent text-kumo-subtle hover:bg-kumo-elevated'
              }`}
            >
              Against parent {index + 1} {shortOid(parent)}
            </button>
          ))}
        </div>
      )}

      {content}
    </div>
  )
}
