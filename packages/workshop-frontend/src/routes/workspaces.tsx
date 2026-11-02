import { useRef, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import { Plus } from '@phosphor-icons/react'
import { isValidSpaceKey } from '@gadgets/workshop-shared/api'
import GadgetList from '../components/GadgetList'
import { NewSpaceButton } from '../features/spaces/NewSpaceButton'
import { SpaceMembersDialog } from '../features/spaces/SpaceMembersDialog'
import { SpaceSections } from '../features/spaces/SpaceSections'
import { spaceKeyFromSearch } from '../features/spaces/spaceKey'
import { spaceLabel } from '../features/spaces/spaceKinds'
import { useSpaces } from '../features/spaces/useSpaces'
import { useDocumentTitle } from '../useDocumentTitle'

// `space` asks for the section of the space it names: the page scrolls to that section, focuses
// it and drops the parameter. It is read only while the `spaces` flag is on.
type WorkspacesSearch = { space?: string }

/**
 * Full workspace listing. The sidebar surfaces Favorites + a handful of Recent workspaces; this is
 * the "see them all" destination linked from the rail.
 */
export const Route = createFileRoute('/workspaces')({
  component: WorkspacesPage,
  validateSearch: (search: Record<string, unknown>): WorkspacesSearch => ({
    space: spaceKeyFromSearch(search.space, isValidSpaceKey),
  }),
})

function WorkspacesPage() {
  useDocumentTitle('Workspaces')
  const { space } = Route.useSearch()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const spaces = useSpaces()
  // Held here and not with the sections: the list unmounts them while it loads again, and an
  // open dialog outlasts that.
  const [membersOf, setMembersOf] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // The parameter is a request, answered once. Left in the URL, it would be answered again each
  // time the list loaded again and its sections mounted, and following the same link a second
  // time would change nothing and so ask for nothing. The router puts a scrolled list back where
  // a navigation found it once the navigation has rendered, which here is after the section was
  // scrolled to; `resetScroll: false` has it leave the list where the section put it.
  const withdrawSpace = () =>
    void navigate({ to: '/workspaces', search: {}, replace: true, resetScroll: false })

  // The dialog may have changed the user's role in the space.
  const closeMembers = () => {
    setMembersOf(null)
    void spaces.refresh()
  }

  // The space's section goes with the membership, and with it the button the closing dialog
  // hands focus back to. So the leave is said in a toast, and the page's heading takes the focus
  // that button's removal leaves nowhere. Focus the user has put elsewhere while the list was
  // read again, in a dialog opened since for one, stays where it is.
  const handleLeft = async (spaceKey: string) => {
    const left = spaces.spaces.find(listed => listed.key === spaceKey)
    setMembersOf(null)
    if (left) toasts.add({ title: `You left ${spaceLabel(left)}`, variant: 'success' })
    await spaces.refresh()
    const focused = document.activeElement
    if (!focused || focused === document.body || !focused.isConnected) headingRef.current?.focus()
  }

  // The new space's section is asked for before the list is read again, and answers when the list
  // brings it. Asked for after the read, the request could find the user on another page and
  // bring them back. It takes this page's place in the history, as a sidebar link followed here
  // does.
  const handleSpaceCreated = (key: string) => {
    void navigate({ to: '/workspaces', search: { space: key }, replace: true })
    void spaces.refresh()
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
              <SpaceSections
                {...rows}
                spaces={spaces}
                focusedSpaceKey={space}
                onSpaceFocused={withdrawSpace}
                onMembersOpen={setMembersOf}
              />
            ),
          } : undefined}
        />
      </div>
      {spaces.enabled && membersOf !== null && (
        <SpaceMembersDialog
          spaceKey={membersOf}
          onClose={closeMembers}
          onLeft={() => void handleLeft(membersOf)}
        />
      )}
    </div>
  )
}
