import { useState } from 'react'
import { ChatHeader } from '@/blocks/ChatHeader'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { Button } from '@/components/Button'
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
  const [page, setPage] = useState({ workspaceId: 'notes', chat: true })
  const workspace = WORKSPACES.find(({ id }) => id === page.workspaceId)!

  return (
    <Section title="ChatHeader, WorkspaceCrumb, HeaderBubble (between a workspace and its chat the crumb stays, growing its title or drawing it in; going to another workspace swaps the bubbles, which pop out and in)">
      <div className="flex w-full flex-col items-start gap-3">
        {page.chat
          ? (
              <ChatHeader
                key={`${workspace.id}/chat`}
                workspace={{ ...workspace, onOpen: () => setPage({ workspaceId: workspace.id, chat: false }) }}
                title={workspace.chat}
              />
            )
          : <WorkspaceCrumb key={workspace.id} {...workspace} expanded />}
        <div className="flex flex-wrap gap-2">
          {WORKSPACES.map(({ id, title }) => (
            <Button key={id} variant="ghost" onClick={() => setPage({ workspaceId: id, chat: false })}>Go to {title}</Button>
          ))}
          <Button variant="ghost" disabled={page.chat} onClick={() => setPage({ workspaceId: workspace.id, chat: true })}>Open a chat</Button>
        </div>
      </div>
    </Section>
  )
}
