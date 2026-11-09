import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../../AuthContext'
import GadgetList, { type GadgetListRows } from '../../components/GadgetList'
import { BusyButton } from '../../features/spaces/BusyButton'
import { matchingRows, spaceRows, type WorkspaceRow } from '../../features/spaces/groupWorkspaces'
import { takeLostFocus, useFocusAfterAction } from '../../features/spaces/lostFocus'
import { NewSpaceDialog } from '../../features/spaces/NewSpaceDialog'
import { SPACE_ACTION_CLASS_NAME } from '../../features/spaces/SpaceEntryPoints'
import { spaceLabel } from '../../features/spaces/spaceKinds'
import { SpaceListingStatus } from '../../features/spaces/SpaceListingStatus'
import { SpaceMembersDialog } from '../../features/spaces/SpaceMembersDialog'
import { SpaceNotFound } from '../../features/spaces/SpaceNotFound'
import { SpaceSectionRows } from '../../features/spaces/SpaceSectionRows'
import { SubspaceCards } from '../../features/spaces/SubspaceCards'
import { useNewSpaceDialog } from '../../features/spaces/useNewSpaceDialog'
import { useSpace } from '../../features/spaces/useSpace'
import { useSpaceAncestors } from '../../features/spaces/useSpaceAncestors'
import { useLastKnown, type Spaces } from '../../features/spaces/useSpaces'
import type { SubspaceListing } from '../../features/spaces/useSubspaces'
import { useDocumentTitle } from '../../useDocumentTitle'
import { SpaceHeader } from './SpaceHeader'
import { useSpaceContents } from './useSpaceContents'

const SUBSPACES_LOADING: SubspaceListing = { status: 'loading' }

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
 * A space's own page. For a team space: the way up to the spaces it is inside, for a user who
 * holds a role there; its name; the role the space says the user holds in it; the entry points
 * to its members, to a space inside it, for a user who may create one, and to a workspace in
 * it; the sub-spaces directly inside it as cards; and under them its workspaces, which are the
 * rows `spaceRows` gives. One read of the space brings the sub-spaces with what it lists
 * (`useSpaceContents`).
 *
 * Those rows place the user's own workspaces by the user's records, so one may be here that the
 * space does not list yet: one whose registration it has not seen. Once the listing has been
 * read these are shown apart and said to be so, since no other member sees them here.
 *
 * A personal space is shown to nobody but its owner, who is its only member. Its page says so
 * where a team space's names a role, offers no members, offers a space inside it, and shows its
 * sub-spaces as cards and under them the user's own workspaces that are in no team space all
 * together: its sub-spaces are all that is read of it, since every entry of what it lists is
 * one of those workspaces and there is nobody else for it to differ for.
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
  // The id of the space whose members are open: this one's, from the header, or a sub-space's,
  // from its card. Held here, as the dialog that creates a space inside this one is, and not
  // with what they are opened from: the header goes when the space cannot be read, the cards
  // while the list loads again, and an open dialog outlasts both.
  const [membersOf, setMembersOf] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // A read of the space that fails under that dialog takes the header away, and `New space` with
  // it: the `Try again` shown in the header's place takes the focus a dismissed dialog leaves.
  const retryRef = useRef<HTMLButtonElement>(null)
  const newSpace = useNewSpaceDialog(() => takeLostFocus(retryRef.current))
  // What takes the focus that closed members leave nowhere, after the render that follows the
  // read of the space: a read that failed takes the header away in that render and not before.
  const membersClosed = useFocusAfterAction(() => takeLostFocus(headingRef.current ?? retryRef.current))
  const [retrying, setRetrying] = useState(false)

  // The space as last read, while a read of it is under way: a session that replaces another (a
  // reconnect) has read nothing yet, and the header and the list stay up through that, with what
  // the user has typed into the list and opened from it.
  const info = useLastKnown(state.status === 'ready' ? state.info : null, state.status !== 'loading')
  const label = info ? spaceLabel(info) : null
  // The space as last read at all, for the dialog that creates a space inside it: a read that
  // fails takes the header away, and the dialog stays over that with the name typed into it.
  const lastRead = useLastKnown(info, info !== null)
  // The space's kind, from its info once read, and before that from the user's list of spaces.
  const kind = (info ?? spaces.spaces.find(space => space.id === spaceId))?.kind
  // What is read of a space besides its info depends on its kind, so nothing is read before
  // that is known: a space that refuses the user and is not in their list is asked nothing more.
  const { contents, reload } = useSpaceContents(kind ? { id: spaceId, kind } : undefined)
  const ancestors = useSpaceAncestors(info?.parent)
  useDocumentTitle(label)

  // A space that refuses to say what is in it has taken the user off its members since it was
  // read. It is read again, so that the page shows what it shows for a space that refuses them.
  // Once for each refusal, so a space that still answers for itself is not read in a loop.
  const contentsRefused = contents.status === 'refused'
  const readSpaceAgain = useEffectEvent(() => {
    void refresh()
  })
  useEffect(() => {
    if (contentsRefused) readSpaceAgain()
  }, [contentsRefused])

  if (state.status === 'refused') {
    // The dialog that creates a space here went with the page, and does not come back, empty,
    // should the space count the user as a member again.
    if (newSpace.open) newSpace.close()
    return <SpaceNotFound />
  }

  const retry = async () => {
    setRetrying(true)
    try {
      await refresh()
    } finally {
      setRetrying(false)
    }
  }

  // The dialog may have changed the user's role in the space, so the space and the list of
  // spaces are read again. A sub-space's card that the list rendered again under the dialog, for
  // a session that replaced another, is not the one the dialog was opened from, and the button
  // the closing dialog hands the focus back to is off the page: the heading takes the focus that
  // leaves nowhere, or `Try again` where the read failed and took the header away, and with it
  // the button the focus was back on. The read of the space decides which, so it is waited for;
  // the list of spaces takes nothing off this page, and is not. Focus that is back on a button
  // still there, or that the user has put elsewhere by then, stays where it is.
  const closeMembers = async () => {
    setMembersOf(null)
    void spaces.refresh()
    await refresh()
    membersClosed()
  }

  // The space refuses a user who has left it, so there is nothing of this page to go back to:
  // the workspaces page takes its place, and a toast says what happened.
  const handleLeft = () => {
    setMembersOf(null)
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
            ref={retryRef}
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
          <SpaceHeader
            info={info}
            ancestors={ancestors}
            headingRef={headingRef}
            onMembersOpen={() => setMembersOf(spaceId)}
            // By the role the space reported: a `use` member creates no space in it.
            newSpace={info.role !== 'use' ? { onOpen: newSpace.show, buttonRef: newSpace.buttonRef } : undefined}
          />
          <div className="min-h-0 flex-1">
            <GadgetList
              showHeader={false}
              sections={{
                spaces: spaces.spaces,
                // A team space's page shows what the space lists; a personal space's rows are
                // the user's own workspaces alone.
                showsListed: info.kind === 'team',
                personalHasSubspaces: info.kind === 'personal' && contents.status === 'ready' && contents.subspaces.length > 0,
                render: ({ gadgets, search, renderRow, onFocusLost, emptyState }: GadgetListRows) => {
                  const rows = matchingRows(spaceRows({
                    gadgets,
                    space: info,
                    workspaces: contents.status === 'ready' ? contents.workspaces : [],
                    userId: currentUser?.id,
                  }), search)
                  const noMatch = search !== '' && rows.length === 0
                  // Only a team space's read brings rows, so only its failure leaves rows out of
                  // what was searched: a personal space's rows are the user's own records.
                  const noneFound = (
                    <div className="py-12 text-center text-sm text-kumo-inactive">
                      {info.kind === 'team' && contents.status === 'failed'
                        ? 'No workspaces found, but the results may be incomplete.'
                        : 'No workspaces found'}
                    </div>
                  )
                  // The sub-spaces, above the workspaces and not among what a search shows: they
                  // are not workspaces. A team space's come with what it lists, and the line
                  // under its rows already says when that read failed, so here it is said only
                  // of a personal space, of which nothing else is read. When its `Try again`
                  // finds no sub-space the search field takes the focus, and `New space` on a
                  // page with no field, which the personal space's is for a user with no
                  // workspace.
                  const subspaces = search === '' && (
                    <SubspaceCards
                      label={label}
                      listing={info.kind === 'personal' || contents.status === 'ready' ? contents : SUBSPACES_LOADING}
                      onMembersOpen={setMembersOf}
                      onReload={reload}
                      onFocusLost={() => {
                        onFocusLost()
                        takeLostFocus(newSpace.buttonRef.current)
                      }}
                    />
                  )
                  if (info.kind === 'personal') {
                    return noMatch ? noneFound : (
                      <>
                        {subspaces}
                        <SpaceSectionRows
                          section={{ kind: 'personal', space: info, rows }}
                          renderRow={renderRow}
                        />
                        {rows.length === 0 && emptyState}
                      </>
                    )
                  }
                  const read = contents.status === 'ready'
                  const unlisted = read ? rows.filter(isUnlisted) : []
                  const listed = read ? rows.filter(row => !isUnlisted(row)) : rows
                  return (
                    <>
                      {subspaces}
                      {noMatch
                        // Not said while the listing is being read: what it holds is yet to be
                        // searched.
                        ? contents.status !== 'loading' && noneFound
                        // A space whose only rows are unlisted ones is not said to have none.
                        : (listed.length > 0 || unlisted.length === 0) && (
                            <SpaceSectionRows
                              section={{ kind: 'space', space: info, listing: contents.status, rows: listed }}
                              renderRow={renderRow}
                            />
                          )}
                      {/* On show whatever the search matches, since a listing that is not read
                          is missing from what was searched, and always the third of these
                          siblings, so that a read begun from it stays the one under way while
                          the search changes. */}
                      <SpaceListingStatus
                        status={contents.status}
                        label={label}
                        onReload={reload}
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
      {membersOf !== null && (
        <SpaceMembersDialog
          key={membersOf}
          spaceId={membersOf}
          onClose={() => void closeMembers()}
          onLeft={membersOf === spaceId ? handleLeft : () => void closeMembers()}
        />
      )}
      {newSpace.open && lastRead && (
        <NewSpaceDialog
          parent={{
            space: lastRead,
            subspaces: contents.status === 'ready' ? contents.subspaces : null,
            onReload: reload,
          }}
          onClose={newSpace.dismiss}
          // The sub-space's page starts afresh, and its heading takes the focus. The list of
          // spaces is not read again: a sub-space joins nobody's list.
          onCreated={(id) => {
            newSpace.close()
            void navigate({ to: '/spaces/$spaceId', params: { spaceId: id } })
          }}
        />
      )}
    </div>
  )
}
