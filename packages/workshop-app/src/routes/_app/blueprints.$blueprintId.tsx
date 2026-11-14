import { createFileRoute, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { itemPage } from '@/aside/asideItems'
import { BlueprintPane } from '@/blueprints/BlueprintPane'

/**
 * One blueprint, on a page of its own, as its link is shared: opened from the Library's Blueprints
 * tab, which is where going back goes, or from Home. Using it shows the gadget it made.
 */
export const Route = createFileRoute('/_app/blueprints/$blueprintId')({
  component: BlueprintPage,
})

function BlueprintPage() {
  const { blueprintId } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  const location = useLocation()
  return (
    <BlueprintPane
      key={blueprintId}
      blueprintId={blueprintId}
      initialUse={location.state.useBlueprint}
      onBack={() => navigate({ to: '/library', search: { tab: 'blueprints' } })}
      onMade={({ workspaceId, gadgetId, app }) => navigate(itemPage(workspaceId, { kind: 'output', workpieceId: gadgetId }, app))}
      onOpenWorkspace={(workspaceId) => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } })}
      link={new URL(router.buildLocation({ to: '/blueprints/$blueprintId', params: { blueprintId } }).href, window.location.origin).href}
    />
  )
}
