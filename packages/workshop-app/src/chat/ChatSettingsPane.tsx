import { useMemo, useState } from 'react'
import { CaretLeftIcon, TrayIcon } from '@phosphor-icons/react'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import type { AsideItem } from '@/aside/asideItems'
import { asideItemIcon } from '@/aside/asideItemIcon'
import { useChatLibrary } from '@/aside/useChatLibrary'
import { setUpIn } from '@/automations/automations'
import { AutomationsTab } from '@/automations/AutomationsTab'
import { FileListItem } from '@/blocks/FileListItem'
import { Button, EditableTitle, EmptyState, HeaderBubble, ListGroup, PageLayout, Tabs, groupByTime } from '@gadgets/ui'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { withItemEdits } from '@/library/libraryEdits'
import { useLibraryActions } from '@/library/useLibraryActions'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { ChatOptionsTab } from './ChatOptionsTab'
import { useChatSession } from './useChatSession'

/** What a chat's settings page shows beneath its title. */
export type ChatSettingsTab = 'library' | 'automations' | 'settings'

export const CHAT_SETTINGS_TABS: { value: ChatSettingsTab; label: string }[] = [
  { value: 'settings', label: 'Settings' },
  { value: 'library', label: 'Library' },
  { value: 'automations', label: 'Automations' },
]

export type ChatSettingsPaneProps = {
  workspaceId: string
  chatId: number
  /** The title to show until the chat's own arrives, e.g. from the chat it was opened from. */
  initialTitle?: string
  tab: ChatSettingsTab
  onTabChange: (tab: ChatSettingsTab) => void
  onBack: () => void
  /** Goes to the page of the workspace the chat is in. */
  onOpenWorkspace: () => void
  /** Shows a file or an output, such as beside the chat. */
  onOpenItem: (item: AsideItem) => void
  /** Where an item opens, for its row to link to so that it can be opened in another tab. */
  itemHref?: (item: AsideItem) => string
  /** An output's own page, which sharing it from its more menu lets people in to. */
  outputHref?: (output: OutputSummary) => string
  /** Goes to an output's settings, from its more menu. */
  onOpenSettings?: (output: OutputSummary) => void
  /** The chat was deleted from its Settings: go somewhere else, in place of it in the history. */
  onDeleted: () => void
}

/**
 * What a chat has, apart from the conversation, a tab each: for whoever builds in its workspace,
 * what they can do about the chat (its notifications, marking it read, and deleting it), which it
 * starts with; what its workspace has made, as beside the chat (`useChatLibrary`), latest first,
 * grouped by when; and what the chat set up to run by itself, the hooks bound from it. Whoever may
 * only use the workspace starts with its library.
 */
export const ChatSettingsPane = ({ workspaceId, chatId, initialTitle, tab, onTabChange, onBack, onOpenWorkspace, onOpenItem, itemHref, outputHref, onOpenSettings, onDeleted }: ChatSettingsPaneProps) => {
  const { chat, actions } = useChatSession(workspaceId, chatId)
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const look = useWorkspaceLooks()[workspaceId]
  // Its Settings are for whoever builds in the workspace: someone who can only use it has no chats of it.
  const builds = workspace !== undefined && workspace.role !== 'use'
  const tabs = builds ? CHAT_SETTINGS_TABS : CHAT_SETTINGS_TABS.filter(({ value }) => value !== 'settings')
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

  const library = useChatLibrary({ workspaceId, chatId })
  // What is in the library has a more menu, as on the Library page; what is the chat's alone does not.
  const { edits, actionsOf, problem: libraryProblem, dialogs } = useLibraryActions({ read: library.outputs, outputHref, onOpenSettings })
  const moreOf = (item: AsideItem) => {
    const output = item.kind === 'output' ? library.outputs.find((candidate) => candidate.workspaceId === workspaceId && candidate.workpieceId === item.output.workpieceId) : undefined
    return output && actionsOf(output)
  }
  const groups = groupByTime(withItemEdits(library.items, edits).map((item) => ({ value: item, at: item.at })))
  const ownAutomations = useMemo(() => setUpIn(chatId), [chatId])

  return (
    <PageLayout
      header={(
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
          {workspace && <WorkspaceCrumb id={workspaceId} title={workspace.title} label={workspaceLabel(workspace.title)} look={look} onOpen={onOpenWorkspace} />}
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
        <Tabs value={tabs.some(({ value }) => value === tab) ? tab : tabs[0].value} onValueChange={onTabChange} tabs={tabs} aria-label="Chat" className="gap-6">
          <Tabs.Panel value="library" className="flex flex-col gap-8">
            {libraryProblem && <p role="alert" className="px-4 text-center text-base text-kumo-subtle">{libraryProblem}</p>}
            {chat.status === 'ready' && groups.length === 0 && !library.reading && !library.problem && (
              <EmptyState
                size="section"
                tinted
                icon={TrayIcon}
                title="Nothing made here yet"
                description="The apps, documents and files this workspace’s chats make show here, this chat’s among them."
                actions={[{ label: 'Back to chat', icon: CaretLeftIcon, onClick: onBack }]}
              />
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
                    more={moreOf(item)}
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
          <Tabs.Panel value="automations" className="flex flex-col gap-8">
            {chat.status === 'ready' && (
              <AutomationsTab
                workspaceId={workspaceId}
                chatId={chatId}
                filter={ownAutomations}
                onOpenItem={onOpenItem}
                itemHref={itemHref}
                empty={{
                  description: 'Ask in this chat for something to happen on a schedule, like a morning summary, or whenever something arrives, like a new email.',
                  action: { label: 'Back to chat', icon: CaretLeftIcon, onClick: onBack },
                }}
              />
            )}
          </Tabs.Panel>
          {builds && (
            <Tabs.Panel value="settings" className="flex flex-col gap-8">
              {chat.status === 'ready' && <ChatOptionsTab workspaceId={workspaceId} chatId={chatId} title={title ?? ''} onDeleted={onDeleted} />}
            </Tabs.Panel>
          )}
        </Tabs>
      </div>
      {dialogs}
    </PageLayout>
  )
}
