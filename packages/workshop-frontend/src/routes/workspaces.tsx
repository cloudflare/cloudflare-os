import { useEffect, useRef, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import { Plus } from '@phosphor-icons/react'
import GadgetList from '../components/GadgetList'
import { takeLostFocus } from '../features/spaces/lostFocus'
import { NewSpaceButton } from '../features/spaces/NewSpaceButton'
import { SpaceMembersDialog } from '../features/spaces/SpaceMembersDialog'
import { SpaceSections } from '../features/spaces/SpaceSections'
import { spaceLabel } from '../features/spaces/spaceKinds'
import { useSpaces } from '../features/spaces/useSpaces'
import { useDocumentTitle } from '../useDocumentTitle'

/**
 * Full workspace listing. The sidebar surfaces Favorites + a handful of Recent workspaces; this is
 * the "see them all" destination linked from the rail. With the `spaces` flag on it shows the
 * workspaces of the user's personal space as rows, then their team spaces as cards that link to
 * each space's own page, and a search across all of them.
 */
export const Route = createFileRoute('/workspaces')({
  component: WorkspacesPage,
})

function WorkspacesPage() {
  useDocumentTitle('Workspaces')
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const spaces = useSpaces()
  // Held here and not with the cards it is opened from: the list unmounts them while it loads
  // again, and an open dialog outlasts that.
  const [membersOf, setMembersOf] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // A user who arrives with focus nowhere starts at the heading: one who left a space from that
  // space's own page does, the button they confirmed it with having gone with that page. The
  // heading can take focus only with the spaces flag on.
  useEffect(() => takeLostFocus(headingRef.current), [])

  // The dialog may have changed the user's role in the space, or the space may have stopped
  // counting them as a member, so the list of spaces is read again. A card that goes then takes
  // with it the button the closing dialog hands focus back to, and so does a list that a session
  // replaced under the dialog rendered again: the page's heading takes the focus that leaves
  // nowhere. Focus that is back on the button, or that the user has put elsewhere while the list
  // was read again, in a dialog opened since for one, stays where it is.
  const closeMembers = async () => {
    setMembersOf(null)
    await spaces.refresh()
    takeLostFocus(headingRef.current)
  }

  // The space's card goes with the membership, so the leave is said in a toast.
  const handleLeft = (spaceId: string) => {
    const left = spaces.spaces.find(listed => listed.id === spaceId)
    if (left) toasts.add({ title: `You left ${spaceLabel(left)}`, variant: 'success' })
    return closeMembers()
  }

  // A new space is shown on its own page. The list of spaces is read again for the sidebar,
  // which that page does not wait for: it opens the space by its id.
  const handleSpaceCreated = (id: string) => {
    void spaces.refresh()
    void navigate({ to: '/spaces/$spaceId', params: { spaceId: id } })
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
            render: (rows) => (
              <SpaceSections {...rows} spaces={spaces} onMembersOpen={setMembersOf} />
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
    </div>
  )
}
