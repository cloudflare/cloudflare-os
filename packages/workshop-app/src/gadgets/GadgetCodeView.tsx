import { useMemo, useState } from 'react'
import type { CommitInfo } from '@gadgets/workshop-shared/api'
import { CodeBrowser, type CodeBrowserCommit, type CodeBrowserProps } from '@/blocks/CodeBrowser'
import type { CodeLines } from '@/components/CodeEditor'
import { formatActivity } from '@/workspaces/formatActivity'
import { useCodeEditing } from './useCodeEditing'
import { useCodeHistory, useGadgetCode, type CodeComparison } from './useGadgetCode'

export type GadgetCodeViewProps = {
  workspaceId: string
  /** The gadget, by its id and title, and the chat it is shown beside, where it is: what edits are saved through. */
  gadget: { id: number; title: string; chatId?: number }
  /** The commit its code was last kept in: its head. Nothing is shown until it is known. */
  commitId: string | undefined
  /** The file asked for, as the page's address says; the first is shown without one. */
  file?: string
  onShowFile: (path: string) => void
  /** Lines picked out, as the page's address says. */
  lines?: CodeLines
  onLinesChange?: (lines: CodeLines | undefined) => void
  /** An address for a file, or lines of it, to copy. */
  linkTo?: (path: string, lines?: CodeLines) => string
  /** Nothing is read until it is. */
  active?: boolean
  /** What it says when there are no files. */
  empty?: string
} & Pick<CodeBrowserProps, 'frame' | 'className'>

/** A commit as the history lists it: its message's first line, who kept it, and when. */
export const historyEntry = ({ oid, message, author, timestamp }: CommitInfo): CodeBrowserCommit =>
  ({ id: oid, summary: message.split('\n')[0]?.trim() || 'Kept changes', author: author.name, time: formatActivity(timestamp) })

// When the code shown was kept, as the footer says it: "Kept 5 min ago", "Kept yesterday", "Kept on Aug 2".
const keptWhen = (date: Date) => {
  const when = formatActivity(date)
  if (when.endsWith('ago')) return `Kept ${when}`
  if (when === 'Just now' || when === 'Yesterday') return `Kept ${when.toLowerCase()}`
  return `Kept on ${when}`
}

/**
 * A gadget's code as it was last kept (`CodeBrowser`), and its history: each time a chat's changes
 * to it were kept, newest first, which opens to what changed then, compared with the time before.
 * The first commit, which a gadget is made with and has nothing in it, is left out. The code as it
 * is now is edited (`useCodeEditing`), as a draft saved through a chat.
 */
export const GadgetCodeView = ({
  workspaceId, gadget, commitId, file, onShowFile, lines, onLinesChange, linkTo, active = true, empty, frame, className,
}: GadgetCodeViewProps) => {
  const [comparing, setComparing] = useState<string>()
  const history = useCodeHistory(workspaceId, commitId, active)
  const log = history.status === 'ready' ? history.commits : undefined
  const compared = log?.find(({ oid }) => oid === comparing)
  const comparison: CodeComparison | undefined = compared?.parents[0] ? { from: compared.parents[0], to: compared.oid } : undefined
  const edit = useCodeEditing({ workspaceId, gadget, commitId, comparing: comparison !== undefined })
  // What the draft adds, deletes and changes is listed over what was read.
  const code = useGadgetCode({ workspaceId, commit: commitId, comparing: comparison, asked: file, active, arrange: edit.arrange })
  const commits = useMemo(() => log?.filter(({ parents }) => parents.length > 0).map(historyEntry), [log])
  const head = log?.[0]
  const shown = edit.present(code.files, code.shown, code.file)

  return (
    <CodeBrowser
      files={shown.files}
      shown={code.shown}
      onShow={onShowFile}
      file={shown.file}
      editing={edit.editing(shown.files, code.shown, code.file, onShowFile)}
      before={code.before}
      onRetry={code.retry}
      empty={empty ?? 'It has no code yet. Once a chat writes some and it’s kept, it shows here.'}
      history={{
        commits: history.status === 'ready' ? { status: 'ready', commits: commits ?? [] } : history,
        comparing: comparison ? comparing : undefined,
        onCompare: setComparing,
      }}
      lines={comparison ? undefined : lines}
      onLinesChange={comparison ? undefined : onLinesChange}
      linkTo={linkTo}
      note={head ? keptWhen(head.timestamp) : 'As last kept'}
      frame={frame}
      className={className}
    />
  )
}
