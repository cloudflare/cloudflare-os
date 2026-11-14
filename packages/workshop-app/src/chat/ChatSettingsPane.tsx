import { useState } from 'react'
import { CaretLeftIcon } from '@phosphor-icons/react'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { Button } from '@/components/Button'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import type { LibraryEntry } from '@/library/libraryEntries'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { WorkspaceLibraryList } from '@/workspaces/WorkspaceLibraryList'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { useChatSession } from './useChatSession'

export type ChatSettingsPaneProps = {
  workspaceId: string
  chatId: number
  /** The title to show until the chat's own arrives, e.g. from the chat it was opened from. */
  initialTitle?: string
  onBack: () => void
  /** Goes to the page of the workspace the chat is in. */
  onOpenWorkspace: () => void
  /** Shows a file or an output, such as beside the chat. */
  onOpen: (entry: LibraryEntry) => void
  /** Where an entry opens, for its row to link to so that it can be opened in another tab. */
  href?: (entry: LibraryEntry) => string
}

/**
 * What a chat has, apart from the conversation: for now, what its workspace has made, was sent and
 * worked on, on the Library's rows (`WorkspaceLibraryList`).
 */
export const ChatSettingsPane = ({ workspaceId, chatId, initialTitle, onBack, onOpenWorkspace, onOpen, href }: ChatSettingsPaneProps) => {
  const { chat, actions } = useChatSession(workspaceId, chatId)
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const title = (chat.status === 'ready' ? chat.title : undefined) ?? initialTitle
  // Why the last new title was not kept.
  const [renameProblem, setRenameProblem] = useState<string>()
  const connection = useConnectionNotice()
  const rename = (next: string) => {
    setRenameProblem(undefined)
    if (connection?.blocked()) return
    actions.rename(next).catch((error: unknown) => {
      setRenameProblem(`Couldn’t rename the chat: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  useDocumentTitle(title ? `Settings · ${title}` : 'Chat settings')

  return (
    <PageLayout
      header={(
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
          {workspace && <WorkspaceCrumb id={workspaceId} title={workspace.title} label={workspaceLabel(workspace.title)} onOpen={onOpenWorkspace} />}
          <HeaderBubble>
            <Button icon={CaretLeftIcon} onClick={onBack}>Back to chat</Button>
          </HeaderBubble>
        </nav>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
        <div className="flex flex-col items-center gap-2 pt-8 text-center">
          {workspace && (
            <span className="flex items-center gap-2 text-base text-kumo-subtle">
              <WorkspaceIcon label={workspaceLabel(workspace.title)} small />
              {workspace.title}
            </span>
          )}
          {/* Its own heading, which can be renamed once the chat is there to rename. */}
          <h1 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
            {chat.status === 'ready'
              ? <EditableTitle value={title ?? ''} onRename={rename} aria-label="Chat title" placeholder="Untitled chat" className="text-center" />
              : <span className="px-2.5 py-1">{title ?? 'Chat'}</span>}
          </h1>
          {renameProblem && <p role="alert" className="text-base text-kumo-subtle">{renameProblem}</p>}
        </div>
        {chat.status === 'loading' && <p role="status" className="appears-late px-4 text-base text-kumo-subtle">Loading the chat…</p>}
        <WorkspaceLibraryList workspaceId={workspaceId} onOpen={onOpen} href={href} />
      </div>
    </PageLayout>
  )
}
