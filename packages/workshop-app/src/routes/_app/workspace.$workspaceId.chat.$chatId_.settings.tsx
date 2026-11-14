import { createFileRoute, notFound, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import type { AsideItem } from '@/aside/asideItems'
import { rememberShown } from '@/aside/lastShown'
import { asideFor } from '@/aside/useAsideNavigation'
import { ChatSettingsPane } from '@/chat/ChatSettingsPane'
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
      onOpenItem={(item: AsideItem) => {
        rememberShown(workspaceId, chatId, item.key)
        writeLayoutPrefs({ asideOpen: true })
        void navigate(chat(item.key))
      }}
      itemHref={(item) => router.buildLocation(chat(item.key)).href}
    />
  )
}
