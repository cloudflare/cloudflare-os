import { useState } from 'react'
import { NotePencilIcon } from '@phosphor-icons/react'
import { ChatHeader } from '@/blocks/ChatHeader'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { Button } from '@/components/Button'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Section } from './Section'

const WORKSPACES = [
  { id: 'notes', title: 'Engineering Notes', label: 'EN', chat: 'Write a simple Todo app' },
  { id: 'paris', title: 'Paris slides', label: 'PS', chat: 'Create a new slideshow about the history of Paris' },
]

/**
 * The headers of a workspace's page and of a chat, each mounted anew as a page's is, with the
 * moves between them: to a chat and back, and to another workspace as from the sidebar.
 */
export const HeaderPreview = () => {
  // The chat open, by its title, or none for the workspace's own page.
  const [page, setPage] = useState<{ workspaceId: string; chat?: string }>({ workspaceId: 'notes', chat: WORKSPACES[0].chat })
  const workspace = WORKSPACES.find(({ id }) => id === page.workspaceId)!
  const [chatTitle, setChatTitle] = useState('Refactor conditional rendering logic')

  return (
    <>
    <Section title="EditableTitle (a chat's title on its settings page: plain text until pointed at or clicked into; Enter or leaving keeps it, Escape puts it back, and a blank one is not kept; then one with no title yet)">
      <div className="flex w-full flex-col items-center gap-4 text-xl font-medium text-kumo-default">
        <EditableTitle value={chatTitle} onRename={setChatTitle} aria-label="Chat title" className="text-center" />
        <EditableTitle value="" onRename={() => {}} aria-label="Chat title" placeholder="Untitled chat" className="text-center" />
      </div>
    </Section>
    <Section title="ChatHeader, WorkspaceCrumb, HeaderBubble (between a workspace and its chat the crumb stays, growing its title or drawing it in; going to another workspace swaps the bubbles, which pop out and in. A workspace's page has a New chat button, which opens a chat that starts with the first message)">
      <div className="flex w-full flex-col items-start gap-3">
        {page.chat
          ? (
              <ChatHeader
                key={`${workspace.id}/${page.chat}`}
                workspace={{ ...workspace, onOpen: () => setPage({ workspaceId: workspace.id }) }}
                title={page.chat}
                onOpenSettings={() => {}}
              />
            )
          : (
              <div key={workspace.id} className="flex w-full items-center">
                <WorkspaceCrumb {...workspace} expanded />
                <HeaderBubble className="ms-auto">
                  <Button variant="primary" icon={NotePencilIcon} onClick={() => setPage({ workspaceId: workspace.id, chat: 'New chat' })}>New chat</Button>
                </HeaderBubble>
              </div>
            )}
        <div className="flex flex-wrap gap-2">
          {WORKSPACES.map(({ id, title }) => (
            <Button key={id} variant="ghost" onClick={() => setPage({ workspaceId: id })}>Go to {title}</Button>
          ))}
          <Button variant="ghost" disabled={page.chat !== undefined} onClick={() => setPage({ workspaceId: workspace.id, chat: workspace.chat })}>Open a chat</Button>
        </div>
      </div>
    </Section>
    </>
  )
}
