import { createFileRoute } from '@tanstack/react-router'
import { useUiFeatureFlag } from '../FeatureFlagsContext'
import { couldBeSpaceId } from '../features/spaces/spaceIds'
import { SpaceNotFound } from '../features/spaces/SpaceNotFound'
import { useSpaces } from '../features/spaces/useSpaces'
import { SpacePage } from '../pages/space/SpacePage'

/**
 * A space's own page, behind the `spaces` flag. The route is as if it did not exist when the
 * flag is off, when the id in the URL cannot be a space id, and when the server refuses the id.
 * In the first two cases it asks the server about no space.
 */
const SpaceRoute = () => {
  const { spaceId } = Route.useParams()
  // A string of another shape names no space: nothing is asked about it, the list of the user's
  // spaces included, which every mount of `useSpaces` reads.
  if (!couldBeSpaceId(spaceId)) return <SpaceNotFound />
  return <SpaceOfRoute spaceId={spaceId} />
}

// The space of an id of the right shape, behind the flag.
const SpaceOfRoute = ({ spaceId }: { spaceId: string }) => {
  const flag = useUiFeatureFlag('spaces')
  const spaces = useSpaces()
  // `spaces.enabled` is the flag as last known, so the page stays up through a session that has
  // not been told its flags yet. With none known at all the route shows nothing until one is.
  if (!spaces.enabled) return flag.loading ? null : <SpaceNotFound />
  return <SpacePage key={spaceId} spaceId={spaceId} spaces={spaces} />
}

export const Route = createFileRoute('/spaces/$spaceId')({
  component: SpaceRoute,
})
