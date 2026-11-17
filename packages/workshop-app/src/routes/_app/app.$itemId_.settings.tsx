import { createFileRoute, notFound, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { parseItemPageId } from '@/aside/asideItems'
import { GadgetSettingsPane } from '@/gadgets/GadgetSettingsPane'
import { GADGET_SETTINGS_TABS, type GadgetSettingsTab } from '@/gadgets/GadgetSettingsView'

const validateTab = (value: unknown): GadgetSettingsTab | undefined =>
  GADGET_SETTINGS_TABS.find((tab) => tab.value === value && value !== 'connections')?.value

/**
 * A gadget's own settings, from its More menu: what it is connected to, or with `?tab=`, its code,
 * where `?file=` names the file shown, or its settings.
 */
export const Route = createFileRoute('/_app/app/$itemId_/settings')({
  params: {
    parse: ({ itemId }) => {
      if (parseItemPageId(itemId)?.ref.kind !== 'output') throw notFound()
      return { itemId }
    },
    stringify: ({ itemId }) => ({ itemId }),
  },
  validateSearch: (search: Record<string, unknown>): { tab?: GadgetSettingsTab; file?: string } => {
    const tab = validateTab(search.tab)
    // A path that reads as something else, such as a number, is still a path.
    return tab === 'code' && search.file !== undefined && search.file !== '' ? { tab, file: String(search.file) } : { tab }
  },
  component: GadgetSettings,
})

function GadgetSettings() {
  const { itemId } = Route.useParams()
  const { tab = 'connections', file } = Route.useSearch()
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
      onTabChange={(next) => navigate({ to: '/app/$itemId/settings', params: { itemId }, search: { tab: next === 'connections' ? undefined : next }, replace: true, state: true })}
      file={file}
      // In place too: going back leaves the code, not each file looked at.
      onShowFile={(path) => navigate({ to: '/app/$itemId/settings', params: { itemId }, search: { tab: 'code', file: path }, replace: true, state: true })}
      onBack={() => {
        if (router.state.location.state.fromItem) return router.history.back()
        void navigate({ to: '/app/$itemId', params: { itemId } })
      }}
      // Its workspace's library, which it was one of; in place, as the gadget is no longer there to go back to.
      onDeleted={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'library' }, replace: true })}
      onOpenWorkspace={() => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } })}
    />
  )
}
