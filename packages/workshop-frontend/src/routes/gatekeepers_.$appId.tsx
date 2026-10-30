import { createFileRoute, useParams } from '@tanstack/react-router'
import GatekeeperAppPage from '../GatekeeperAppPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { useGatekeeperApps } from '../useGatekeeperApps'

/**
 * Generic host for any gatekeeper-served management app (VendorDescription.providesUi). The set of
 * apps and their nav entries come from the backend (useGatekeeperApps); nothing about a specific
 * gatekeeper is hardcoded here. GatekeeperAppPage renders "not available" if the id isn't bound.
 *
 * The file is `gatekeepers_.$appId` (trailing underscore) so the URL is /gatekeepers/$appId without
 * nesting inside the /gatekeepers connectors page's component.
 *
 * Anything after the app id is the app's own path, matched by the `$` child route, which renders
 * nothing. This route reads it instead, so moving between the app's paths keeps this match (and the
 * app's iframe) mounted.
 */
export const Route = createFileRoute('/gatekeepers_/$appId')({
  component: GatekeeperApp,
})

function GatekeeperApp() {
  const { appId } = Route.useParams()
  const splat = useParams({ strict: false, select: (params) => params._splat })
  const app = useGatekeeperApps().find((a) => a.id === appId)
  useDocumentTitle(app?.title ?? 'App')
  // A trailing slash names the same place; keep apps from seeing an empty last segment.
  const path = `/${(splat ?? '').replace(/\/+$/, '')}`
  return <GatekeeperAppPage appId={appId} path={path} />
}
