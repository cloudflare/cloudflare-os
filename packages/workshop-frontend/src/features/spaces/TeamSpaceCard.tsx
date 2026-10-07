import { useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { LayerCard } from '@cloudflare/kumo'
import { GearSix, UsersThree } from '@phosphor-icons/react'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import type { WorkspaceSection } from './groupWorkspaces'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import { spaceLabel } from './spaceKinds'
import { SPACE_ROLE_LABELS } from './spaceRoles'

const workspaceCount = (count: number) => {
  if (count === 0) return 'No workspaces yet'
  return count === 1 ? '1 workspace' : `${count} workspaces`
}

// What the card says under the space's name. The count waits for the space's listing: until it
// has been read, the rows are only the user's own workspaces.
const details = ({ space, listing, rows }: Extract<WorkspaceSection, { kind: 'space' }>) => {
  if (listing === 'refused') return 'You are no longer a member of this space.'
  const role = space.role === undefined ? undefined : `Your role: ${SPACE_ROLE_LABELS[space.role]}`
  const count = listing === 'ready'
    ? workspaceCount(rows.length)
    : listing === 'failed' ? 'Couldn’t load its workspaces' : undefined
  return [role, count].filter(part => part !== undefined).join(' · ')
}

/**
 * A team space the user is a member of as one card of the workspaces page: its name, the user's
 * role in it and how many workspaces it shows them, or that they could not be read. The card links
 * to the space's own page, where its workspaces are listed and created. It also opens the space's
 * members, and reads its listing again when that could not be read, beside the link rather than
 * in it, since nothing interactive may be nested in a link.
 */
export const TeamSpaceCard = ({ section, onMembersOpen, onListingReload }: {
  section: Extract<WorkspaceSection, { kind: 'space' }>
  /** The user asked for the members of the space with this key. */
  onMembersOpen: (spaceKey: string) => void
  /** Reads what the space lists again, resolving once the read has settled either way. */
  onListingReload: (spaceKey: string) => Promise<void>
}) => {
  const nameId = useId()
  const detailsId = useId()
  const [reloading, setReloading] = useState(false)
  const { space } = section
  const label = spaceLabel(space)

  return (
    <LayerCard
      render={<li />}
      className="flex items-center gap-1 pr-2 transition-colors duration-150 ease-out hover:bg-kumo-tint"
    >
      <Link
        to="/spaces/$spaceKey"
        params={{ spaceKey: space.key }}
        aria-labelledby={nameId}
        aria-describedby={detailsId}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-brand"
      >
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle"
        >
          <UsersThree size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span id={nameId} className="block truncate text-[14px] font-medium text-kumo-default">
            {label}
          </span>
          <span id={detailsId} className="block truncate text-[12px] leading-4 text-kumo-subtle">
            {details(section)}
          </span>
        </span>
      </Link>
      {section.listing === 'failed' && (
        <WorkshopButton
          className={SPACE_ACTION_CLASS_NAME}
          aria-label={`Try again to load ${label}`}
          loading={reloading}
          onClick={() => {
            setReloading(true)
            void onListingReload(space.key).finally(() => setReloading(false))
          }}
        >
          Try again
        </WorkshopButton>
      )}
      <WorkshopIconButton
        aria-label={`Space settings for ${label}`}
        onClick={() => onMembersOpen(space.key)}
      >
        <GearSix size={16} aria-hidden="true" />
      </WorkshopIconButton>
    </LayerCard>
  )
}
