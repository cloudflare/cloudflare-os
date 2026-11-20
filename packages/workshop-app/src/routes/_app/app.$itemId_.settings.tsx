import { createFileRoute, notFound, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { formatAsideRef, parseItemPageId } from '@/aside/asideItems'
import { GadgetSettingsPane } from '@/gadgets/GadgetSettingsPane'
import { DEFAULT_GADGET_SETTINGS_TAB, GADGET_SETTINGS_TABS, type GadgetSettingsTab } from '@/gadgets/GadgetSettingsView'

const validateTab = (value: unknown): GadgetSettingsTab | undefined =>
  GADGET_SETTINGS_TABS.find((tab) => tab.value === value && value !== DEFAULT_GADGET_SETTINGS_TAB)?.value

/**
 * A gadget's own settings, from its More menu: its settings, or with `?tab=`, what it is connected
 * to. Its code is viewed in its place in the pane.
 */
export const Route = createFileRoute('/_app/app/$itemId_/settings')({
  params: {
    parse: ({ itemId }) => {
      if (parseItemPageId(itemId)?.ref.kind !== 'output') throw notFound()
      return { itemId }
    },
    stringify: ({ itemId }) => ({ itemId }),
  },
  validateSearch: (search: Record<string, unknown>): { tab?: GadgetSettingsTab } => ({ tab: validateTab(search.tab) }),
  component: GadgetSettings,
})

function GadgetSettings() {
  const { itemId } = Route.useParams()
  const { tab = DEFAULT_GADGET_SETTINGS_TAB } = Route.useSearch()
  const initialTitle = useLocation({ select: (location) => location.state.gadgetTitle })
  const navigate = useNavigate()
  const router = useRouter()
  const { workspaceId, ref } = parseItemPageId(itemId)!
  const workpieceId = ref.kind === 'output' ? ref.workpieceId : -1

  return (
    <GadgetSettingsPane
      // Keyed, so that what was said of one gadget is not carried to the next.
      key={itemId}
      workspaceId={workspaceId}
      workpieceId={workpieceId}
      initialTitle={initialTitle}
      tab={tab}
      // In place, so that going back leaves the settings rather than going through their tabs.
      onTabChange={(next) => navigate({ to: '/app/$itemId/settings', params: { itemId }, search: { tab: next === DEFAULT_GADGET_SETTINGS_TAB ? undefined : next }, replace: true, state: true })}
      onBack={() => {
        if (router.state.location.state.fromItem) return router.history.back()
        void navigate({ to: '/app/$itemId', params: { itemId } })
      }}
      // Its workspace's library, which it was one of; in place, as the gadget is no longer there to go back to.
      onDeleted={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'library' }, replace: true })}
      onOpenWorkspace={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } })}
      // The chat that holds the update, with the gadget beside it, showing it.
      onUpdateProposed={(chatId) => navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId }, search: { open: formatAsideRef(ref) } })}
      // By the spawner's id, which the agent's page takes to its agent.
      onOpenAgent={(spawnerId) => navigate({ to: '/workspace/$workspaceId/agent/$agentKey', params: { workspaceId, agentKey: String(spawnerId) } })}
      agentHref={(spawnerId) => router.buildLocation({ to: '/workspace/$workspaceId/agent/$agentKey', params: { workspaceId, agentKey: String(spawnerId) } }).href}
    />
  )
}
