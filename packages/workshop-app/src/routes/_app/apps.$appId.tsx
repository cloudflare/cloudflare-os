import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { formatAsideRef } from '@/aside/asideItems'
import { GatekeeperAppPane } from '@/gatekeeperApps/GatekeeperAppPane'
import { useGatekeeperApps } from '@/gatekeeperApps/GatekeeperAppsContext'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useNarrowScreen } from '@gadgets/ui'

/**
 * A gatekeeper's management app (`listGatekeeperApps()`), by its gatekeeper's id: whichever the
 * backend lists, as the sidebar does, none of them known here.
 */
export const Route = createFileRoute('/_app/apps/$appId')({
  component: GatekeeperApp,
})

function GatekeeperApp() {
  const { appId } = Route.useParams()
  const navigate = useNavigate()
  const narrow = useNarrowScreen()
  const title = useGatekeeperApps().find(({ id }) => id === appId)?.title
  useDocumentTitle(title)
  return (
    // On a narrow screen, under the button that brings out the sidebar, which the app's own page
    // knows nothing of to leave room for.
    <div className={narrow ? 'flex min-h-0 flex-1 flex-col pt-16' : 'flex min-h-0 flex-1 flex-col'}>
      {/* Keyed, so that another app starts afresh. */}
      <GatekeeperAppPane
        key={appId}
        gatekeeperId={appId}
        title={title}
        onOpenWorkspace={({ workspaceId, gadgetId }) =>
          void navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { open: gadgetId === undefined ? undefined : formatAsideRef({ kind: 'output', workpieceId: gadgetId }) } })}
        onOpenPrompt={(prompt) => void navigate({ to: '/', state: { draft: prompt } })}
      />
    </div>
  )
}
