import { createFileRoute, notFound, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { pageOf } from '@/aside/asideItems'
import { rememberShown } from '@/aside/lastShown'
import { asideFor } from '@/aside/useAsideNavigation'
import { ChatSettingsPane } from '@/chat/ChatSettingsPane'
import type { LibraryEntry } from '@/library/libraryEntries'
import { writeLayoutPrefs } from '@/prefs/layoutPrefs'

/** A chat's settings, opened from its title: for now, what was sent and made in it. */
export const Route = createFileRoute('/_app/workspace/$workspaceId/chat/$chatId_/settings')({
  params: {
    parse: ({ workspaceId, chatId }) => {
      const id = Number(chatId)
      if (!Number.isSafeInteger(id) || id < 0) throw notFound()
      return { workspaceId, chatId: id }
    },
    stringify: ({ workspaceId, chatId }) => ({ workspaceId, chatId: String(chatId) }),
  },
  component: ChatSettings,
})

function ChatSettings() {
  const { workspaceId, chatId } = Route.useParams()
  const initialTitle = useLocation({ select: (location) => location.state.chatTitle })
  const navigate = useNavigate()
  const router = useRouter()
  // The chat, with `open` shown beside it.
  const chat = (open: string | undefined) =>
    ({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId }, search: { open } }) as const
  // Beside the chat, unless it is a file sent in another, whose bytes are reached through that one:
  // that opens as its own page, shown from there.
  const elsewhere = (entry: LibraryEntry) => entry.item.kind === 'file' && entry.chatId !== chatId
  const target = (entry: LibraryEntry) =>
    elsewhere(entry) ? { ...pageOf(workspaceId, entry.item), search: { chat: entry.chatId } } : chat(entry.item.key)

  return (
    <ChatSettingsPane
      key={`${workspaceId}/${chatId}`}
      workspaceId={workspaceId}
      chatId={chatId}
      initialTitle={initialTitle}
      onBack={() => {
        if (router.state.location.state.fromChat) return router.history.back()
        void navigate(chat(asideFor({ workspaceId, chatId })))
      }}
      onOpenWorkspace={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } })}
      onOpen={(entry) => {
        if (elsewhere(entry)) return void navigate(target(entry))
        rememberShown(workspaceId, chatId, entry.item.key)
        writeLayoutPrefs({ asideOpen: true })
        void navigate(chat(entry.item.key))
      }}
      href={(entry) => router.buildLocation(target(entry)).href}
    />
  )
}
