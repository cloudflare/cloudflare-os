import { useState } from 'react'
import { NotePencilIcon, UserPlusIcon } from '@phosphor-icons/react'
import type { AsideItem } from '@/aside/asideItems'
import { runsWantingAttention, type Agent } from '@/automations/agents'
import { AgentsTab } from '@/automations/AgentsTab'
import { AutomationsTab } from '@/automations/AutomationsTab'
import { useWorkspaceAgents } from '@/automations/useWorkspaceAgents'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { RemoveWorkspaceDialog } from '@/blocks/RemoveWorkspaceDialog'
import { WorkspaceIconPicker } from '@/blocks/WorkspaceIconPicker'
import { WorkspaceMoreMenu } from '@/blocks/WorkspaceMoreMenu'
import { AvatarStack } from '@/components/AvatarStack'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { useNow } from '@/hooks/useNow'
import { PageLayout } from '@/layouts/PageLayout'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { ShareWorkspaceDialog } from './ShareWorkspaceDialog'
import { shareStanding } from './sharingRules'
import { useSharing } from './useSharing'
import { useWorkspaceRemoval } from './useWorkspaceRemoval'
import { WorkspaceChatList } from './WorkspaceChatList'
import { WorkspaceLibraryList } from './WorkspaceLibraryList'
import { WorkspaceMemberList } from './WorkspaceMemberList'
import { useRenameWorkspace, useWorkspaces } from './WorkspacesContext'
import { workspaceLabel } from './workspaceLabel'
import { workspaceMembers } from './workspaceMembers'
import { removalOf } from './workspaceRemoval'
import { useSetWorkspaceLook, useWorkspaceLooks } from './useWorkspaceLooks'

/** What a workspace's page shows beneath its title. */
export type WorkspaceTab = 'chats' | 'agents' | 'library' | 'automations' | 'members'

export const WORKSPACE_TABS: { value: WorkspaceTab; label: string }[] = [
  { value: 'chats', label: 'Chats' },
  { value: 'agents', label: 'Agents' },
  { value: 'library', label: 'Library' },
  { value: 'automations', label: 'Automations' },
  { value: 'members', label: 'Members' },
]

export type WorkspacePaneProps = {
  workspaceId: string
  tab: WorkspaceTab
  onTabChange: (tab: WorkspaceTab) => void
  onOpenChat: (chat: { id: number; title: string }) => void
  /** A chat's address, for its row to link to so that it can be opened in another tab. */
  chatHref?: (chatId: number) => string
  /** Opens one of its agents' page. */
  onOpenAgent: (agent: Agent) => void
  /** An agent's page's address, for its row to link to so that it can be opened in another tab. */
  agentHref?: (agent: Agent) => string
  /** Shows something the workspace has made. */
  onOpenItem: (item: AsideItem) => void
  /** Where an item opens, for its row to link to so that it can be opened in another tab. */
  itemHref?: (item: AsideItem) => string
  onNewChat: () => void
  /** The workspace's address, which inviting people copies and its link lets anyone in to. Left out, nobody is invited from here. */
  link?: string
  /** Leaves the page once the workspace has been deleted, or removed from the viewer's list. */
  onRemoved: () => void
}

/**
 * One workspace: its title, which can be renamed, the way to start a chat in it, who it is shared
 * with and the way to invite more, its More menu, which deletes it, or removes it from the list
 * where it is someone else's, and, a tab each, its chats, its agents, what it has made, what runs
 * in it by itself and who has access to it. The chats, the library and what runs load what they
 * list once chosen; who has access is read with the page, for its header, and its agents too, so
 * that what of theirs waits on the viewer is said over the tabs, whichever is chosen, and counted
 * on the Agents tab.
 */
export const WorkspacePane = ({ workspaceId, tab, onTabChange, onOpenChat, chatHref, onOpenAgent, agentHref, onOpenItem, itemHref, onNewChat, link, onRemoved }: WorkspacePaneProps) => {
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const title = workspace?.title
  useDocumentTitle(title || 'Workspace')
  const narrow = useNarrowScreen()
  const look = useWorkspaceLooks()[workspaceId]
  const setLook = useSetWorkspaceLook()

  const { user } = useApi()
  const sharing = useSharing(workspaceId, true)
  const [inviting, setInviting] = useState(false)
  const shared = sharing.snapshot.status === 'ready' ? sharing.snapshot : undefined
  const standing = shared && shareStanding(shared.metadata, user)
  const people = standing ? workspaceMembers(standing.owner, shared.collaborators).map(({ profile }) => profile) : []
  // Until its own metadata is read, the list's role says whether the viewer could.
  const canInvite = link !== undefined && (standing ? standing.canShare : workspace !== undefined && workspace.role !== 'use')

  // Whether the viewer owns it, from its own metadata once read and the list's until then.
  const metadata = shared?.metadata ?? workspace
  const removal = metadata && removalOf(metadata)
  const removing = useWorkspaceRemoval({ onRemoved })

  const agents = useWorkspaceAgents(workspaceId)
  const now = useNow()
  const wanting = agents.state.status === 'ready' ? runsWantingAttention(agents.state.agents) : []
  const waiting = wanting.filter(({ run }) => run.status === 'waiting')
  const tabs = WORKSPACE_TABS.map((each) => (each.value === 'agents' && waiting.length > 0 ? { ...each, count: { value: waiting.length, label: 'waiting on you' } } : each))
  const openRun = (run: { chatId: number; title: string }) => onOpenChat({ id: run.chatId, title: run.title })

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
          {/* As a chat's header is: the crumb, then what else can be done with it. */}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
            {workspace && <WorkspaceCrumb id={workspaceId} title={workspace.title} label={workspaceLabel(workspace.title)} look={look} expanded />}
            {removal && (
              <HeaderBubble className="shrink-0">
                <WorkspaceMoreMenu
                  title={title || 'Workspace'}
                  triggerVariant="secondary"
                  removal={{
                    kind: removal,
                    onSelect: () => removing.ask({ id: workspaceId, title: title ?? '', removal, others: standing ? people.length - 1 : undefined }),
                  }}
                />
              </HeaderBubble>
            )}
          </nav>
          <span className="ms-auto flex shrink-0 items-center gap-1.5">
            {/* Only once there is someone besides the viewer: it goes to the members. */}
            {people.length > 1 && (
              <HeaderBubble>
                <Button
                  aria-label={`Members: ${people.map(({ name }) => name).join(', ')}`}
                  title="Members"
                  variant="ghost"
                  onClick={() => onTabChange('members')}
                  className="px-1"
                >
                  <span aria-hidden="true" className="flex"><AvatarStack people={people} aria-label="Members" /></span>
                </Button>
              </HeaderBubble>
            )}
            {canInvite && (
              <HeaderBubble>
                {narrow
                  ? <Button icon={UserPlusIcon} aria-label="Share" title="Share" onClick={() => setInviting(true)} />
                  : <Button icon={UserPlusIcon} onClick={() => setInviting(true)}>Share</Button>}
              </HeaderBubble>
            )}
            <HeaderBubble>
              {/* Its icon alone on a narrow screen, which leaves the workspace's title the room. */}
              {narrow
                ? <Button variant="primary" icon={NotePencilIcon} aria-label="New chat" title="New chat" onClick={onNewChat} />
                : <Button variant="primary" icon={NotePencilIcon} onClick={onNewChat}>New chat</Button>}
            </HeaderBubble>
          </span>
        </>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
        <div className="flex flex-col items-center gap-2 pt-8 text-center">
          {/* Its icon, which opens what it can be drawn as. That is kept on this device, so anyone may choose. */}
          {workspace
            ? <WorkspaceIconPicker label={workspaceLabel(workspace.title)} look={look} onLookChange={(next) => setLook(workspaceId, next)} />
            : <WorkspaceIcon label="" />}
          {/* Its own heading, which can be renamed by whoever may build in it. */}
          <h1 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
            {workspace && workspace.role !== 'use'
              ? <EditableTitle value={workspace.title} onRename={rename} aria-label="Workspace title" placeholder="Untitled workspace" className="text-center" />
              : <span className="px-2.5 py-1">{title || 'Workspace'}</span>}
          </h1>
          {renameProblem && <p role="alert" className="text-base text-kumo-subtle">{renameProblem}</p>}
        </div>
        {/* What its agents want of the viewer, over every tab but theirs, which lists it first. */}
        {tab !== 'agents' && wanting.length > 0 && (
          <Banner
            tone={waiting.length > 0 ? 'warning' : 'danger'}
            title={waiting.length > 0
              ? waiting.length === 1 ? `${waiting[0].agent.name} is waiting on you` : `${waiting.length} agent runs are waiting on you`
              : wanting.length === 1 ? `${wanting[0].agent.name}’s latest run failed` : `${wanting.length} agents’ latest runs failed`}
            description={waiting.length > 1 ? 'Their runs stopped for your approval or a connection.'
              : waiting.length === 1 ? 'Its run stopped for your approval or a connection.'
                : 'Open the run to see what went wrong.'}
            action={wanting.length === 1
              ? { label: 'Open run', onSelect: () => openRun(wanting[0].run) }
              : { label: 'Review', onSelect: () => onTabChange('agents') }}
          />
        )}
        <Tabs value={tab} onValueChange={onTabChange} tabs={tabs} aria-label="Workspace" className="gap-6">
          <Tabs.Panel value="chats" className="flex flex-col gap-8">
            <WorkspaceChatList workspaceId={workspaceId} onOpenChat={onOpenChat} chatHref={chatHref} builds={workspace !== undefined && workspace.role !== 'use'} />
          </Tabs.Panel>
          <Tabs.Panel value="agents" className="flex flex-col gap-8">
            <AgentsTab
              state={agents.state}
              onRetry={agents.retry}
              onOpenAgent={onOpenAgent}
              agentHref={agentHref}
              onOpenRun={openRun}
              runHref={chatHref}
              now={now}
            />
          </Tabs.Panel>
          <Tabs.Panel value="library" className="flex flex-col gap-8">
            <WorkspaceLibraryList workspaceId={workspaceId} onOpenItem={onOpenItem} itemHref={itemHref} />
          </Tabs.Panel>
          <Tabs.Panel value="automations" className="flex flex-col gap-8">
            <AutomationsTab
              workspaceId={workspaceId}
              onOpenItem={onOpenItem}
              itemHref={itemHref}
              empty="Nothing runs here by itself yet. Ask in a chat for something to happen on a schedule, or when something arrives."
            />
          </Tabs.Panel>
          <Tabs.Panel value="members" className="flex flex-col gap-8">
            <WorkspaceMemberList {...sharing} />
          </Tabs.Panel>
        </Tabs>
      </div>
      {removing.dialog && <RemoveWorkspaceDialog {...removing.dialog} />}
      {canInvite && (
        <ShareWorkspaceDialog
          workspaceId={workspaceId}
          title={title || 'Workspace'}
          page={link}
          open={inviting}
          onOpenChange={(open) => {
            setInviting(open)
            // Read again for the header and the members tab, with what was changed in it.
            if (!open) sharing.session.start()
          }}
        />
      )}
    </PageLayout>
  )
}
