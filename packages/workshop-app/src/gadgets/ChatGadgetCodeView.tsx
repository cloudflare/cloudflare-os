import { useLayoutEffect, useMemo, useState } from 'react'
import { CodeBrowser } from '@/blocks/CodeBrowser'
import { useChatCode } from '@/chat/useChatSession'
import { chatCodeCommits } from './chatCodeFiles'
import { historyEntry, keptWhen } from './codeHistory'
import type { GadgetCodeViewProps } from './GadgetCodeView'
import { useChatGadgetCode } from './useChatGadgetCode'
import { useCodeHistory, useGadgetCode, type CodeComparison } from './useGadgetCode'
import { useLiveCodeEditing } from './useLiveCodeEditing'

/** What the code says it is while the chat changes it. */
export const ONLY_IN_CHAT = 'Only in this chat until it’s kept'

export type ChatGadgetCodeViewProps = Omit<GadgetCodeViewProps, 'gadget' | 'known'> & {
  gadget: { id: number; title: string }
  /** The chat it is shown beside, whose code it is. */
  chatId: number
  /** The workspace has said what its head is: none, for one the chat made. */
  known: boolean
}

/**
 * A gadget's code as the chat beside it has it (`useChatCode`, `useChatGadgetCode`): what the
 * chat changed listed apart, each file opening as its change, and edited live, each edit going
 * into the chat as it is made (`useLiveCodeEditing`), where keeping the chat's changes keeps it.
 * Its history is of what was kept, as anywhere else, and a past version is only read.
 */
export const ChatGadgetCodeView = ({
  workspaceId, gadget, chatId, commitId, known, file, onShowFile, lines, onLinesChange, linkTo, active = true, empty, frame, className,
}: ChatGadgetCodeViewProps) => {
  const [comparing, setComparing] = useState<string>()
  const history = useCodeHistory(workspaceId, commitId, active)
  const log = history.status === 'ready' ? history.commits : undefined
  const compared = log?.find(({ oid }) => oid === comparing)
  const comparison: CodeComparison | undefined = compared?.parents[0] ? { from: compared.parents[0], to: compared.oid } : undefined
  const commits = useMemo(() => log?.filter(({ parents }) => parents.length > 0).map(historyEntry), [log])

  const { code, edits } = useChatCode(active ? { workspaceId, chatId } : undefined)
  const own = code.status === 'ready' ? code.gadgets.get(gadget.id) : undefined
  const at = chatCodeCommits(own, commitId)
  const chat = useChatGadgetCode({ workspaceId, code: own, commits: at, known: known && code.status === 'ready', asked: file, active: active && !comparison })
  const past = useGadgetCode({ workspaceId, commit: commitId, comparing: comparison, asked: file, active: active && comparison !== undefined })
  const shown = comparison ? past : chat
  const live = useLiveCodeEditing({
    gadget, chatId, code, edits, base: at.base, textOf: chat.textOf, reviewTextOf: chat.reviewTextOf, comparing: comparison !== undefined,
  })
  // What is typed is over what was drawn: once this has drawn it, and the editor beneath it, which
  // takes its text in its own layout effect, first.
  const version = code.status === 'ready' ? code.version : undefined
  useLayoutEffect(() => {
    if (version !== undefined) edits?.shown(version)
  })
  const files = live.present(shown.files, shown.shown, shown.file)
  const changed = chat.files.status === 'ready' && chat.files.files.some(({ change }) => change !== undefined)
  const head = log?.[0]

  return (
    <CodeBrowser
      files={files}
      shown={shown.shown}
      onShow={onShowFile}
      file={shown.file}
      editing={live.editing(files, shown.shown, onShowFile)}
      before={shown.before}
      onRetry={shown.retry}
      empty={empty ?? 'It has no code yet. Once the chat writes some, it shows here.'}
      history={{
        commits: history.status === 'ready' ? { status: 'ready', commits: commits ?? [] } : history,
        comparing: comparison ? comparing : undefined,
        onCompare: setComparing,
      }}
      lines={comparison ? undefined : lines}
      onLinesChange={comparison ? undefined : onLinesChange}
      linkTo={linkTo}
      note={changed ? ONLY_IN_CHAT : head ? keptWhen(head.timestamp) : 'As last kept'}
      frame={frame}
      className={className}
    />
  )
}
