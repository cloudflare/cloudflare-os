import { createFileRoute, notFound, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import type { AsideItem } from '@/aside/asideItems'
import { rememberShown } from '@/aside/lastShown'
import { asideFor } from '@/aside/useAsideNavigation'
import { CHAT_SETTINGS_TABS, ChatSettingsPane, type ChatSettingsTab } from '@/chat/ChatSettingsPane'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { writeLayoutPrefs } from '@/prefs/layoutPrefs'

const validateTab = (value: unknown): ChatSettingsTab | undefined =>
  CHAT_SETTINGS_TABS.find((tab) => tab.value === value && value !== 'library')?.value

/** A chat's settings, opened from its title: what was made beside it, or with `?tab=`, its settings. */
export const Route = createFileRoute('/_app/workspace/$workspaceId/chat/$chatId_/settings')({
  params: {
    parse: ({ workspaceId, chatId }) => {
      const id = Number(chatId)
      if (!Number.isSafeInteger(id) || id < 0) throw notFound()
      return { workspaceId, chatId: id }
    },
    stringify: ({ workspaceId, chatId }) => ({ workspaceId, chatId: String(chatId) }),
  },
  validateSearch: (search: Record<string, unknown>): { tab?: ChatSettingsTab } => ({ tab: validateTab(search.tab) }),
  component: ChatSettings,
})

function ChatSettings() {
  const { workspaceId, chatId } = Route.useParams()
  const { tab = 'library' } = Route.useSearch()
  const refreshWorkspaces = useRefreshWorkspaces()
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
      tab={tab}
      // In place, so that going back leaves the settings rather than going through their tabs.
      onTabChange={(next) =>
        navigate({
          to: '/workspace/$workspaceId/chat/$chatId/settings',
          params: { workspaceId, chatId },
          search: { tab: next === 'library' ? undefined : next },
          replace: true,
          state: router.state.location.state,
        })
      }
      onDeleted={() => {
        refreshWorkspaces()
        void navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, replace: true })
      }}
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
