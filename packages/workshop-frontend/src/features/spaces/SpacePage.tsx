import { useEffect, useEffectEvent, useId, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { GadgetMetadataWithTimestamps, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import GadgetList, { type GadgetListRows } from '../../components/GadgetList'
import { WorkshopButton } from '../../components/WorkshopControls'
import { useDocumentTitle } from '../../useDocumentTitle'
import { matchingRows, spaceRows, type WorkspaceRow } from './groupWorkspaces'
import { takeLostFocus } from './lostFocus'
import { SPACE_ACTION_CLASS_NAME, SpaceEntryPoints } from './SpaceEntryPoints'
import { isOwnPersonalSpace, spaceLabel } from './spaceKinds'
import { SpaceMembersDialog } from './SpaceMembersDialog'
import { SpaceNotFound } from './SpaceNotFound'
import { SPACE_ROLE_LABELS } from './spaceRoles'
import { SpaceSectionRows } from './SpaceSectionRows'
import { SpaceSyncStatus } from './sync/SpaceSyncStatus'
import { StartSpaceSyncDialog } from './sync/StartSpaceSyncDialog'
import { useSpaceSync } from './sync/useSpaceSync'
import { syncSourceName } from './sync/useSpaceSyncAccounts'
import { SpaceTreeLayout } from './tree/SpaceTreeLayout'
import { useSelectedWorkspaceId } from './tree/useSelectedWorkspace'
import { SpaceViewToggle } from './tree/SpaceViewToggle'
import { useSpaceViewMode } from './tree/useSpaceViewMode'
import { useSpace } from './useSpace'
import { asMemberListing, useSpaceListings, type SpaceListing } from './useSpaceListings'
import { useLastKnown, type Spaces } from './useSpaces'
import { VisitedSpace } from './VisitedSpace'
import { WorkspaceAddressDialog } from './WorkspaceAddressDialog'

const LISTING_LOADING: SpaceListing = { status: 'loading' }

const UNLISTED_DESCRIPTION = 'Yours, and grouped here, but not listed by the space: its other members do not see them.'

// A workspace of the user's own that the listing has no entry for. Only the user's own are placed
// without one (see `spaceRows`).
const isUnlisted = (row: WorkspaceRow): row is Extract<WorkspaceRow, { kind: 'record' }> =>
  row.kind === 'record' && !row.entry

// The rows of the user's own workspaces that the space does not list, under a heading that says
// so, as the workspaces page's 'In other spaces' section says what it holds.
const UnlistedWorkspaces = ({ children }: { children: ReactNode }) => {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex shrink-0 flex-col gap-0.5 pt-3">
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-3">
        <h2
          id={headingId}
          className="text-[13px] leading-[18px] font-semibold tracking-[-0.25px] text-kumo-default"
        >
          Not listed by this space
        </h2>
        <p className="text-[12px] leading-4 text-kumo-subtle">
          Your workspaces here that the space does not list. Its other members do not see them and
          cannot open them through the space.
        </p>
      </div>
      {children}
    </section>
  )
}

/**
 * A space's own page: its name, the user's role in it, the entry points to a team space's
 * members and to a new workspace in it, and its workspaces. The workspaces are the rows the
 * space's section of the workspaces page has (see `spaceRows`), each linking to its address in
 * the space once it has one, and the rows of the entries the user may change the address of
 * offer that.
 *
 * Those rows place the user's own workspaces by the user's records, so one may be here that the
 * space does not list: one it never lists, or one whose registration it has not seen. Once the
 * listing has been read these are shown apart and said to be so, since no other member sees
 * them here.
 *
 * A member may switch the workspaces to the space's tree beside a preview of the one selected
 * (`SpaceTreeLayout`), a choice remembered for the user. The user's own workspaces the space does
 * not list are shown apart under the tree there too.
 *
 * A member with a connected account that can sync a source into the space is offered that
 * beside the space's name (`StartSpaceSyncDialog`), under the entry selected in the tree unless
 * they choose another. Their syncs into the space show their progress under the header, and the
 * space's workspaces are read again whenever one of them ends.
 *
 * A user who is not a member of the space is a visitor, to whom the space is open while it
 * lists a workspace published to everyone signed in: they get its name and those workspaces
 * (see `VisitedSpace`), and none of the above.
 *
 * A space that refuses the user is shown as nothing being there, which is also all the space
 * says of a key no space has claimed.
 */
export const SpacePage = ({ spaceKey, spaces }: {
  /** A well-formed space key (`isValidSpaceKey`). */
  spaceKey: string
  /** The user's spaces (`useSpaces`), with the `spaces` flag on. */
  spaces: Spaces
}) => {
  const { currentUser } = useAuthenticatedApi()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { state, refresh } = useSpace(spaceKey)
  const { listings, reload } = useSpaceListings([spaceKey])
  // Both dialogs are held here and not with what they were opened from: the header goes when
  // the space cannot be read and the rows while the list loads again, and an open dialog
  // outlasts that.
  const [membersOpen, setMembersOpen] = useState(false)
  const [addressOf, setAddressOf] = useState<SpaceWorkspaceInfo | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [viewMode, setViewMode] = useSpaceViewMode()
  const selectedId = useSelectedWorkspaceId()

  // The space as last read, while a read of it is under way: a session that replaces another (a
  // reconnect) has read nothing yet, and the header and the list stay up through that, with what
  // the user has typed into the list and opened from it.
  const info = useLastKnown(state.status === 'ready' ? state.info : null, state.status !== 'loading')
  const label = info ? spaceLabel(info) : null
  const role = info?.role
  const listing = listings[spaceKey] ?? LISTING_LOADING
  // What the member's view below shows: the role in the header is the one the space last gave,
  // and a listing read since as a visitor's says it no longer does.
  const memberListing = asMemberListing(listing)
  useDocumentTitle(label)

  // Any member may add workspaces to a team space, and only its owner to a personal space.
  const canAddWorkspaces = info !== null
    && (info.kind === 'team' ? info.role !== undefined : isOwnPersonalSpace(info))
  const sync = useSpaceSync(spaceKey, canAddWorkspaces)
  const reloadForSync = useEffectEvent(() => void reload(spaceKey))
  useEffect(() => {
    if (sync.endedKey !== '') reloadForSync()
  }, [sync.endedKey])

  if (state.status === 'refused') return <SpaceNotFound />
  // The space stopped listing anything published after it answered a visitor with its info: it
  // is no longer open to them.
  if (info && role === undefined && listing.status === 'refused') return <SpaceNotFound />

  const retry = async () => {
    setRetrying(true)
    try {
      await refresh()
    } finally {
      setRetrying(false)
    }
  }

  // The dialog may have changed the user's role in the space.
  const closeMembers = () => {
    setMembersOpen(false)
    void refresh()
    void spaces.refresh()
  }

  // The space refuses a user who has left it, so there is nothing of this page to go back to:
  // the workspaces page takes its place, and a toast says what happened.
  const handleLeft = () => {
    setMembersOpen(false)
    if (label) toasts.add({ title: `You left ${label}`, variant: 'success' })
    void spaces.refresh()
    void navigate({ to: '/workspaces', replace: true })
  }

  // The user's own workspaces grouped in this space that it does not list, once it has been read.
  // A record names only a team space; the user's own personal space is where it names none.
  const isUnlistedHere = (record: GadgetMetadataWithTimestamps) =>
    memberListing.status === 'ready'
    && record.spaceKey === (info && isOwnPersonalSpace(info) ? undefined : spaceKey)
    && !memberListing.workspaces.some(entry => entry.id === record.id)

  const handleAddressChanged = () => {
    setAddressOf(null)
    void reload(spaceKey)
  }

  return (
    <div className={`mx-auto flex w-full flex-col px-3 sm:px-10 ${viewMode === 'tree' ? 'min-h-full md:h-full' : 'h-full max-w-4xl'}`}>
      {state.status === 'loading' && !info && (
        <div role="status" aria-label="Loading the space" className="flex flex-col gap-0.5 pt-10">
          {[1, 2, 3].map(row => (
            <div key={row} className="h-[56px] animate-pulse rounded-xl bg-kumo-elevated" />
          ))}
        </div>
      )}
      {state.status === 'failed' && (
        <div role="alert" className="flex items-center gap-3 px-3 pt-10">
          <p className="text-[13px] leading-[18px] text-kumo-danger">Couldn’t load this space.</p>
          <WorkshopButton
            className={SPACE_ACTION_CLASS_NAME}
            loading={retrying}
            onClick={() => void retry()}
          >
            Try again
          </WorkshopButton>
        </div>
      )}
      {info && label && role === undefined && (
        <VisitedSpace
          space={{ key: spaceKey, kind: info.kind }}
          label={label}
          listing={listing}
          onListingReload={() => reload(spaceKey)}
        />
      )}
      {info && label && role !== undefined && (
        <>
          <header className="flex flex-col items-stretch gap-4 px-3 pb-3 pt-6 sm:flex-row sm:items-end sm:justify-between sm:pt-10">
            <div className="min-w-0">
              {/* The heading takes the focus of a user who arrives with none: the button that
                  led here, in a dialog or on a page that is gone, could not keep it. */}
              <h1
                ref={takeLostFocus}
                tabIndex={-1}
                className="truncate text-2xl font-semibold tracking-tight text-kumo-default"
              >
                {label}
              </h1>
              <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
                Your role: {SPACE_ROLE_LABELS[role]}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <SpaceViewToggle mode={viewMode} onModeChange={setViewMode} />
              <SpaceEntryPoints
                label={label}
                space={info}
                onMembersOpen={() => setMembersOpen(true)}
                sync={sync.accounts.length > 0
                  ? { sourceName: syncSourceName(sync.accounts), onOpen: () => setSyncOpen(true) }
                  : undefined}
              />
            </div>
          </header>
          <SpaceSyncStatus sync={sync} className="px-3 pb-3" />
          {viewMode === 'tree' ? (
            <div className="flex-1 px-3 pb-6 md:min-h-0">
              <SpaceTreeLayout
                space={{ key: spaceKey, kind: info.kind, label }}
                role={role}
                listing={memberListing}
                onListingReload={() => reload(spaceKey)}
                unlisted={{ includes: isUnlistedHere, description: UNLISTED_DESCRIPTION }}
                sync={sync}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <GadgetList
                showHeader={false}
                sections={{
                  spaces: spaces.spaces,
                  render: ({ gadgets, search, renderRow }: GadgetListRows) => {
                    const rows = matchingRows(spaceRows({
                      gadgets,
                      space: info,
                      workspaces: memberListing.status === 'ready' ? memberListing.workspaces : [],
                      userId: currentUser?.id,
                    }), search)
                    if (search !== '' && rows.length === 0) {
                      return <div className="py-12 text-center text-sm text-kumo-inactive">No workspaces found</div>
                    }
                    const read = memberListing.status === 'ready'
                    const unlisted = read ? rows.filter(isUnlisted) : []
                    const listed = read ? rows.filter(row => !isUnlisted(row)) : rows
                    return (
                      <>
                        {/* A space whose only rows are unlisted ones is not said to have none. */}
                        {(listed.length > 0 || unlisted.length === 0) && (
                          <SpaceSectionRows
                            section={{ kind: 'space', space: info, listing: memberListing.status, rows: listed }}
                            label={label}
                            renderRow={renderRow}
                            onListingReload={reload}
                            onAddressChange={setAddressOf}
                          />
                        )}
                        {unlisted.length > 0 && (
                          <UnlistedWorkspaces>
                            {unlisted.map(row => renderRow(row.gadget))}
                          </UnlistedWorkspaces>
                        )}
                      </>
                    )
                  },
                }}
              />
            </div>
          )}
        </>
      )}
      {membersOpen && (
        <SpaceMembersDialog spaceKey={spaceKey} onClose={closeMembers} onLeft={handleLeft} />
      )}
      {syncOpen && label && (
        <StartSpaceSyncDialog
          space={{ key: spaceKey, name: label }}
          listing={memberListing.status === 'ready' ? memberListing.workspaces : []}
          accounts={sync.accounts}
          defaultParentId={viewMode === 'tree' ? selectedId : undefined}
          syncRunning={sync.jobs.running !== undefined}
          onClose={() => setSyncOpen(false)}
          onStarted={(job) => {
            setSyncOpen(false)
            sync.follow(job)
          }}
        />
      )}
      {addressOf && (
        <WorkspaceAddressDialog
          spaceKey={spaceKey}
          workspace={addressOf}
          onClose={() => setAddressOf(null)}
          onChanged={handleAddressChanged}
        />
      )}
    </div>
  )
}
