import type { Ref } from 'react'
import { Link } from '@tanstack/react-router'
import { User, UsersThree } from '@phosphor-icons/react'
import type { PublishedSpaceInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../../AuthContext'
import { spaceLabel } from '../spaceKinds'

/**
 * What kind of space it is, as a card names it. The directory gives no one a role, so the user's
 * own personal space is told apart by its owner.
 */
const kindLabel = (space: PublishedSpaceInfo, userId: string | undefined) => {
  if (space.kind === 'team') return 'Team space'
  return space.owner !== undefined && space.owner.id === userId
    ? 'Your personal space'
    : spaceLabel(space)
}

/** One space of the directory, linking to the space's own page. */
export const SpaceCard = ({ space, ref }: { space: PublishedSpaceInfo; ref?: Ref<HTMLAnchorElement> }) => {
  const { currentUser } = useAuthenticatedApi()
  const Icon = space.kind === 'team' ? UsersThree : User
  return (
    <Link
      ref={ref}
      to="/spaces/$spaceKey"
      params={{ spaceKey: space.key }}
      className="themed-card-hover-shadow flex items-center gap-3 rounded-xl border border-kumo-line bg-kumo-base px-4 py-4 transition-[border-color,box-shadow] duration-150 ease-out hover:border-kumo-fill focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
    >
      <span
        aria-hidden="true"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle"
      >
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-kumo-default">{space.name}</span>
        <span className="block truncate text-[12px] leading-4 text-kumo-subtle">
          {kindLabel(space, currentUser?.id)}
        </span>
      </span>
    </Link>
  )
}
