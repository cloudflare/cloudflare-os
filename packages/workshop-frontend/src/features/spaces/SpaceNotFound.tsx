import {
  DefaultGlobalNotFound,
  rootRouteId,
  useRouter,
  type NotFoundRouteComponent,
} from '@tanstack/react-router'

/**
 * What the /spaces/<id> route shows when it has no space to show this user: what the app shows
 * at a URL no route matches, which is the root route's not-found component, else the router's
 * default one, else the router's built-in. One answer covers every reason (the `spaces` flag is
 * off, the id is not one, the space refused the user), so the page does not say which it was,
 * as the space's own refusal does not.
 */
export const SpaceNotFound = () => {
  const router = useRouter()
  const NotFound: NotFoundRouteComponent = router.routesById[rootRouteId].options.notFoundComponent
    ?? router.options.defaultNotFoundComponent
    ?? DefaultGlobalNotFound
  return <NotFound isNotFound routeId={rootRouteId} />
}
