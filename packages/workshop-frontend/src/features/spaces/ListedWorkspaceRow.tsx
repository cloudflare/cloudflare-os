import { Link } from '@tanstack/react-router'
import { SquaresFour } from '@phosphor-icons/react'
import type { SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'

/**
 * A workspace that a space lists and the user's own list does not have: another member's, which
 * the user may open as a member of the space. The listing is all that is known of it.
 */
export const ListedWorkspaceRow = ({ workspace, describedBy }: {
  workspace: SpaceWorkspaceInfo
  /** The id of an element outside the row that describes it, such as the space it is in. */
  describedBy?: string
}) => (
  <Link
    to="/workspace/$id"
    params={{ id: workspace.id }}
    aria-describedby={describedBy}
    className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-kumo-tint"
  >
    <div
      aria-hidden="true"
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle"
    >
      <SquaresFour size={16} />
    </div>
    <div className="min-w-0 flex-1">
      <h3 className="truncate text-sm font-medium text-kumo-default">
        {workspace.title || 'Untitled Workspace'}
      </h3>
      <p className="mt-0.5 truncate text-xs text-kumo-subtle">Owned by {workspace.owner.name}</p>
    </div>
    <span className="hidden flex-shrink-0 text-xs text-kumo-inactive lg:block">
      Created {workspace.created.toLocaleDateString()}
    </span>
  </Link>
)
