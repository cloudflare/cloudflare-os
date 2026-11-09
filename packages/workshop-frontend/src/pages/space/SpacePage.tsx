import { useEffect, useEffectEvent, useId, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../../AuthContext'
import GadgetList, { type GadgetListRows } from '../../components/GadgetList'
import { BusyButton } from '../../features/spaces/BusyButton'
import { matchingRows, spaceRows, type WorkspaceRow } from '../../features/spaces/groupWorkspaces'
import { takeLostFocus } from '../../features/spaces/lostFocus'
import { SPACE_ACTION_CLASS_NAME, SpaceEntryPoints } from '../../features/spaces/SpaceEntryPoints'
import { spaceLabel } from '../../features/spaces/spaceKinds'
import { SpaceListingStatus } from '../../features/spaces/SpaceListingStatus'
import { SpaceMembersDialog } from '../../features/spaces/SpaceMembersDialog'
import { SpaceNotFound } from '../../features/spaces/SpaceNotFound'
import { SPACE_ROLE_LABELS } from '../../features/spaces/spaceRoles'
import { SpaceSectionRows } from '../../features/spaces/SpaceSectionRows'
import { useSpace } from '../../features/spaces/useSpace'
import { useSpaceListings, type SpaceListing } from '../../features/spaces/useSpaceListings'
import { useLastKnown, type Spaces } from '../../features/spaces/useSpaces'
import { useDocumentTitle } from '../../useDocumentTitle'

const LISTING_LOADING: SpaceListing = { status: 'loading' }

// A workspace of the user's own that the listing has no entry for. Only the user's own are placed
// without one (see `spaceRows`).
const isUnlisted = (row: WorkspaceRow): row is Extract<WorkspaceRow, { kind: 'record' }> =>
  row.kind === 'record' && !row.entry

// The rows of the user's own workspaces that a team space does not list, under a heading that
// says so, as the workspaces page's 'In other spaces' section says what it holds.
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
 * A space's own page. For a team space: its name, the user's role in it, the entry points to its
 * members and to a new workspace in it, and its workspaces, which are the rows `spaceRows` gives.
 *
 * Those rows place the user's own workspaces by the user's records, so one may be here that the
 * space does not list yet: one whose registration it has not seen. Once the listing has been
 * read these are shown apart and said to be so, since no other member sees them here.
 *
 * A personal space is shown to nobody but its owner, who is its only member. Its page says so
 * where a team space's names a role, offers no members, and shows the user's own workspaces
 * that are in no team space all together: what the space lists is not read, since every entry
 * of it is one of those workspaces and there is nobody else for it to differ for.
 *
 * A space that refuses the user is shown as nothing being there, which is also all the space
 * says of an id that names no space.
 */
export const SpacePage = ({ spaceId, spaces }: {
  /** The space's id, as the route gave it: a string `couldBeSpaceId` accepts. */
  spaceId: string
  /** The user's spaces (`useSpaces`), with the `spaces` flag on. */
  spaces: Spaces
}) => {
  const { currentUser } = useAuthenticatedApi()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { state, refresh } = useSpace(spaceId)
  // Held here and not with the header it is opened from: the header goes when the space cannot
  // be read, and an open dialog outlasts that.
  const [membersOpen, setMembersOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)

  // The space as last read, while a read of it is under way: a session that replaces another (a
  // reconnect) has read nothing yet, and the header and the list stay up through that, with what
  // the user has typed into the list and opened from it.
  const info = useLastKnown(state.status === 'ready' ? state.info : null, state.status !== 'loading')
  const label = info ? spaceLabel(info) : null
  // The space's kind, from its info once read, and before that from the user's list of spaces.
  const kind = (info ?? spaces.spaces.find(space => space.id === spaceId))?.kind
  // Only a team space's listing is read, and so only once the space is known to be one.
  const { listings, reload } = useSpaceListings(kind === 'team' ? [spaceId] : [])
  const listing = listings[spaceId] ?? LISTING_LOADING
  useDocumentTitle(label)

  // A space that refuses to say what it lists has taken the user off its members since it was
  // read. It is read again, so that the page shows what it shows for a space that refuses them.
  // Once for each refusal, so a space that still answers for itself is not read in a loop.
  const listingRefused = listing.status === 'refused'
  const readSpaceAgain = useEffectEvent(() => {
    void refresh()
  })
  useEffect(() => {
    if (listingRefused) readSpaceAgain()
  }, [listingRefused])

  if (state.status === 'refused') return <SpaceNotFound />

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

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-3 sm:px-10">
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
          <BusyButton
            className={SPACE_ACTION_CLASS_NAME}
            busy={retrying}
            onClick={() => void retry()}
          >
            Try again
          </BusyButton>
        </div>
      )}
      {info && label && (
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
                {info.kind === 'personal'
                  ? 'Your personal space. Only you are in it.'
                  : `Your role: ${SPACE_ROLE_LABELS[info.role]}`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <SpaceEntryPoints label={label} space={info} onMembersOpen={() => setMembersOpen(true)} />
            </div>
          </header>
          <div className="min-h-0 flex-1">
            <GadgetList
              showHeader={false}
              sections={{
                spaces: spaces.spaces,
                render: ({ gadgets, search, renderRow, onFocusLost, emptyState }: GadgetListRows) => {
                  const rows = matchingRows(spaceRows({
                    gadgets,
                    space: info,
                    workspaces: listing.status === 'ready' ? listing.workspaces : [],
                    userId: currentUser?.id,
                  }), search)
                  const noMatch = search !== '' && rows.length === 0
                  const noneFound = (
                    <div className="py-12 text-center text-sm text-kumo-inactive">
                      {listing.status === 'failed'
                        ? 'No workspaces found, but the results may be incomplete.'
                        : 'No workspaces found'}
                    </div>
                  )
                  if (info.kind === 'personal') {
                    return noMatch ? noneFound : (
                      <>
                        <SpaceSectionRows
                          section={{ kind: 'personal', space: info, rows }}
                          renderRow={renderRow}
                        />
                        {rows.length === 0 && emptyState}
                      </>
                    )
                  }
                  const read = listing.status === 'ready'
                  const unlisted = read ? rows.filter(isUnlisted) : []
                  const listed = read ? rows.filter(row => !isUnlisted(row)) : rows
                  return (
                    <>
                      {noMatch
                        // Not said while the listing is being read: what it holds is yet to be
                        // searched.
                        ? listing.status !== 'loading' && noneFound
                        // A space whose only rows are unlisted ones is not said to have none.
                        : (listed.length > 0 || unlisted.length === 0) && (
                            <SpaceSectionRows
                              section={{ kind: 'space', space: info, listing: listing.status, rows: listed }}
                              renderRow={renderRow}
                            />
                          )}
                      {/* On show whatever the search matches, since a listing that is not read
                          is missing from what was searched, and always the second of these
                          siblings, so that a read begun from it stays the one under way while
                          the search changes. */}
                      <SpaceListingStatus
                        status={listing.status}
                        label={label}
                        onReload={() => reload(spaceId)}
                        onFocusLost={onFocusLost}
                      />
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
        </>
      )}
      {membersOpen && (
        <SpaceMembersDialog spaceId={spaceId} onClose={closeMembers} onLeft={handleLeft} />
      )}
    </div>
  )
}
