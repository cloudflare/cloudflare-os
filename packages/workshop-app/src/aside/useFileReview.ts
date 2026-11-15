import { useMemo, type ReactNode } from 'react'
import type { ConnectedFileReview } from '@/blocks/ConnectedFileView'
import { fileChanges } from '@/chat/pendingGroups'
import { useChatBeside } from '@/chat/useChatSession'
import { usePendingDecisions } from '@/chat/usePendingDecisions'
import { useApproveCreation } from '@/connections/ApproveCreation'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import type { AsideConnectedFile } from './asideItems'

/**
 * The review of the changes the chat a connected file is shown beside asks for to it, for the
 * file to decide them on itself (`ConnectedFileView`), through the same session the chat is shown
 * with, so that the chat's tray and the file agree. `version` changes as the chat asks more of
 * the file and as that is decided, for the file to be drawn again with it. A file not made yet
 * (no `subjectId`) is reviewed whole, and made in the user's account as its creation card would
 * be, asking which in `dialog` when there is a choice. No review for a file shown beside no chat.
 */
export const useFileReview = (file: AsideConnectedFile | undefined): { review?: ConnectedFileReview; version: string; dialog: ReactNode } => {
  const workspaceId = file?.workspaceId
  const chatId = file?.chatId
  const chat = useMemo(() => (workspaceId !== undefined && chatId !== undefined ? { workspaceId, chatId } : undefined), [workspaceId, chatId])
  const { chat: snapshot, actions } = useChatBeside(chat)
  const workspaces = useWorkspaces()
  const { approveCreation, dialog } = useApproveCreation({
    workspaceId: workspaceId ?? '',
    approve: (actionId, creation) => (actions ? actions.decideAction(actionId, 'approve', creation) : refuse()),
  })
  const decisions = usePendingDecisions({ decide: actions?.decideAction ?? refuse, approveCreation })
  const { waiting, decided } = useMemo(() => {
    if (!file || snapshot.status !== 'ready') return { waiting: [], decided: new Map<number, never>() }
    return fileChanges([...snapshot.items, ...snapshot.pinned], file.gatekeeperId, file.subjectId)
  }, [file, snapshot])
  // Any change to what it asks of the file, such as an edit approved by a standing approval, which
  // never waits, is drawn as soon as the chat has it.
  const version = [...waiting.map(({ actionId }) => `${actionId}`), ...[...decided].map(([id, state]) => `${id}${state[0]}`)].join(',')
  if (!file || !actions) return { version, dialog }
  const restricted = workspaces.status === 'ready' && workspaces.workspaces.find(({ id }) => id === file.workspaceId)?.containsRestrictedData === true

  return {
    version,
    dialog,
    review: {
      creates: waiting.some(({ creation }) => creation !== undefined),
      changes: waiting.map(({ actionId, title, description, fields }) => ({ actionId, title, description, fields })),
      decided,
      onDecide: (ids, decision) => decisions.run(waiting.filter(({ actionId }) => ids.includes(actionId)), decision),
      restricted,
      progress: decisions.progress,
      problem: decisions.problem,
      onDismissProblem: decisions.dismissProblem,
    },
  }
}

const refuse = () => Promise.reject(new Error('The chat isn’t open.'))
