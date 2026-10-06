import { createFileRoute } from '@tanstack/react-router'
import GatekeeperAppPage from '../GatekeeperAppPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { useGatekeeperApps } from '../useGatekeeperApps'
import { useT, localizeGatekeeperAppTitle } from '../i18n'

/**
 * Generic host for any gatekeeper-served management app (VendorDescription.providesUi). The set of
 * apps and their nav entries come from the backend (useGatekeeperApps); nothing about a specific
 * gatekeeper is hardcoded here. GatekeeperAppPage renders "not available" if the id isn't bound.
 *
 * The file is `gatekeepers_.$appId` (trailing underscore) so the URL is /gatekeepers/$appId without
 * nesting inside the /gatekeepers connectors page's component.
 */
export const Route = createFileRoute('/gatekeepers_/$appId')({
  component: GatekeeperApp,
})

function GatekeeperApp() {
  const t = useT()
  const { appId } = Route.useParams()
  const app = useGatekeeperApps().find((a) => a.id === appId)
  const title = app ? localizeGatekeeperAppTitle(t, app) : t('gatekeepersPage.appTitle')
  useDocumentTitle(title)
  return <GatekeeperAppPage appId={appId} />
}
