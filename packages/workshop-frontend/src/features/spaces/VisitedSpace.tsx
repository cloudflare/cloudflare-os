import { useState } from 'react'
import { WorkshopButton } from '../../components/WorkshopControls'
import { ListedWorkspaceRow } from './ListedWorkspaceRow'
import { takeLostFocus } from './lostFocus'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import type { SpaceListing } from './useSpaceListings'

/**
 * A space as a visitor sees it: someone signed in who is not a member of it, to whom it is open
 * while it lists a workspace published to everyone signed in (see `Space`). It shows the
 * space's name and those workspaces, each linking to its address, and nothing that is a
 * member's: no members, no new workspace, no change of address.
 *
 * Only published entries are shown, whatever the listing holds: one read while the user was
 * still a member has the space's other workspaces too.
 */
export const VisitedSpace = ({ spaceKey, label, listing, onListingReload }: {
  spaceKey: string
  /** What the space is called. */
  label: string
  /**
   * What the space lists, as last read. A refused one means the space is no longer open to the
   * user, which is the caller's to show in place of this.
   */
  listing: SpaceListing
  /** Reads what the space lists again, resolving once the read has settled either way. */
  onListingReload: () => Promise<void>
}) => {
  const [reloading, setReloading] = useState(false)
  const published = listing.status === 'ready'
    ? listing.workspaces.filter(workspace => workspace.published !== undefined)
    : []

  const reloadListing = async () => {
    setReloading(true)
    try {
      await onListingReload()
    } finally {
      setReloading(false)
    }
  }

  return (
    <>
      <header className="px-3 pb-3 pt-6 sm:pt-10">
        <h1
          ref={takeLostFocus}
          tabIndex={-1}
          className="truncate text-2xl font-semibold tracking-tight text-kumo-default"
        >
          {label}
        </h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          These are workspaces of this space that their owners have published to everyone signed in to this deployment.
        </p>
      </header>
      <div className="chat-panel flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pt-1">
        {published.map(workspace => (
          <ListedWorkspaceRow
            key={workspace.id}
            workspace={workspace}
            listing={{
              address: workspace.slug === undefined ? undefined : { spaceKey, slug: workspace.slug },
              onAddressChange: undefined,
            }}
          />
        ))}
        {listing.status === 'loading' && (
          <p role="status" className="px-3 py-2 text-[13px] leading-[18px] text-kumo-inactive">
            Loading this space’s workspaces…
          </p>
        )}
        {listing.status === 'failed' && (
          <div role="alert" className="flex items-center gap-3 px-3 py-2">
            <p className="text-[13px] leading-[18px] text-kumo-danger">
              Couldn’t load this space’s workspaces.
            </p>
            <WorkshopButton
              className={SPACE_ACTION_CLASS_NAME}
              loading={reloading}
              onClick={() => void reloadListing()}
            >
              Try again
            </WorkshopButton>
          </div>
        )}
      </div>
    </>
  )
}
