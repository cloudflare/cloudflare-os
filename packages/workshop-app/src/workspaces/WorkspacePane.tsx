import { useState } from 'react'
import { CaretRightIcon, ChatCircleIcon, CirclesFourIcon, NotePencilIcon, UserPlusIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import type { AsideItem } from '@/aside/asideItems'
import { activityWords, runsWantingAttention, type Agent } from '@/automations/agents'
import { AgentsTab } from '@/automations/AgentsTab'
import { AutomationsTab } from '@/automations/AutomationsTab'
import { useWorkspaceAgents } from '@/automations/useWorkspaceAgents'
import { AgentMark } from '@/blocks/AgentMark'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { RemoveWorkspaceDialog } from '@/blocks/RemoveWorkspaceDialog'
import { WorkspaceIconPicker } from '@/blocks/WorkspaceIconPicker'
import { WorkspaceMoreMenu } from '@/blocks/WorkspaceMoreMenu'
import { AvatarStack } from '@/components/AvatarStack'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { useNow } from '@/hooks/useNow'
import { PageLayout } from '@/layouts/PageLayout'
import { useUnread } from '@/notifications/UnreadContext'
import { useApi } from '@/rpc/ApiContext'
import { useWaitingAsks } from '@/gadgets/WaitingAsksProvider'
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
import { gadgetsWaitingIn } from './waitingWords'

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
  /** An output's own page, which sharing it from its row's more menu lets people in to. */
  outputHref?: (output: OutputSummary) => string
  /** Goes to an output's settings, from its row's more menu. */
  onOpenSettings?: (output: OutputSummary) => void
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
export const WorkspacePane = ({ workspaceId, tab, onTabChange, onOpenChat, chatHref, onOpenAgent, agentHref, onOpenItem, itemHref, outputHref, onOpenSettings, onNewChat, link, onRemoved }: WorkspacePaneProps) => {
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
  // What else waits on the viewer: its gadgets that ask something, and the chats people had with
  // its agent stopped on a decision or an action, each counted on the tab that lists it.
  const asks = useWaitingAsks()
  const gadgetsWaiting = gadgetsWaitingIn(workspaceId, asks.byGadget)
  const chatsWaiting = agents.state.status === 'ready' ? agents.state.chatsWaiting : undefined
  const counts: Partial<Record<WorkspaceTab, number>> = { chats: chatsWaiting?.size ?? 0, agents: waiting.length, library: gadgetsWaiting }
  const tabs = WORKSPACE_TABS.map((each) => {
    const value = counts[each.value] ?? 0
    return value > 0 ? { ...each, count: { value, label: 'waiting on you' } } : each
  })
  const attention = waitingOf({ runs: waiting, failed: wanting, gadgets: gadgetsWaiting, chats: chatsWaiting?.size ?? 0 })
  const openRun = (run: { chatId: number; title: string }) => onOpenChat({ id: run.chatId, title: run.title })

  const renameWorkspace = useRenameWorkspace()
  // Why the last new title was not kept, or the workspace was not marked read.
  const [renameProblem, setRenameProblem] = useState<string>()
  const connection = useConnectionNotice()
  const unread = useUnread()
  // Its marks clear as the account says they have.
  const markRead = unread?.totals.workspaces.has(workspaceId)
    ? () => {
        setRenameProblem(undefined)
        if (connection?.blocked()) return
        unread.markWorkspaceRead(workspaceId).catch((error: unknown) => {
          setRenameProblem(`Couldn’t mark the workspace read: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    : undefined
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
            {(removal || markRead) && (
              <HeaderBubble className="shrink-0">
                <WorkspaceMoreMenu
                  title={title || 'Workspace'}
                  triggerVariant="secondary"
                  onMarkRead={markRead}
                  removal={removal && {
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
          {/* What waits on the viewer, or when it was last active: one line, always there, so that
              what comes in as it is read, or a tab changed, moves nothing under it. */}
          <div className="flex h-(--control-size) items-center justify-center">
            {attention ? (
              <WaitingPill
                {...attention}
                onOpen={({ to }) => ('run' in to ? openRun(to.run) : 'agent' in to ? onOpenAgent(to.agent) : onTabChange(to.tab))}
              />
            ) : workspace?.lastActive && (
              <span className="appears text-sm text-kumo-subtle">Active {activityWords(workspace.lastActive, new Date(now))}</span>
            )}
          </div>
        </div>
        <Tabs value={tab} onValueChange={onTabChange} tabs={tabs} aria-label="Workspace" className="gap-6">
          <Tabs.Panel value="chats" className="flex flex-col gap-8">
            <WorkspaceChatList workspaceId={workspaceId} onOpenChat={onOpenChat} chatHref={chatHref} builds={workspace !== undefined && workspace.role !== 'use'} waiting={chatsWaiting} />
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
            <WorkspaceLibraryList workspaceId={workspaceId} onOpenItem={onOpenItem} itemHref={itemHref} outputHref={outputHref} onOpenSettings={onOpenSettings} />
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

type WaitingOf = {
  /** Its agents' runs waiting on the viewer, each with its agent. */
  runs: ReturnType<typeof runsWantingAttention>
  /** Those, and its agents whose latest run failed. */
  failed: ReturnType<typeof runsWantingAttention>
  gadgets: number
  chats: number
}

/** One thing, or one kind of thing, that waits on the viewer, and where it is seen to. */
type WaitingEntry = {
  key: string
  kind: 'agent' | 'chat' | 'gadget'
  label: string
  to: { tab: WorkspaceTab } | { run: { chatId: number; title: string } } | { agent: Agent }
}

// An agent's runs among `runs`, as one entry each: one run opens by itself, several their agent's page.
const agentEntries = (runs: WaitingOf['runs'], said: (count: number) => string): WaitingEntry[] => {
  const byAgent = new Map<string, WaitingOf['runs']>()
  for (const entry of runs) byAgent.set(entry.agent.key, [...(byAgent.get(entry.agent.key) ?? []), entry])
  return [...byAgent.values()].map((own) => ({
    key: `agent:${own[0]!.agent.key}`,
    kind: 'agent',
    label: `${own[0]!.agent.name} · ${said(own.length)}`,
    to: own.length === 1 ? { run: own[0]!.run } : { agent: own[0]!.agent },
  }))
}

/**
 * What waits on the viewer in a workspace, for the line under its title: how many, and each,
 * where it is seen to: a run by itself, gadgets and chats on the tab that lists them. A failed run
 * is said only where nothing waits.
 */
const waitingOf = ({ runs, failed, gadgets, chats }: WaitingOf): { tone: 'warning' | 'danger'; label: string; entries: WaitingEntry[] } | undefined => {
  const entries: WaitingEntry[] = [
    ...agentEntries(runs, (count) => (count === 1 ? 'a run' : `${count} runs`)),
    ...(chats > 0 ? [{ key: 'chats', kind: 'chat' as const, label: chats === 1 ? 'A chat' : `${chats} chats`, to: { tab: 'chats' as const } }] : []),
    ...(gadgets > 0 ? [{ key: 'gadgets', kind: 'gadget' as const, label: gadgets === 1 ? 'A gadget' : `${gadgets} gadgets`, to: { tab: 'library' as const } }] : []),
  ]
  const count = runs.length + chats + gadgets
  if (count > 0) return { tone: 'warning', label: `${count} waiting on you`, entries }
  if (failed.length > 0) {
    return {
      tone: 'danger',
      label: failed.length === 1 ? `${failed[0].agent.name}’s latest run failed` : `${failed.length} agents’ latest runs failed`,
      entries: agentEntries(failed, () => 'latest run'),
    }
  }
  return undefined
}

// An agent, in a menu, as its own page draws it.
const AgentGlyph = () => <AgentMark size="small" />

/**
 * What waits on the viewer, as a pill in the caution's colour (or a failure's): one thing opens at
 * once; several open a menu of each, as the tabs that list them have them counted.
 */
const WaitingPill = ({ tone, label, entries, onOpen }: { tone: 'warning' | 'danger'; label: string; entries: WaitingEntry[]; onOpen: (entry: WaitingEntry) => void }) => {
  const look = cn(
    'appears rounded-full ps-2.5 text-sm font-normal',
    tone === 'danger' ? 'bg-kumo-danger-tint text-kumo-danger not-data-disabled:hover:bg-kumo-danger/15' : 'bg-kumo-warning-tint text-kumo-default not-data-disabled:hover:bg-kumo-warning/20',
  )
  const dot = <span aria-hidden="true" className={cn('size-1.5 rounded-full', tone === 'danger' ? 'bg-kumo-danger' : 'bg-kumo-warning')} />
  if (entries.length === 1) {
    return <Button className={look} onClick={() => onOpen(entries[0]!)}><span className="flex items-center gap-2">{dot}{label}<CaretRightIcon aria-hidden="true" weight="bold" className="size-3 text-kumo-subtle" /></span></Button>
  }
  return (
    <DropdownMenu label={<span className="flex items-center gap-2">{dot}{label}</span>} caret keepTrigger triggerClassName={look} triggerVariant="secondary" align="center">
      {entries.map((entry) => (
        <DropdownMenu.Item key={entry.key} icon={entry.kind === 'agent' ? AgentGlyph : entry.kind === 'chat' ? ChatCircleIcon : CirclesFourIcon} onSelect={() => onOpen(entry)}>
          {entry.label}
        </DropdownMenu.Item>
      ))}
    </DropdownMenu>
  )
}
