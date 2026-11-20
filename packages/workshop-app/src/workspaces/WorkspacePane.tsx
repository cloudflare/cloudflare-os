import { useEffect, useState } from 'react'
import { PlusIcon, UserPlusIcon } from '@phosphor-icons/react'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import type { AsideItem } from '@/aside/asideItems'
import { runsWantingAttention, type Agent } from '@/automations/agents'
import { AGENT_DRAFT, AUTOMATION_DRAFT } from '@/automations/startDrafts'
import { AgentsTab } from '@/automations/AgentsTab'
import { AutomationsTab } from '@/automations/AutomationsTab'
import { useWorkspaceAgents } from '@/automations/useWorkspaceAgents'
import { WorkspaceCost } from '@/blocks/WorkspaceCost'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { WorkspaceIconPicker } from '@/blocks/WorkspaceIconPicker'
import { AvatarStack } from '@/components/AvatarStack'
import { Button } from '@/components/Button'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDevMode } from '@/hooks/useDevMode'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useHandler } from '@/hooks/useHandler'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { useNow } from '@/hooks/useNow'
import { PageLayout } from '@/layouts/PageLayout'
import { useUnread } from '@/notifications/UnreadContext'
import { useApi } from '@/rpc/ApiContext'
import { useWaitingAsks } from '@/gadgets/WaitingAsksProvider'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { SharedAppPane } from './SharedAppPane'
import { ShareWorkspaceDialog } from './ShareWorkspaceDialog'
import { shareStanding } from './sharingRules'
import { useSharing } from './useSharing'
import { WorkspaceChatList } from './WorkspaceChatList'
import { WorkspaceLibraryList } from './WorkspaceLibraryList'
import { WorkspaceMemberList } from './WorkspaceMemberList'
import { WorkspaceOptionsTab } from './WorkspaceOptionsTab'
import { useRemoveWorkspace, useRenameWorkspace, useWorkspaces } from './WorkspacesContext'
import { workspaceLabel } from './workspaceLabel'
import { workspaceMembers } from './workspaceMembers'
import { attentionCount, attentionOf } from './activity/overview'
import { useWorkspaceActivity } from './activity/useWorkspaceActivity'
import { WorkspaceHistory } from './activity/WorkspaceHistory'
import { removalOf } from './workspaceRemoval'
import { useSetWorkspaceLook, useWorkspaceLooks } from './useWorkspaceLooks'
import { gadgetsWaitingIn } from './waitingWords'

/** What a workspace's page shows beneath its title. */
export type WorkspaceTab = 'chats' | 'agents' | 'library' | 'automations' | 'members' | 'settings'

export const WORKSPACE_TABS: { value: WorkspaceTab; label: string }[] = [
  { value: 'chats', label: 'Chats' },
  { value: 'library', label: 'Library' },
  { value: 'agents', label: 'Agents' },
  { value: 'automations', label: 'Automations' },
  { value: 'members', label: 'Members' },
  { value: 'settings', label: 'Settings' },
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
  /** An output's own page, which sharing it from its row's more menu lets people in to. */
  outputHref?: (output: OutputSummary) => string
  /** Goes to an output's settings, from its row's more menu. */
  onOpenSettings?: (output: OutputSummary) => void
  /** Opens an app on its own page, for someone who can only use the workspace's apps shared with them. */
  onOpenOutput: (output: OutputSummary) => void
  /** Goes to the Library, where what was shared with the viewer is. */
  onOpenLibrary: () => void
  /** Starts a chat in the workspace, with `draft` written in its composer where something is to be asked for, to be finished before it is sent. */
  onNewChat: (draft?: string) => void
  /** The workspace's address, which inviting people copies and its link lets anyone in to. Left out, nobody is invited from here. */
  link?: string
  /** Leaves the page once the workspace has been deleted, or removed from the viewer's list. */
  onRemoved: () => void
  /** The dialog to invite people is asked for, as search does, to be shown once the viewer is known to be able to. */
  inviteRequested?: boolean
  /** The request has been answered, by showing the dialog or because the viewer may not: it is forgotten. */
  onInviteHandled?: () => void
}

/**
 * One workspace: its title, which can be renamed, who it is shared with and the way to invite
 * more, and, a tab each, its chats, what needs the viewer first, with the way to start one, its
 * agents, what it has made, what runs in it by itself, who has access to it, with the way to
 * invite more there too, the history of what was done in it, and its settings, which mark it read
 * and delete it, or remove it from the list where it is someone else's. The chats, the library
 * and what runs load what they list once chosen; who has access is read with the page, for its
 * header, and its agents and activity too, so that what waits on the viewer is counted on the
 * Chats and Agents tabs, whichever is chosen. Someone who was only shared an app of it to use is
 * told it is not theirs (`SharedAppPane`), with nothing of it read, once the list says so.
 */
export const WorkspacePane = ({ onOpenOutput, onOpenLibrary, ...props }: WorkspacePaneProps) => {
  const workspaces = useWorkspaces()
  const listed = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === props.workspaceId) : undefined
  if (listed?.role === 'use') return <SharedAppPane workspace={listed} onOpenOutput={onOpenOutput} onOpenLibrary={onOpenLibrary} />
  return <MemberWorkspacePane {...props} />
}

const MemberWorkspacePane = ({ workspaceId, tab, onTabChange, onOpenChat, chatHref, onOpenAgent, agentHref, onOpenItem, itemHref, outputHref, onOpenSettings, onNewChat, link, onRemoved, inviteRequested = false, onInviteHandled }: Omit<WorkspacePaneProps, 'onOpenOutput' | 'onOpenLibrary'>) => {
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const title = workspace?.title
  useDocumentTitle(title || 'Workspace')
  const narrow = useNarrowScreen()
  const devMode = useDevMode()
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

  // Asked for from outside (search): shown once the workspace is listed, which says whether the viewer
  // may, and the request forgotten either way, so that it is not asked again.
  const answerInviteRequest = useHandler(() => {
    if (canInvite) setInviting(true)
    onInviteHandled?.()
  })
  const listed = workspace !== undefined
  useEffect(() => {
    if (inviteRequested && listed) answerInviteRequest()
  }, [inviteRequested, listed, answerInviteRequest])

  // Whether the viewer owns it, from its own metadata once read and the list's until then.
  const metadata = shared?.metadata ?? workspace
  const removal = metadata && removalOf(metadata)
  const removeWorkspace = useRemoveWorkspace()

  const agents = useWorkspaceAgents(workspaceId)
  const now = useNow()
  const wanting = agents.state.status === 'ready' ? runsWantingAttention(agents.state.agents) : []
  const waiting = wanting.filter(({ run }) => run.status === 'waiting')
  // What else waits on the viewer: its gadgets that ask something, and the chats people had with
  // its agent stopped on a decision or an action, each counted on the tab that lists it.
  const asks = useWaitingAsks()
  const gadgetsWaiting = gadgetsWaitingIn(workspaceId, asks.byGadget)
  const chatsWaiting = agents.state.status === 'ready' ? agents.state.chatsWaiting : undefined
  // Everything that waits on a decision, wherever it was asked for, and the runs that failed, on the
  // chats' tab, which lists them all first.
  const activity = useWorkspaceActivity(workspaceId)
  const builds = workspace !== undefined && workspace.role !== 'use'
  const failedRuns = wanting.filter(({ run }) => run.status === 'failed').map(({ agent, run }) => ({ chatId: run.chatId, title: run.title, agent: agent.name, at: run.lastActive }))
  // What waits outside any chat is the automations' to list, which ask it, not the chats'.
  const attention = builds && activity.state.status === 'ready' ? attentionOf(activity.state) : []
  const outsideAsks = attention.find(({ place }) => place.kind === 'elsewhere')?.asks ?? []
  const needsCount = attentionCount(attention.filter(({ place }) => place.kind !== 'elsewhere')) + (builds ? failedRuns.length : 0)
  const counts: Partial<Record<WorkspaceTab, number>> = { chats: needsCount, agents: waiting.length, library: gadgetsWaiting, automations: outsideAsks.length }
  const tabs = WORKSPACE_TABS.map((each) => {
    const value = counts[each.value] ?? 0
    return value > 0 ? { ...each, count: { value, label: 'waiting on you', dot: true } } : each
  })

  const renameWorkspace = useRenameWorkspace()
  // Why the last new title was not kept.
  const [renameProblem, setRenameProblem] = useState<string>()
  const connection = useConnectionNotice()
  const unread = useUnread()
  // Its marks clear as the account says they have.
  const markRead = unread?.totals.workspaces.has(workspaceId) ? () => unread.markWorkspaceRead(workspaceId) : undefined
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
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
            {workspace && <WorkspaceCrumb id={workspaceId} title={workspace.title} label={workspaceLabel(workspace.title)} look={look} expanded />}
          </nav>
          <span className="ms-auto flex shrink-0 items-center gap-1.5">
            {devMode && workspace?.totalCost !== undefined && <WorkspaceCost cost={workspace.totalCost} />}
            {/* Only once there is someone besides the viewer: it goes to the members. */}
            {people.length > 1 && (
              <HeaderBubble origin="end">
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
              <HeaderBubble origin="end">
                {narrow
                  ? <Button icon={UserPlusIcon} aria-label="Invite" title="Invite" onClick={() => setInviting(true)} />
                  : <Button icon={UserPlusIcon} onClick={() => setInviting(true)}>Invite</Button>}
              </HeaderBubble>
            )}
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
          <span className="mt-3 -mb-2 text-sm text-kumo-subtle">Workspace</span>
          {/* Its own heading, which can be renamed by whoever may build in it. */}
          <h1 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
            {workspace && workspace.role !== 'use'
              ? <EditableTitle value={workspace.title} onRename={rename} aria-label="Workspace title" placeholder="Untitled workspace" className="text-center" />
              : <span className="px-2.5 py-1">{title || 'Workspace'}</span>}
          </h1>
          {renameProblem && <p role="alert" className="text-base text-kumo-subtle">{renameProblem}</p>}
        </div>
        <Tabs value={tab} onValueChange={onTabChange} tabs={tabs} aria-label="Workspace" className="gap-6">
          <Tabs.Panel value="chats" className="flex flex-col gap-8">
            <WorkspaceChatList
              workspaceId={workspaceId}
              onOpenChat={onOpenChat}
              chatHref={chatHref}
              builds={builds}
              waiting={chatsWaiting}
              activity={activity}
              failed={failedRuns}
              onMarkRead={markRead}
              onNewChat={() => onNewChat()}
            />
          </Tabs.Panel>
          <Tabs.Panel value="agents" className="flex flex-col gap-8">
            <AgentsTab
              state={agents.state}
              onRetry={agents.retry}
              onOpenAgent={onOpenAgent}
              agentHref={agentHref}
              now={now}
              onAddAgent={() => onNewChat(AGENT_DRAFT)}
            />
          </Tabs.Panel>
          <Tabs.Panel value="library" className="flex flex-col gap-8">
            <WorkspaceLibraryList workspaceId={workspaceId} onOpenItem={onOpenItem} itemHref={itemHref} outputHref={outputHref} onOpenSettings={onOpenSettings} onMake={() => onNewChat()} />
          </Tabs.Panel>
          <Tabs.Panel value="automations" className="flex flex-col gap-8">
            <AutomationsTab
              workspaceId={workspaceId}
              onOpenItem={onOpenItem}
              itemHref={itemHref}
              empty={{
                description: 'Ask in a chat for something to happen on a schedule, like a morning summary, or whenever something arrives, like a new email.',
                action: { label: 'Add automation', icon: PlusIcon, variant: 'primary', onClick: () => onNewChat(AUTOMATION_DRAFT) },
              }}
              waiting={{ asks: outsideAsks, onOpen: () => onTabChange('library') }}
            />
          </Tabs.Panel>
          <Tabs.Panel value="members" className="flex flex-col gap-8">
            <WorkspaceMemberList {...sharing} onInvite={canInvite ? () => setInviting(true) : undefined} />
          </Tabs.Panel>
          <Tabs.Panel value="settings" className="flex flex-col gap-8">
            <WorkspaceOptionsTab
              title={title ?? ''}
              onMarkRead={markRead}
              ids={devMode ? [{ title: 'Workspace ID', value: workspaceId }] : undefined}
              removal={removal && {
                kind: removal,
                others: standing ? people.length - 1 : undefined,
                onConfirm: async () => {
                  await removeWorkspace(workspaceId, removal)
                  onRemoved()
                },
              }}
            />
            {/* To look something up in rather than to check, so here rather than a tab of its own. */}
            <section aria-labelledby="workspace-activity-log" className="flex flex-col gap-4">
              <WorkspaceHistory
                activity={activity}
                onOpenChat={onOpenChat}
                chatHref={chatHref}
                scrolls
                heading={<h2 id="workspace-activity-log" className="shrink-0 px-5 text-lg font-medium text-kumo-default">Activity log</h2>}
              />
            </section>
          </Tabs.Panel>
        </Tabs>
      </div>
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
