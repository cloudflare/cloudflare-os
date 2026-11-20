import { createFileRoute, notFound, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { outputPage, outputSettings, type AsideItem } from '@/aside/asideItems'
import { rememberShown } from '@/aside/lastShown'
import { asideFor } from '@/aside/useAsideNavigation'
import { CHAT_SETTINGS_TABS, ChatSettingsPane, type ChatSettingsTab } from '@/chat/ChatSettingsPane'
import { writeLayoutPrefs } from '@/prefs/layoutPrefs'
import { usePreferences } from '@/prefs/UserPreferencesContext'

const validateTab = (value: unknown): ChatSettingsTab | undefined =>
  CHAT_SETTINGS_TABS.find((tab) => tab.value === value && value !== 'settings')?.value

/**
 * A chat's settings, opened from its title: what can be done about the chat, or with `?tab=`, what
 * its workspace has made, or what the chat set up to run by itself, which the card of what the chat
 * has lists too.
 */
export const Route = createFileRoute('/_app/workspace/$workspaceId/chat/$chatId_/settings')({
  validateSearch: (search: Record<string, unknown>): { tab?: ChatSettingsTab } => ({ tab: validateTab(search.tab) }),
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
  const { tab = 'settings' } = Route.useSearch()
  const initialTitle = useLocation({ select: (location) => location.state.chatTitle })
  const navigate = useNavigate()
  const router = useRouter()
  const preferences = usePreferences()
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
          search: { tab: next === 'settings' ? undefined : next },
          state: (state) => state,
          replace: true,
        })
      }
      outputHref={(output) => router.buildLocation(outputPage(output)).href}
      onOpenSettings={(output) => navigate(outputSettings(output))}
      // To its workspace's page, which lists what is left, in the deleted chat's place in the history.
      onDeleted={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, replace: true })}
      onBack={() => {
        if (router.state.location.state.fromChat) return router.history.back()
        void navigate(chat(asideFor(preferences, { workspaceId, chatId })))
      }}
      onOpenWorkspace={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } })}
      onOpenItem={(item: AsideItem) => {
        rememberShown(preferences, workspaceId, chatId, item.key)
        writeLayoutPrefs({ asideOpen: true })
        void navigate(chat(item.key))
      }}
      itemHref={(item) => router.buildLocation(chat(item.key)).href}
    />
  )
}
