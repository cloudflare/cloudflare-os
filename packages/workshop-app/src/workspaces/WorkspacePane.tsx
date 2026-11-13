import { useState } from 'react'
import { NotePencilIcon } from '@phosphor-icons/react'
import type { AsideItem } from '@/aside/asideItems'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { Button } from '@/components/Button'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { PageLayout } from '@/layouts/PageLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { WorkspaceChatList } from './WorkspaceChatList'
import { WorkspaceLibraryList } from './WorkspaceLibraryList'
import { WorkspaceMemberList } from './WorkspaceMemberList'
import { useRenameWorkspace, useWorkspaces } from './WorkspacesContext'
import { workspaceLabel } from './workspaceLabel'

/** What a workspace's page shows beneath its title. */
export type WorkspaceTab = 'chats' | 'library' | 'members'

export const WORKSPACE_TABS: { value: WorkspaceTab; label: string }[] = [
  { value: 'chats', label: 'Chats' },
  { value: 'library', label: 'Library' },
  { value: 'members', label: 'Members' },
]

export type WorkspacePaneProps = {
  workspaceId: string
  tab: WorkspaceTab
  onTabChange: (tab: WorkspaceTab) => void
  onOpenChat: (chat: { id: number; title: string }) => void
  /** A chat's address, for its row to link to so that it can be opened in another tab. */
  chatHref?: (chatId: number) => string
  /** Shows something the workspace has made. */
  onOpenItem: (item: AsideItem) => void
  /** Where an item opens, for its row to link to so that it can be opened in another tab. */
  itemHref?: (item: AsideItem) => string
  onNewChat: () => void
}

/**
 * One workspace: its title, which can be renamed, the way to start a chat in it, and, a tab each,
 * its chats, what it has made and who has access to it. Each tab loads what it lists once chosen.
 */
export const WorkspacePane = ({ workspaceId, tab, onTabChange, onOpenChat, chatHref, onOpenItem, itemHref, onNewChat }: WorkspacePaneProps) => {
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const title = workspace?.title
  useDocumentTitle(title || 'Workspace')
  const narrow = useNarrowScreen()

  const renameWorkspace = useRenameWorkspace()
  // Why the last new title was not kept.
  const [renameProblem, setRenameProblem] = useState<string>()
  const connection = useConnectionNotice()
  const rename = (next: string) => {
    setRenameProblem(undefined)
    if (connection?.blocked()) return
    renameWorkspace(workspaceId, next).catch((error: unknown) => {
      setRenameProblem(`Couldn’t rename the workspace: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  return (
    <PageLayout
      header={(
        <>
          {workspace && <WorkspaceCrumb id={workspaceId} title={workspace.title} label={workspaceLabel(workspace.title)} expanded />}
          <HeaderBubble className="ms-auto">
            {/* Its icon alone on a narrow screen, which leaves the workspace's title the room. */}
            {narrow
              ? <Button variant="primary" icon={NotePencilIcon} aria-label="New chat" title="New chat" onClick={onNewChat} />
              : <Button variant="primary" icon={NotePencilIcon} onClick={onNewChat}>New chat</Button>}
          </HeaderBubble>
        </>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
        <div className="flex flex-col items-center gap-2 pt-8 text-center">
          <WorkspaceIcon label={workspaceLabel(title ?? '')} />
          {/* Its own heading, which can be renamed by whoever may build in it. */}
          <h1 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
            {workspace && workspace.role !== 'use'
              ? <EditableTitle value={workspace.title} onRename={rename} aria-label="Workspace title" placeholder="Untitled workspace" className="text-center" />
              : <span className="px-2.5 py-1">{title || 'Workspace'}</span>}
          </h1>
          {renameProblem && <p role="alert" className="text-base text-kumo-subtle">{renameProblem}</p>}
        </div>
        <Tabs value={tab} onValueChange={onTabChange} tabs={WORKSPACE_TABS} aria-label="Workspace" className="gap-6">
          <Tabs.Panel value="chats" className="flex flex-col gap-8">
            <WorkspaceChatList workspaceId={workspaceId} onOpenChat={onOpenChat} chatHref={chatHref} />
          </Tabs.Panel>
          <Tabs.Panel value="library" className="flex flex-col gap-8">
            <WorkspaceLibraryList workspaceId={workspaceId} onOpenItem={onOpenItem} itemHref={itemHref} />
          </Tabs.Panel>
          <Tabs.Panel value="members" className="flex flex-col gap-8">
            <WorkspaceMemberList workspaceId={workspaceId} />
          </Tabs.Panel>
        </Tabs>
      </div>
    </PageLayout>
  )
}
