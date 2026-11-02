import { createFileRoute } from '@tanstack/react-router'
import { isValidSpaceKey } from '@gadgets/workshop-shared/api'
import { useUiFeatureFlag } from '../FeatureFlagsContext'
import { SpaceNotFound } from '../features/spaces/SpaceNotFound'
import { SpacePage } from '../features/spaces/SpacePage'
import { useSpaces } from '../features/spaces/useSpaces'

/**
 * A space's own page, behind the `spaces` flag. With the flag off, and for a key that cannot
 * name a space, the route is as if it did not exist, and asks the server about no space.
 */
const SpaceRoute = () => {
  const { spaceKey } = Route.useParams()
  const flag = useUiFeatureFlag('spaces')
  const spaces = useSpaces()
  // `spaces.enabled` is the flag as last known, so the page stays up through a session that has
  // not been told its flags yet. With none known at all the route shows nothing until one is.
  if (!spaces.enabled) return flag.loading ? null : <SpaceNotFound />
  if (!isValidSpaceKey(spaceKey)) return <SpaceNotFound />
  return <SpacePage key={spaceKey} spaceKey={spaceKey} spaces={spaces} />
}

export const Route = createFileRoute('/spaces/$spaceKey')({
  component: SpaceRoute,
})
