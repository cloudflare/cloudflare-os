import { createFileRoute } from '@tanstack/react-router'
import { Composer } from '@/blocks/Composer'
import { MessageBubble } from '@/blocks/MessageBubble'
import { Sidebar, type SidebarConversation } from '@/blocks/Sidebar'
import { ThinkingIndicator } from '@/blocks/ThinkingIndicator'
import { Button } from '@/components/Button'
import { AppShell } from '@/layouts/AppShell'
import { ChatLayout } from '@/layouts/ChatLayout'

export const Route = createFileRoute('/')({
  component: Home,
})

// Mock data until conversations come from the backend.
const conversations: SidebarConversation[] = [
  {
    id: '1',
    workspaceLabel: 'EN',
    title: 'Refactor conditional rendering logic',
    preview: 'I see what you’re aiming for…',
    unread: true,
  },
  {
    id: '2',
    workspaceLabel: 'DE',
    title: 'Create a new slideshow about the Alps',
    preview: 'Here’s your new slideshow…',
  },
  {
    id: '3',
    workspaceLabel: 'FR',
    title: 'Create a new slideshow about Paris',
    preview: 'Here’s your new slideshow…',
  },
]

// Placeholder logos until real connected apps are wired in.
const placeholderLogos = [0, 1, 2].map((i) => <span key={i} className="size-5 rounded-full bg-kumo-fill" />)

function Home() {
  return (
    <AppShell
      sidebar={
        <Sidebar
          user={{ name: 'Balint' }}
          conversations={conversations}
          selectedConversationId="1"
          connections={placeholderLogos}
        />
      }
    >
      <ChatLayout header={<Button>Refactor conditional rendering logic</Button>} composer={<Composer onSend={() => {}} />}>
        <MessageBubble role="user">Create a dashboard showcasing my jira stats</MessageBubble>
        <MessageBubble role="assistant">
          I’ll build a personal Jira dashboard with open work, status and project breakdowns, overdue
          issues, and recent resolutions.
        </MessageBubble>
        <MessageBubble role="assistant">
          Created <strong>My Jira Dashboard</strong> with your live Jira stats:
          <ul className="list-disc pl-5">
            <li>11 open issues</li>
            <li>3 resolved in the last 30 days, including cancelled issues</li>
            <li>0 overdue</li>
          </ul>
        </MessageBubble>
        <ThinkingIndicator />
      </ChatLayout>
    </AppShell>
  )
}
