import { createFileRoute } from '@tanstack/react-router'
import { Sidebar, type SidebarConversation } from '@/blocks/Sidebar'
import { AppShell } from '@/layouts/AppShell'

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
      Content
    </AppShell>
  )
}
