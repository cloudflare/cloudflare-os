import { useId, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { LayerCard } from '@cloudflare/kumo'
import { GearSix, UsersThree } from '@phosphor-icons/react'
import { WorkshopIconButton } from '../../components/WorkshopControls'
import { BusyButton } from './BusyButton'
import type { WorkspaceSection } from './groupWorkspaces'
import { takeLostFocus, useFocusAfterAction } from './lostFocus'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import { spaceLabel } from './spaceKinds'
import { SPACE_ROLE_LABELS } from './spaceRoles'

type TeamSpaceSection = Extract<WorkspaceSection, { kind: 'space' }>

const workspaceCount = (count: number) => {
  if (count === 0) return 'No workspaces yet'
  return count === 1 ? '1 workspace' : `${count} workspaces`
}

// What the card says under the space's name. The count is of the section's rows (see
// `groupWorkspaces`): what the space lists and the user's own workspaces in it, whether or not
// it lists those. It waits for the space's listing: until that has been read, the rows are only
// the user's own workspaces.
const details = ({ space, listing, rows }: TeamSpaceSection) => {
  const role = `Your role: ${SPACE_ROLE_LABELS[space.role]}`
  switch (listing) {
    case 'refused': return 'You are no longer a member of this space.'
    case 'failed': return `${role} · Couldn’t load its workspaces`
    case 'ready': return `${role} · ${workspaceCount(rows.length)}`
    case 'loading': return role
  }
}

/**
 * A team space the user is a member of as one card of the workspaces page: its name, the user's
 * role in it and how many workspaces it shows them, or that they could not be read. The card
 * links to the space's own page, where its workspaces are listed and created. Beside the link,
 * and not in it, since nothing interactive may be nested in a link, it opens the space's
 * members and reads its listing again when that could not be read.
 */
export const TeamSpaceCard = ({ section, onMembersOpen, onListingReload }: {
  section: TeamSpaceSection
  /** The user asked for the members of the space with this id. */
  onMembersOpen: (spaceId: string) => void
  /** Reads what the space lists again, resolving once the read has settled either way. */
  onListingReload: (spaceId: string) => Promise<void>
}) => {
  const nameId = useId()
  const detailsId = useId()
  const linkRef = useRef<HTMLAnchorElement>(null)
  const [reloading, setReloading] = useState(false)
  // `Try again` goes once the listing has been read, and the card's link takes the focus it had.
  const reloadSettled = useFocusAfterAction(() => takeLostFocus(linkRef.current))
  const { space, listing } = section
  const label = spaceLabel(space)
  const announced = listing === 'failed' || listing === 'refused'

  const reload = async () => {
    setReloading(true)
    try {
      await onListingReload(space.id)
    } finally {
      setReloading(false)
      reloadSettled()
    }
  }

  return (
    <LayerCard
      render={<li />}
      className="flex items-center gap-1 pr-2 transition-colors duration-150 ease-out hover:bg-kumo-tint"
    >
      {/* The card hides what overflows it, so the link's focus ring is drawn inside the link. */}
      <Link
        ref={linkRef}
        to="/spaces/$spaceId"
        params={{ spaceId: space.id }}
        aria-labelledby={nameId}
        aria-describedby={detailsId}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring"
      >
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle"
        >
          <UsersThree size={16} />
        </span>
        <span className="min-w-0 flex-1">
          {/* Cut short when it does not fit: the link's name carries it whole. */}
          <span id={nameId} className="block truncate text-[14px] font-medium text-kumo-default">
            {label}
          </span>
          {/* Never cut, and keyed by whether it is an alert: an alert that is inserted is
              announced, and a role given to an element already there may not be. */}
          <span
            key={announced ? listing : 'details'}
            id={detailsId}
            role={announced ? 'alert' : undefined}
            className="block break-words text-[12px] leading-4 text-kumo-subtle"
          >
            {details(section)}
          </span>
        </span>
      </Link>
      {listing === 'failed' && (
        <BusyButton
          className={`shrink-0 ${SPACE_ACTION_CLASS_NAME}`}
          aria-label={`Try again to load ${label}`}
          busy={reloading}
          onClick={() => void reload()}
        >
          Try again
        </BusyButton>
      )}
      <WorkshopIconButton aria-label={`Members of ${label}`} onClick={() => onMembersOpen(space.id)}>
        <GearSix size={16} aria-hidden="true" />
      </WorkshopIconButton>
    </LayerCard>
  )
}
