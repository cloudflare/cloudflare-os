import { useEffect, useEffectEvent, useState } from 'react'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { SyncFromSourceButton } from '../SpaceEntryPoints'
import { isOwnPersonalSpace, spaceLabel } from '../spaceKinds'
import { SpaceSyncStatus } from '../sync/SpaceSyncStatus'
import { StartSpaceSyncDialog } from '../sync/StartSpaceSyncDialog'
import { useSpaceSync } from '../sync/useSpaceSync'
import { syncSourceName } from '../sync/useSpaceSyncAccounts'
import { useSpaceListings, type SpaceListing } from '../useSpaceListings'
import type { Spaces } from '../useSpaces'
import { SpaceTreeLayout } from './SpaceTreeLayout'
import { useSelectedWorkspaceId } from './useSelectedWorkspace'

const LOADING: SpaceListing = { status: 'loading' }
const FAILED: SpaceListing = { status: 'failed' }

const UNLISTED_DESCRIPTION = 'Yours, and in no space you can see: holding restricted data, shared only by you, '
  + 'not listed by their space yet, or in a space you have left.'

/**
 * The user's personal space as its tree beside a preview (see `SpaceTreeLayout`), with the user's
 * own workspaces that no listing they can see shows apart under it, whichever space they are
 * grouped in: one holding restricted data or that only its owner may share, which no space
 * lists; one whose registration its space has not seen yet; and one in a team space the user is
 * no longer a member of. Each of the user's spaces is read for this, and the user's own records
 * (`listGadgets`) say where each workspace is grouped.
 *
 * A user with a connected account that can sync a source into a space is offered a sync into
 * their personal space above the tree (`StartSpaceSyncDialog`), under the entry selected in it
 * unless they choose another, and their syncs into it show their progress there. The personal
 * space's listing is read again whenever one of them ends.
 */
export const PersonalTree = ({ spaces }: {
  /** The user's spaces (`useSpaces`), with the `spaces` flag on. */
  spaces: Spaces
}) => {
  const personal = spaces.spaces.find(isOwnPersonalSpace)
  const { listings, reload } = useSpaceListings(spaces.spaces.map(space => space.key))
  const selectedId = useSelectedWorkspaceId()
  const [syncOpen, setSyncOpen] = useState(false)
  // Nothing is offered, and no job read, before the list of spaces has the personal space.
  const sync = useSpaceSync(personal?.key, true)
  const reloadForSync = useEffectEvent(() => {
    if (personal) void reload(personal.key)
  })
  useEffect(() => {
    if (sync.endedKey !== '') reloadForSync()
  }, [sync.endedKey])

  // Until the list of spaces has it, the personal space's listing is as far off as that list.
  const listing = personal
    ? listings[personal.key] ?? LOADING
    : spaces.failed ? FAILED : LOADING

  // Only a listing that has been read can be said not to show a workspace, and only a list of
  // spaces that has been read can say the user is not in one.
  const isUnlisted = (record: GadgetMetadataWithTimestamps) => {
    const spaceKey = record.spaceKey ?? personal?.key
    if (spaceKey === undefined) return false
    const grouped = listings[spaceKey]
    if (!grouped) return !spaces.loading && !spaces.failed && !spaces.spaces.some(space => space.key === spaceKey)
    if (grouped.status === 'refused') return true
    return grouped.status === 'ready' && !grouped.workspaces.some(entry => entry.id === record.id)
  }

  // A change made from the tree can make any of the user's spaces list a workspace shown apart.
  const reloadListing = async () => {
    if (!personal) return spaces.refresh()
    await Promise.all(spaces.spaces.map(space => reload(space.key)))
  }

  const label = personal ? spaceLabel(personal) : 'Personal'
  const offered = personal !== undefined && sync.accounts.length > 0

  // Side by side, the layout fills what is left of the page's height below the syncs. Its place
  // stays the same whether a sync is offered or not, so that it is not mounted afresh when an
  // account arrives.
  return (
    <div className="flex flex-col gap-3 md:h-full">
      {offered && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SyncFromSourceButton
            label={label}
            sourceName={syncSourceName(sync.accounts)}
            onOpen={() => setSyncOpen(true)}
          />
        </div>
      )}
      <SpaceSyncStatus sync={sync} />
      <div className="md:min-h-0 md:flex-1">
        <SpaceTreeLayout
          // Nothing is done with the key before the listing is read, which needs the space.
          space={{ key: personal?.key ?? '', kind: 'personal', label }}
          role={personal?.role}
          listing={listing}
          onListingReload={reloadListing}
          unlisted={{ includes: isUnlisted, description: UNLISTED_DESCRIPTION }}
          sync={sync}
        />
      </div>
      {personal && syncOpen && (
        <StartSpaceSyncDialog
          space={{ key: personal.key, name: label }}
          listing={listing.status === 'ready' ? listing.workspaces : []}
          accounts={sync.accounts}
          defaultParentId={selectedId}
          syncRunning={sync.jobs.running !== undefined}
          onClose={() => setSyncOpen(false)}
          onStarted={(job) => {
            setSyncOpen(false)
            sync.follow(job)
          }}
        />
      )}
    </div>
  )
}
