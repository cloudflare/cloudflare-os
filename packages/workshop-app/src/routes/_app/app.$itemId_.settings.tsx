import { createFileRoute, notFound, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { parseItemPageId } from '@/aside/asideItems'
import { GADGET_SETTINGS_TABS, GadgetSettingsPane, type GadgetSettingsTab } from '@/gadgets/GadgetSettingsPane'
import { useAutomationLink } from '../-automationLink'

const validateTab = (value: unknown): GadgetSettingsTab | undefined =>
  GADGET_SETTINGS_TABS.find((tab) => tab.value === value && value !== 'settings')?.value

/** A gadget's own settings, from its More or full screen: with `?tab=`, what it is connected to, or its automations. */
export const Route = createFileRoute('/_app/app/$itemId_/settings')({
  params: {
    parse: ({ itemId }) => {
      const page = parseItemPageId(itemId)
      if (page?.ref.kind !== 'output') throw notFound()
      return { itemId }
    },
    stringify: ({ itemId }) => ({ itemId }),
  },
  validateSearch: (search: Record<string, unknown>): { tab?: GadgetSettingsTab } => ({ tab: validateTab(search.tab) }),
  component: GadgetSettings,
})

function GadgetSettings() {
  const { itemId } = Route.useParams()
  const { tab = 'settings' } = Route.useSearch()
  const initialTitle = useLocation({ select: (location) => location.state.gadgetTitle })
  const navigate = useNavigate()
  const router = useRouter()
  const automationLink = useAutomationLink()
  const { workspaceId, ref } = parseItemPageId(itemId)!
  const workpieceId = ref.kind === 'output' ? ref.workpieceId : -1
  const gadget = { to: '/app/$itemId', params: { itemId } } as const

  return (
    <GadgetSettingsPane
      key={itemId}
      workspaceId={workspaceId}
      workpieceId={workpieceId}
      initialTitle={initialTitle}
      tab={tab}
      // In place, so that going back leaves the settings rather than going through their tabs.
      onTabChange={(next) => navigate({ to: '/app/$itemId/settings', params: { itemId }, search: { tab: next === 'settings' ? undefined : next }, replace: true })}
      onBack={() => {
        if (router.state.location.state.fromItem) return router.history.back()
        void navigate(gadget)
      }}
      // Its workspace's library, which it was one of; in place, as the gadget is no longer there to go back to.
      onDeleted={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'library' }, replace: true })}
      onOpenConnections={() => navigate({ to: '/connections' })}
      link={new URL(router.buildLocation(gadget).href, window.location.origin).href}
      automationLink={automationLink}
    />
  )
}
