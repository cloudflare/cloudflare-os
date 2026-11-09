import { useEffect, useRef, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import { Plus } from '@phosphor-icons/react'
import GadgetList from '../components/GadgetList'
import { takeLostFocus } from '../features/spaces/lostFocus'
import { NewSpaceButton } from '../features/spaces/NewSpaceButton'
import { NewSpaceDialog } from '../features/spaces/NewSpaceDialog'
import { SpaceMembersDialog } from '../features/spaces/SpaceMembersDialog'
import { SpaceSections } from '../features/spaces/SpaceSections'
import { spaceLabel } from '../features/spaces/spaceKinds'
import { useNewSpaceDialog } from '../features/spaces/useNewSpaceDialog'
import { useSpaceListings } from '../features/spaces/useSpaceListings'
import { useSpaces } from '../features/spaces/useSpaces'
import { useSubspaces, type SubspaceListing } from '../features/spaces/useSubspaces'
import { useDocumentTitle } from '../useDocumentTitle'

/**
 * Full workspace listing. The sidebar surfaces Favorites + a handful of Recent workspaces; this is
 * the "see them all" destination linked from the rail. With the `spaces` flag on it shows the
 * user's personal space, its sub-spaces as cards and its workspaces as rows, then their team
 * spaces as cards that link to each space's own page, and a search across all of them. A team
 * space of the user's own is created from the header, and a space inside the personal space
 * from its section. The page holds what is read for that, each team space's listing and the
 * personal space's sub-spaces: the list unmounts what it lays out while it loads again, and the
 * dialogs, which are the page's, read a space again when they close.
 */
export const Route = createFileRoute('/workspaces')({
  component: WorkspacesPage,
})

const SUBSPACES_LOADING: SubspaceListing = { status: 'loading' }

function WorkspacesPage() {
  useDocumentTitle('Workspaces')
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const spaces = useSpaces()
  const teamIds = spaces.spaces.filter(space => space.kind === 'team').map(space => space.id)
  const listings = useSpaceListings(teamIds)
  const personal = spaces.spaces.find(space => space.kind === 'personal')
  const { subspaces, reload: reloadSubspaces } = useSubspaces(personal ? [personal.id] : [])
  const personalSubspaces = (personal && subspaces[personal.id]) ?? SUBSPACES_LOADING
  const reloadPersonalSubspaces = async () => {
    if (personal) await reloadSubspaces(personal.id)
  }
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Both dialogs of the list are held here and not with what they are opened from, the cards
  // and the Personal section: the list unmounts those while it loads again, and an open dialog
  // outlasts that, with the name typed into it. The `New space` it was opened from may then be
  // off the page when it is dismissed, and the heading takes the focus that leaves nowhere.
  const [membersOf, setMembersOf] = useState<string | null>(null)
  const newSpace = useNewSpaceDialog(() => takeLostFocus(headingRef.current))

  // A user who arrives with focus nowhere starts at the heading: one who left a space from that
  // space's own page does, the button they confirmed it with having gone with that page. The
  // heading can take focus only with the spaces flag on.
  useEffect(() => takeLostFocus(headingRef.current), [])

  // The dialog may have changed the user's role in the space, or the space may have stopped
  // counting them as a member, so the list of spaces is read again, and so is the listing of a
  // team space of that list, which carries the role its card shows. A role held in a space is
  // held in every space under it, so the listed spaces that said they are inside another are
  // read with it, every one of them, since a listing names the space directly above it and not
  // what that one is inside: the role on such a card may be the one that just changed above
  // it. A space the user left is not read: it would refuse, and the list read again is what
  // takes its card away. A card that goes then takes with it the button the closing dialog
  // hands focus back to, and so does a list that a session replaced under the dialog rendered
  // again: the page's heading takes the focus that leaves nowhere. Focus that is back on the
  // button, or that the user has put elsewhere while the reads were under way, in a dialog
  // opened since for one, stays where it is.
  const closeMembers = async ({ left = false } = {}) => {
    const closed = membersOf
    setMembersOf(null)
    const changed = closed !== null && teamIds.includes(closed)
      ? teamIds.filter((id) => {
          if (id === closed) return !left
          const listing = listings.listings[id]
          return listing?.status === 'ready' && listing.parent !== undefined
        })
      : []
    await Promise.all([spaces.refresh(), ...changed.map(id => listings.reload(id))])
    takeLostFocus(headingRef.current)
  }

  // The space's card goes with the membership, so the leave is said in a toast.
  const handleLeft = (spaceId: string) => {
    const left = spaces.spaces.find(listed => listed.id === spaceId)
    if (left) toasts.add({ title: `You left ${spaceLabel(left)}`, variant: 'success' })
    return closeMembers({ left: true })
  }

  // A space that was created is shown on its own page, which opens it by its id.
  const goToSpace = (id: string) => void navigate({ to: '/spaces/$spaceId', params: { spaceId: id } })

  // A team space of the user's own joins their list of spaces, which is read again for the
  // sidebar; the space's page does not wait for it. A space created inside the personal space
  // joins no list, so nothing is read again for one.
  const handleSpaceCreated = (id: string) => {
    void spaces.refresh()
    goToSpace(id)
  }

  const createWorkspaceLink = (
    // "Create" just routes to Home (the new-workspace launcher) for now.
    <Link
      to="/"
      className="press inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[14px] font-medium text-white transition-colors hover:bg-kumo-brand-hover sm:h-9 sm:text-[13px]"
    >
      <Plus size={14} weight="bold" />
      Create workspace
    </Link>
  )

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-3 sm:px-10">
      <header className="flex flex-col items-stretch gap-4 px-3 pb-3 pt-6 sm:flex-row sm:items-end sm:justify-between sm:pt-10">
        <div className="min-w-0">
          <h1
            ref={headingRef}
            tabIndex={spaces.enabled ? -1 : undefined}
            className="text-2xl font-semibold tracking-tight text-kumo-default"
          >
            Workspaces
          </h1>
          <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
            Each workspace is an isolated environment with its own conversations, gatekeepers, and outputs.
          </p>
        </div>
        {spaces.enabled ? (
          <div className="flex shrink-0 items-center gap-2">
            <NewSpaceButton
              className="!h-11 flex-1 sm:!h-9 sm:flex-none"
              spaces={spaces}
              onCreated={handleSpaceCreated}
            />
            {createWorkspaceLink}
          </div>
        ) : createWorkspaceLink}
      </header>
      <div className="min-h-0 flex-1">
        <GadgetList
          showHeader={false}
          sections={spaces.enabled ? {
            spaces: spaces.spaces,
            showsListed: teamIds.length > 0,
            personalHasSubspaces: personalSubspaces.status === 'ready' && personalSubspaces.subspaces.length > 0,
            render: (rows) => (
              <SpaceSections
                {...rows}
                // The list gives the search field the focus a control of these sections has
                // lost. A user with no workspace and no team space has no field: the heading
                // takes it then.
                onFocusLost={() => {
                  rows.onFocusLost()
                  takeLostFocus(headingRef.current)
                }}
                spaces={spaces}
                listings={listings}
                personalSubspaces={{ listing: personalSubspaces, onReload: reloadPersonalSubspaces }}
                personalNewSpace={{ onOpen: newSpace.show, buttonRef: newSpace.buttonRef }}
                onMembersOpen={setMembersOf}
              />
            ),
          } : undefined}
        />
      </div>
      {spaces.enabled && membersOf !== null && (
        <SpaceMembersDialog
          key={membersOf}
          spaceId={membersOf}
          onClose={() => void closeMembers()}
          onLeft={() => void handleLeft(membersOf)}
        />
      )}
      {spaces.enabled && newSpace.open && personal && (
        <NewSpaceDialog
          parent={{
            space: personal,
            subspaces: personalSubspaces.status === 'ready' ? personalSubspaces.subspaces : null,
            onReload: reloadPersonalSubspaces,
          }}
          onClose={newSpace.dismiss}
          onCreated={(id) => {
            newSpace.close()
            goToSpace(id)
          }}
        />
      )}
    </div>
  )
}
