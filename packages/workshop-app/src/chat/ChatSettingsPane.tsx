import { useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { CaretLeftIcon, TrashIcon } from '@phosphor-icons/react'
import type { AsideItem } from '@/aside/asideItems'
import { asideItemIcon } from '@/aside/asideItemIcon'
import { useChatLibrary } from '@/aside/useChatLibrary'
import { FileListItem } from '@/blocks/FileListItem'
import { ListGroup } from '@/blocks/ListGroup'
import { SettingsGroup, SettingsRow } from '@/blocks/SettingsGroup'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { isMuted, useSetNotificationMute, useWorkspaces } from '@/workspaces/WorkspacesContext'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { groupByTime } from './timeGroups'
import { formatUsage } from './usage'
import { useChatSession } from './useChatSession'

/** What a chat's settings page shows beneath its title. */
export type ChatSettingsTab = 'library' | 'settings'

export const CHAT_SETTINGS_TABS: { value: ChatSettingsTab; label: string }[] = [
  { value: 'library', label: 'Library' },
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
  onOpenItem: (item: AsideItem) => void
  /** Where an item opens, for its row to link to so that it can be opened in another tab. */
  itemHref?: (item: AsideItem) => string
}

/**
 * What a chat has, apart from the conversation, a tab each: what its workspace has made, as beside
 * the chat (`useChatLibrary`), latest first, grouped by when; and its settings, which are what it
 * is told about (its workspace's notifications), what it has used, and deleting it.
 */
export const ChatSettingsPane = ({ workspaceId, chatId, initialTitle, tab, onTabChange, onBack, onDeleted, onOpenWorkspace, onOpenItem, itemHref }: ChatSettingsPaneProps) => {
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

  const library = useChatLibrary({ workspaceId, chatId })
  const groups = groupByTime(library.items.map((item) => ({ value: item, at: item.at })))

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
        <Tabs value={tab} onValueChange={onTabChange} tabs={CHAT_SETTINGS_TABS} aria-label="Chat" className="gap-6">
          <Tabs.Panel value="library" className="flex flex-col gap-8">
            {chat.status === 'ready' && groups.length === 0 && !library.reading && !library.problem && (
              <p className="px-4 text-center text-base text-kumo-subtle">Nothing here yet. What this workspace makes shows here.</p>
            )}
            {groups.map(({ key, label, entries }) => (
              <ListGroup key={key} label={label}>
                {entries.map(({ value: item, time }) => (
                  <FileListItem
                    key={item.key}
                    title={item.title}
                    icon={asideItemIcon(item)}
                    time={time}
                    href={itemHref?.(item)}
                    onSelect={() => onOpenItem(item)}
                  />
                ))}
              </ListGroup>
            ))}
            {library.reading && <p role="status" className="appears-late px-4 text-base text-kumo-subtle">Loading the library…</p>}
            {library.problem && (
              <p className="flex items-center gap-3 px-4 text-base text-kumo-subtle">
                Couldn’t load the library: {library.problem}
                {library.retry && <Button variant="ghost" onClick={library.retry}>Try again</Button>}
              </p>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="settings" className="flex flex-col gap-2">
            <SettingsGroup label="Chat">
              <SettingsRow
                id="notifications"
                title="Notifications"
                description={workspace?.title
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
                  description="It goes for everyone in the workspace, with all it said. What it made stays in the library. This can’t be undone."
                  control={<Button variant="danger" icon={TrashIcon} disabled={chat.status !== 'ready'} onClick={() => setDeleting(true)}>Delete</Button>}
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
        title={title ? `Delete “${title}”?` : 'Delete this chat?'}
        description="It goes for everyone in the workspace, and can’t be had back."
        confirm="Delete chat"
        onConfirm={async () => {
          await actions.deleteChat()
          onDeleted()
        }}
      />
    </PageLayout>
  )
}
