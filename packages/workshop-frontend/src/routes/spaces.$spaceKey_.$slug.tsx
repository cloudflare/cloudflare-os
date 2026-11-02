import type { ReactNode } from 'react'
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router'
import AppShell from '../components/AppShell/AppShell'
import WorkspaceOpenErrorPage from '../components/WorkspaceOpenErrorPage'
import { SpaceNotFound } from '../features/spaces/SpaceNotFound'
import { useSpaceWorkspace } from '../features/spaces/useSpaceWorkspace'
import GadgetEditor from '../GadgetEditor'
import { validateWorkspaceSearch } from '../workspaceSearch'

// The frame the root route gives the workspace editor at /workspace/<id>.
const Fullscreen = ({ children }: { children: ReactNode }) => (
  <main className="h-full min-h-0">{children}</main>
)

/**
 * The workspace editor at a workspace's address within a space, behind the `spaces` flag. The
 * address only finds the workspace: whether it opens is the workspace's own to decide, and the
 * editor shows its usual screen when it does not.
 *
 * The root route leaves the frame to this one, which alone knows what the address leads to: the
 * editor and the way to it are fullscreen, as at /workspace/<id>, and an address with nothing
 * there is what a URL no route matches is, the not-found inside the app chrome.
 *
 * The file is `spaces.$spaceKey_.$slug` (trailing underscore) so the URL is
 * /spaces/$spaceKey/$slug without nesting inside the space page's component.
 */
const SpaceWorkspaceRoute = () => {
  const { spaceKey, slug } = Route.useParams()
  const navigate = useNavigate()
  const { state, retry } = useSpaceWorkspace(spaceKey, slug)

  switch (state.status) {
    case 'loading':
      return (
        <Fullscreen>
          <div role="status" aria-label="Loading workspace" className="flex min-h-full items-center justify-center bg-kumo-base">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
          </div>
        </Fullscreen>
      )
    case 'not-found':
      return <AppShell><SpaceNotFound /></AppShell>
    case 'failed':
      return (
        <Fullscreen>
          <WorkspaceOpenErrorPage
            kind="unexpected"
            onRetry={retry}
            onGoToWorkspaces={() => void navigate({ to: '/workspaces' })}
          />
        </Fullscreen>
      )
    case 'ready': {
      const { workspace, canonical } = state
      // An address the workspace used to have gives way to the one it has now, with the rest of
      // the URL kept, before the editor mounts and starts navigating within it.
      if (!canonical && workspace.slug !== undefined) {
        return (
          <Navigate
            to="/spaces/$spaceKey/$slug"
            params={{ spaceKey, slug: workspace.slug }}
            search={true}
            hash={true}
            replace
          />
        )
      }
      return <Fullscreen><GadgetEditor workspaceId={workspace.id} /></Fullscreen>
    }
  }
}

export const Route = createFileRoute('/spaces/$spaceKey_/$slug')({
  component: SpaceWorkspaceRoute,
  validateSearch: validateWorkspaceSearch,
})
