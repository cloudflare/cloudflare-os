import { useMemo, useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { CaretLeftIcon, FolderPlusIcon, TrashIcon } from '@phosphor-icons/react'
import { inChat } from '@/automations/automations'
import { startedInChat } from '@/automations/agents'
import { AutomationsTab, type AutomationLink } from '@/automations/AutomationsTab'
import { SettingsGroup, SettingsRow } from '@/blocks/SettingsGroup'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { NameDialog } from '@/components/NameDialog'
import { Tabs } from '@/components/Tabs'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import type { LibraryEntry } from '@/library/libraryEntries'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { WorkspaceLibraryList } from '@/workspaces/WorkspaceLibraryList'
import { isMuted, useMakeWorkspace, useSetNotificationMute, useWorkspaces } from '@/workspaces/WorkspacesContext'
import { isNamedWorkspace } from '@/workspaces/workspaceKind'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { ChatConnectionList } from './ChatConnectionList'
import { formatUsage } from './usage'
import { useChatSession } from './useChatSession'

/** What a chat's settings page shows beneath its title. */
export type ChatSettingsTab = 'library' | 'connections' | 'automations' | 'settings'

export const CHAT_SETTINGS_TABS: { value: ChatSettingsTab; label: string }[] = [
  { value: 'library', label: 'Library' },
  { value: 'connections', label: 'Connections' },
  { value: 'automations', label: 'Automations' },
  { value: 'settings', label: 'Settings' },
]

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type ChatSettingsPaneProps = {
  workspaceId: string
  chatId: number
  /** The title to show until the chat's own arrives, e.g. from the chat it was opened from. */
  initialTitle?: string
  tab: ChatSettingsTab
  onTabChange: (tab: ChatSettingsTab) => void
  onBack: () => void
  /** The chat is gone: go somewhere that is still there. */
  onDeleted: () => void
  /** Goes to the page of the workspace the chat is in. */
  onOpenWorkspace: () => void
  /** Shows a file or an output, such as beside the chat. */
  onOpen: (entry: LibraryEntry) => void
  /** Where an entry opens, for its row to link to so that it can be opened in another tab. */
  href?: (entry: LibraryEntry) => string
  /** Where an automation reports, for its row to open and link to. */
  automationLink: AutomationLink
  /** Where the accounts its connections go through are managed. */
  onOpenConnections: () => void
}

/**
 * What a chat has, apart from the conversation, a tab each: what its workspace has made, was sent
 * and worked on, on the Library's rows (`WorkspaceLibraryList`); what its agent can use
 * (`ChatConnectionList`); what runs by itself in it, or was
 * set up from it for a gadget; and its settings, which are what it is told about (its workspace's
 * notifications), what it has used, and deleting it.
 */
export const ChatSettingsPane = ({ workspaceId, chatId, initialTitle, tab, onTabChange, onBack, onDeleted, onOpenWorkspace, onOpen, href, automationLink, onOpenConnections }: ChatSettingsPaneProps) => {
  const { chat, actions } = useChatSession(workspaceId, chatId)
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const look = useWorkspaceLooks()[workspaceId]
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

  const setMute = useSetNotificationMute()
  // Why the last change to a setting did not hold.
  const [settingProblem, setSettingProblem] = useState<string>()
  const muted = isMuted(workspace?.notificationMute)
  const setNotifications = (on: boolean) => {
    setSettingProblem(undefined)
    if (connection?.blocked()) return
    setMute(workspaceId, on ? null : { indefinite: true }).catch((error: unknown) => {
      setSettingProblem(`Couldn’t ${on ? 'turn on' : 'mute'} notifications: ${messageOf(error)}`)
    })
  }
  const [deleting, setDeleting] = useState(false)
  const canBuild = workspace !== undefined && workspace.role !== 'use'
  // A chat on its own is in a workspace of its own, which is never named; it can be made a named one.
  const named = isNamedWorkspace(workspace)
  const makeWorkspace = useMakeWorkspace()
  const [naming, setNaming] = useState(false)
  // The hooks this chat's cards show, so a gadget's it set up are among its automations.
  const pinned = chat.status === 'ready' ? chat.pinned : undefined
  const ownAgents = useMemo(() => startedInChat(chatId), [chatId])
  const ownAutomations = useMemo(
    () => inChat(chatId, new Set(pinned?.flatMap((item) => (item.kind === 'hook' && item.hookId !== undefined ? [item.hookId] : [])))),
    [chatId, pinned],
  )

  return (
    <PageLayout
      header={(
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
          {workspace && named && <WorkspaceCrumb id={workspaceId} title={workspace.title} label={workspaceLabel(workspace.title)} look={look} onOpen={onOpenWorkspace} />}
          <HeaderBubble>
            <Button icon={CaretLeftIcon} onClick={onBack}>Back to chat</Button>
          </HeaderBubble>
        </nav>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
        <div className="flex flex-col items-center gap-2 pt-8 text-center">
          {workspace && named && (
            <span className="flex items-center gap-2 text-base text-kumo-subtle">
              <WorkspaceIcon label={workspaceLabel(workspace.title)} {...look} small />
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
        <Tabs value={tab} onValueChange={onTabChange} tabs={CHAT_SETTINGS_TABS} aria-label="Chat" className="gap-6">
          <Tabs.Panel value="library" className="flex flex-col gap-8">
            <WorkspaceLibraryList workspaceId={workspaceId} onOpen={onOpen} href={href} />
          </Tabs.Panel>
          <Tabs.Panel value="connections" className="flex flex-col gap-8">
            {tab === 'connections' && <ChatConnectionList workspaceId={workspaceId} chatId={chatId} onManage={onOpenConnections} />}
          </Tabs.Panel>
          <Tabs.Panel value="automations" className="flex flex-col gap-8">
            {tab === 'automations' && (
              <AutomationsTab
                workspaceIds={[workspaceId]}
                filter={ownAutomations}
                agentFilter={ownAgents}
                canChange={() => canBuild}
                link={automationLink}
                empty="Nothing runs by itself from this chat yet. Ask here for something to happen on a schedule, or when something arrives, and it reports back here."
              />
            )}
          </Tabs.Panel>
          <Tabs.Panel value="settings" className="flex flex-col gap-2">
            <SettingsGroup label="Chat">
              <SettingsRow
                id="notifications"
                title="Notifications"
                description={workspace?.title && named
                  ? `Get told when something happens here. This is for all of ${workspace.title}, as notifications can’t be muted one chat at a time.`
                  : 'Get told when something happens here.'}
                control={workspace && (
                  <Switch
                    aria-labelledby="notifications-title"
                    aria-describedby="notifications-description"
                    checked={!muted}
                    onCheckedChange={setNotifications}
                  />
                )}
              />
              {canBuild && !named && (
                <SettingsRow
                  title="Make it a workspace"
                  description="Give it a name, and it becomes a place to keep more chats, apps and files, and to work on them with others."
                  control={<Button icon={FolderPlusIcon} onClick={() => setNaming(true)}>Make workspace</Button>}
                />
              )}
              {chat.status === 'ready' && chat.usage && (
                <SettingsRow
                  title="Usage"
                  description="What the AI has used in this chat so far."
                  control={<span className="text-base text-kumo-default tabular-nums">{formatUsage(chat.usage)}</span>}
                />
              )}
            </SettingsGroup>
            {settingProblem && <p role="alert" className="px-4 text-base text-kumo-subtle">{settingProblem}</p>}
            {canBuild && (
              <SettingsGroup label="Delete">
                <SettingsRow
                  danger
                  title="Delete chat"
                  description={named
                    ? 'It goes for everyone in the workspace, with all it said. What it made stays in the library. This can’t be undone.'
                    : 'It goes for everyone it’s shared with, with all it said. What it made stays in the library. This can’t be undone.'}
                  control={<Button variant="danger" icon={TrashIcon} disabled={chat.status !== 'ready'} onClick={() => setDeleting(true)}>Delete</Button>}
                />
              </SettingsGroup>
            )}
          </Tabs.Panel>
        </Tabs>
      </div>
      <NameDialog
        // Each time, starting from the chat's own name.
        key={String(naming)}
        open={naming}
        onOpenChange={setNaming}
        title="Make it a workspace"
        description="This chat, and what it made, will be in it. Start more chats there, and share it to work together."
        label="Name"
        initial={title ?? ''}
        placeholder="Q3 planning"
        confirm="Make workspace"
        keepable
        onSubmit={(name) => makeWorkspace(workspaceId, name)}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title={title ? `Delete “${title}”?` : 'Delete this chat?'}
        description={named ? 'It goes for everyone in the workspace, and can’t be had back.' : 'It goes for everyone it’s shared with, and can’t be had back.'}
        confirm="Delete chat"
        onConfirm={async () => {
          await actions.deleteChat()
          onDeleted()
        }}
      />
    </PageLayout>
  )
}
