import { createFileRoute } from '@tanstack/react-router'
import GatekeeperAppPage from '../GatekeeperAppPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { useGatekeeperApps } from '../useGatekeeperApps'

/**
 * Generic host for any gatekeeper-served management app (VendorDescription.providesUi). The set of
 * apps and their nav entries come from the backend (useGatekeeperApps); nothing about a specific
 * gatekeeper is hardcoded here. GatekeeperAppPage renders "not available" if the id isn't bound.
 *
 * The file is `gatekeepers_.$appId.$` (trailing underscore) so the URL is /gatekeepers/$appId
 * without nesting inside the /gatekeepers connectors page's component.
 *
 * Anything after the app id is the app's own path, the splat, which may be empty. Changing it keeps
 * this match (and the app's iframe) mounted, since TanStack doesn't remount on param changes.
 */
export const Route = createFileRoute('/gatekeepers_/$appId/$')({
  component: GatekeeperApp,
})

function GatekeeperApp() {
  const { appId, _splat } = Route.useParams()
  const app = useGatekeeperApps().find((a) => a.id === appId)
  useDocumentTitle(app?.title ?? 'App')
  // A trailing slash names the same place; keep apps from seeing an empty last segment.
  const path = `/${(_splat ?? '').replace(/\/+$/, '')}`
  return <GatekeeperAppPage appId={appId} path={path} />
}
