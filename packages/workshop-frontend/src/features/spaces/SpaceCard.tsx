import { useId, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { LayerCard } from '@cloudflare/kumo'
import { FolderSimple, GearSix, UsersThree } from '@phosphor-icons/react'
import type { SubspaceInfo } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from '../../components/WorkshopControls'
import { BusyButton } from './BusyButton'
import type { WorkspaceSection } from './groupWorkspaces'
import { takeLostFocus, useFocusAfterAction } from './lostFocus'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import { spaceLabel } from './spaceKinds'
import { SPACE_ROLE_LABELS } from './spaceRoles'

/** The grid the cards of spaces are laid out in: as many columns as the room they have fits. */
export const SPACE_CARD_GRID_CLASS_NAME = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-2 px-3'

type ListedSpaceSection = Extract<WorkspaceSection, { kind: 'space' }>

type SpaceCardProps = {
  /** The user asked for the members of the space with this id. */
  onMembersOpen: (spaceId: string) => void
} & (
  | {
      /** A space of the user's own list, with how far the read of what it lists got. */
      section: ListedSpaceSection
      /** Reads what the space lists again, resolving once the read has settled either way. */
      onListingReload: (spaceId: string) => Promise<void>
    }
  | {
      /** A sub-space, shown in the space it is inside. Its id and name are all that is read of it. */
      subspace: SubspaceInfo
    }
)

const workspaceCount = (count: number) => {
  if (count === 0) return 'No workspaces yet'
  return count === 1 ? '1 workspace' : `${count} workspaces`
}

// What the card of a space of the user's list says under the space's name. The role is the one
// the space reported with its listing (see `groupWorkspaces`): the list of spaces has the role
// given in the space itself, which the role held may exceed, so nothing is said of a role
// before that read. The count is of the section's rows: what the space lists and the user's own
// workspaces in it, whether or not it lists those. It waits for the listing too: until that has
// been read, the rows are only the user's own workspaces.
const details = ({ space, listing, rows }: ListedSpaceSection) => {
  switch (listing) {
    case 'refused': return 'You are no longer a member of this space.'
    case 'failed': return 'Couldn’t load its workspaces'
    case 'ready': return `Your role: ${SPACE_ROLE_LABELS[space.role]} · ${workspaceCount(rows.length)}`
    case 'loading': return null
  }
}

/**
 * A space as one card, wherever a space is shown as a card: its name, as a link to the space's
 * own page, and beside the link, not in it, since nothing interactive may be nested in a link,
 * a button that opens its members.
 *
 * A space of the user's own list also says the role the space reports for them and how many
 * workspaces it shows them, or that those could not be read, with a way to read them again.
 * A sub-space shown inside its parent says its name alone: every member of the parent is a
 * member of it, and nothing more is read to show its card.
 */
export const SpaceCard = (props: SpaceCardProps) => {
  const nameId = useId()
  const detailsId = useId()
  const linkRef = useRef<HTMLAnchorElement>(null)
  const [reloading, setReloading] = useState(false)
  // `Try again` goes once the listing has been read, and the card's link takes the focus it had.
  const reloadSettled = useFocusAfterAction(() => takeLostFocus(linkRef.current))
  const listed = 'section' in props ? props : null
  const id = 'section' in props ? props.section.space.id : props.subspace.id
  const label = 'section' in props ? spaceLabel(props.section.space) : props.subspace.name
  const listing = listed?.section.listing
  const announced = listing === 'failed' || listing === 'refused'
  const Icon = listed ? UsersThree : FolderSimple

  const reload = async () => {
    setReloading(true)
    try {
      await listed?.onListingReload(id)
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
        params={{ spaceId: id }}
        aria-labelledby={nameId}
        aria-describedby={listed ? detailsId : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring"
      >
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle"
        >
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          {/* Cut short when it does not fit: the link's name carries it whole. */}
          <span id={nameId} className="block truncate text-[14px] font-medium text-kumo-default">
            {label}
          </span>
          {/* Never cut, and keyed by whether it is an alert: an alert that is inserted is
              announced, and a role given to an element already there may not be. It keeps a
              line's height while it says nothing, so the card does not grow when the listing
              has been read. */}
          {listed && (
            <span
              key={announced ? listing : 'details'}
              id={detailsId}
              role={announced ? 'alert' : undefined}
              className="block min-h-4 break-words text-[12px] leading-4 text-kumo-subtle"
            >
              {details(listed.section)}
            </span>
          )}
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
      <WorkshopIconButton aria-label={`Members of ${label}`} onClick={() => props.onMembersOpen(id)}>
        <GearSix size={16} aria-hidden="true" />
      </WorkshopIconButton>
    </LayerCard>
  )
}
