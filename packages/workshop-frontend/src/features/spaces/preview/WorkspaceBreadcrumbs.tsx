import { Link } from '@tanstack/react-router'
import { CaretRight } from '@phosphor-icons/react'
import type { SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { pathTo } from '../tree/workspaceTree'
import { WorkspaceLink } from '../WorkspaceLink'

const CRUMB_CLASS_NAME = 'max-w-[16rem] truncate hover:text-kumo-default hover:underline'

const titleOf = (entry: SpaceWorkspaceInfo) => entry.title || 'Untitled Workspace'

/**
 * The trail from a space down to one of the workspaces its listing holds: the space, then each
 * workspace above it in the space's tree, then the workspace itself. Hand-rolled rather than
 * Kumo's Breadcrumbs, whose items take an `href` and render plain anchors: these are router
 * links, so following one does not reload the app. A workspace links to its address in the space
 * once its entry has a slug, and to /workspace/<id> before.
 */
export const WorkspaceBreadcrumbs = ({ space, listing, workspaceId }: {
  space: { key: string; name: string }
  /** The space's listing, as `Space.listWorkspaces` returns it. */
  listing: readonly SpaceWorkspaceInfo[]
  workspaceId: string
}) => {
  const path = pathTo(listing, workspaceId)
  const ancestors = path.slice(0, -1)
  const current = path.at(-1)

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
        <li className="flex min-w-0 items-center gap-1">
          <Link to="/spaces/$spaceKey" params={{ spaceKey: space.key }} className={CRUMB_CLASS_NAME}>
            {space.name}
          </Link>
        </li>
        {ancestors.map(entry => (
          <li key={entry.id} className="flex min-w-0 items-center gap-1">
            <CaretRight size={10} className="shrink-0 text-kumo-inactive" aria-hidden="true" />
            <WorkspaceLink
              id={entry.id}
              address={entry.slug === undefined ? undefined : { spaceKey: space.key, slug: entry.slug }}
              className={CRUMB_CLASS_NAME}
            >
              {titleOf(entry)}
            </WorkspaceLink>
          </li>
        ))}
        {current && (
          <li className="flex min-w-0 items-center gap-1">
            <CaretRight size={10} className="shrink-0 text-kumo-inactive" aria-hidden="true" />
            <span aria-current="location" className="max-w-[16rem] truncate text-kumo-default">{titleOf(current)}</span>
          </li>
        )}
      </ol>
    </nav>
  )
}
