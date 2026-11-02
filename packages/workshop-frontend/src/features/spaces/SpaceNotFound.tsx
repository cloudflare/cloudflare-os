import {
  DefaultGlobalNotFound,
  rootRouteId,
  useRouter,
  type NotFoundRouteComponent,
} from '@tanstack/react-router'

/**
 * What a /spaces route shows when there is nothing at its address for this user: what the app
 * shows at a URL no route matches, which is the root route's not-found component, else the
 * router's default one, else the router's built-in. One answer covers every reason (the `spaces`
 * flag is off, the key is malformed, the space refused the user, the slug addresses nothing), so
 * the page does not say which it was, as the space's own refusal does not.
 */
export const SpaceNotFound = () => {
  const router = useRouter()
  const NotFound: NotFoundRouteComponent = router.routesById[rootRouteId].options.notFoundComponent
    ?? router.options.defaultNotFoundComponent
    ?? DefaultGlobalNotFound
  return <NotFound isNotFound routeId={rootRouteId} />
}
