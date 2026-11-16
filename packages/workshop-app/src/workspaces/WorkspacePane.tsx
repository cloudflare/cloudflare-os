import { useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { NotePencilIcon, TrashIcon, UserPlusIcon } from '@phosphor-icons/react'
import { AutomationsTab, type AutomationLink } from '@/automations/AutomationsTab'
import { SettingsGroup, SettingsRow } from '@/blocks/SettingsGroup'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { formatCost } from '@/chat/usage'
import { AvatarStack } from '@/components/AvatarStack'
import { WorkspaceIconPicker } from '@/blocks/WorkspaceIconPicker'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { PageLayout } from '@/layouts/PageLayout'
import type { LibraryEntry } from '@/library/libraryEntries'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { ShareWorkspaceDialog } from '@/sharing/ShareWorkspaceDialog'
import { shareStanding } from '@/sharing/sharingRules'
import { useSharing } from '@/sharing/useSharing'
import { WorkspaceChatList } from './WorkspaceChatList'
import { WorkspaceLibraryList } from './WorkspaceLibraryList'
import { WorkspaceMemberList } from './WorkspaceMemberList'
import { isMuted, useDeleteWorkspace, useRenameWorkspace, useSetNotificationMute, useWorkspaces } from './WorkspacesContext'
import { workspaceLabel } from './workspaceLabel'
import { workspaceMembers } from './workspaceMembers'
import { useSetWorkspaceLook, useWorkspaceLooks } from './useWorkspaceLooks'

/** What a workspace's page shows beneath its title. */
export type WorkspaceTab = 'chats' | 'library' | 'automations' | 'members' | 'settings'

export const WORKSPACE_TABS: { value: WorkspaceTab; label: string }[] = [
  { value: 'chats', label: 'Chats' },
  { value: 'library', label: 'Library' },
  { value: 'automations', label: 'Automations' },
  { value: 'members', label: 'Members' },
  { value: 'settings', label: 'Settings' },
]

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type WorkspacePaneProps = {
  workspaceId: string
  tab: WorkspaceTab
  onTabChange: (tab: WorkspaceTab) => void
  onOpenChat: (chat: { id: number; title: string }) => void
  /** A chat's address, for its row to link to so that it can be opened in another tab. */
  chatHref?: (chatId: number) => string
  /** Shows something the workspace has made, or a file it was sent or worked on. */
  onOpenEntry: (entry: LibraryEntry) => void
  /** Where an entry opens, for its row to link to so that it can be opened in another tab. */
  entryHref?: (entry: LibraryEntry) => string
  /** Where an automation reports, for its row to open and link to. */
  automationLink: AutomationLink
  onNewChat: () => void
  /** The workspace is gone: go somewhere that is still there. */
  onDeleted: () => void
  /** The workspace's address, which inviting people copies. Left out, nobody is invited from here. */
  link?: string
}

const WHOLE_WORKSPACE = {}

/**
 * One workspace: its title, which can be renamed, the way to start a chat in it, who it is shared
 * with and the way to invite more, and, a tab each, its chats, what it has made, what runs by
 * itself, who has access to it and its settings. Each of the chats, library and automations tabs
 * loads what it lists once chosen; who has
 * access is read with the page, for its header.
 */
export const WorkspacePane = ({ workspaceId, tab, onTabChange, onOpenChat, chatHref, onOpenEntry, entryHref, automationLink, onNewChat, onDeleted, link }: WorkspacePaneProps) => {
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const title = workspace?.title
  useDocumentTitle(title || 'Workspace')
  const narrow = useNarrowScreen()
  const look = useWorkspaceLooks()[workspaceId]
  const setLook = useSetWorkspaceLook()

  const { user } = useApi()
  const sharing = useSharing(workspaceId, WHOLE_WORKSPACE, true)
  const [inviting, setInviting] = useState(false)
  const shared = sharing.snapshot.status === 'ready' ? sharing.snapshot : undefined
  const standing = shared && shareStanding(shared.metadata, user)
  const people = standing ? workspaceMembers(standing.owner, shared.collaborators).map(({ profile }) => profile) : []
  // Until its own metadata is read, the list's role says whether the viewer could.
  const canInvite = link !== undefined && (standing ? standing.canShare : workspace !== undefined && workspace.role !== 'use')

  const renameWorkspace = useRenameWorkspace()
  // Why the last new title was not kept.
  const [renameProblem, setRenameProblem] = useState<string>()
  const connection = useConnectionNotice()
  const rename = (next: string) => {
    setRenameProblem(undefined)
    if (connection?.blocked()) return
    renameWorkspace(workspaceId, next).catch((error: unknown) => {
      setRenameProblem(`Couldn’t rename the workspace: ${messageOf(error)}`)
    })
  }

  const setMute = useSetNotificationMute()
  const deleteWorkspace = useDeleteWorkspace()
  // Why the last change to a setting did not hold.
  const [settingProblem, setSettingProblem] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const muted = isMuted(workspace?.notificationMute)
  const setNotifications = (on: boolean) => {
    setSettingProblem(undefined)
    if (connection?.blocked()) return
    setMute(workspaceId, on ? null : { indefinite: true }).catch((error: unknown) => {
      setSettingProblem(`Couldn’t ${on ? 'turn on' : 'mute'} notifications: ${messageOf(error)}`)
    })
  }
  // The server says who owns a workspace only to those who do not.
  const owns = workspace !== undefined && workspace.owner === undefined

  return (
    <PageLayout
      header={(
        <>
          {workspace && <WorkspaceCrumb id={workspaceId} title={workspace.title} label={workspaceLabel(workspace.title)} look={look} expanded />}
          {/* Only once there is someone besides the viewer, each of whom it shows the members of. */}
          {people.length > 1 && (
            <HeaderBubble className="ms-auto">
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
            <HeaderBubble className={people.length > 1 ? undefined : 'ms-auto'}>
              <Button icon={UserPlusIcon} aria-label="Invite people" title="Invite people" onClick={() => setInviting(true)} />
            </HeaderBubble>
          )}
          <HeaderBubble className={people.length > 1 || canInvite ? undefined : 'ms-auto'}>
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
        <Tabs value={tab} onValueChange={onTabChange} tabs={WORKSPACE_TABS} aria-label="Workspace" className="gap-6">
          <Tabs.Panel value="chats" className="flex flex-col gap-8">
            <WorkspaceChatList workspaceId={workspaceId} onOpenChat={onOpenChat} chatHref={chatHref} />
          </Tabs.Panel>
          <Tabs.Panel value="library" className="flex flex-col gap-8">
            <WorkspaceLibraryList workspaceId={workspaceId} onOpen={onOpenEntry} href={entryHref} />
          </Tabs.Panel>
          <Tabs.Panel value="automations" className="flex flex-col gap-8">
            {tab === 'automations' && (
              <AutomationsTab
                workspaceIds={[workspaceId]}
                canChange={() => workspace !== undefined && workspace.role !== 'use'}
                link={automationLink}
                empty="Nothing runs by itself here yet. Ask in a chat for something to happen on a schedule, or when something arrives."
              />
            )}
          </Tabs.Panel>
          <Tabs.Panel value="members" className="flex flex-col gap-8">
            <WorkspaceMemberList {...sharing} />
          </Tabs.Panel>
          <Tabs.Panel value="settings" className="flex flex-col gap-2">
            <SettingsGroup label="Workspace">
              <SettingsRow
                id="workspace-notifications"
                title="Notifications"
                description="Get told when something happens in this workspace’s chats."
                control={workspace && (
                  <Switch
                    aria-labelledby="workspace-notifications-title"
                    aria-describedby="workspace-notifications-description"
                    checked={!muted}
                    onCheckedChange={setNotifications}
                  />
                )}
              />
              {workspace?.totalCost ? (
                <SettingsRow
                  title="Usage"
                  description="What the AI has cost across this workspace so far."
                  control={<span className="text-base text-kumo-default tabular-nums">{formatCost(workspace.totalCost)}</span>}
                />
              ) : null}
            </SettingsGroup>
            {settingProblem && <p role="alert" className="px-4 text-base text-kumo-subtle">{settingProblem}</p>}
            {owns && (
              <SettingsGroup label="Delete">
                <SettingsRow
                  danger
                  title="Delete workspace"
                  description="Deletes its chats, gadgets and files for everyone it’s shared with."
                  control={<Button variant="danger" icon={TrashIcon} onClick={() => setDeleting(true)}>Delete</Button>}
                />
              </SettingsGroup>
            )}
          </Tabs.Panel>
        </Tabs>
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title={title ? `Delete “${title}”?` : 'Delete this workspace?'}
        description="Its chats, gadgets and files go for everyone it’s shared with. This can’t be undone."
        confirm="Delete workspace"
        onConfirm={async () => {
          await deleteWorkspace(workspaceId)
          onDeleted()
        }}
      />
      {canInvite && (
        <ShareWorkspaceDialog
          workspaceId={workspaceId}
          title={title || 'Workspace'}
          link={link}
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
