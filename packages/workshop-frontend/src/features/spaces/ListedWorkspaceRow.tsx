import { DropdownMenu } from '@cloudflare/kumo'
import { DotsThreeVertical, LinkSimple, SquaresFour } from '@phosphor-icons/react'
import type { SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { MENU_CONTENT, MENU_ITEM } from '../../components/menuStyles'
import { PublishedBadge } from './PublishedBadge'
import type { WorkspaceRowListing } from './workspaceAddress'
import { WorkspaceLink } from './WorkspaceLink'

/**
 * A workspace as a space lists it, which is all that is known of it here: another member's, which
 * the user may open as a member of the space, or one its owner has published, which anyone signed
 * in may open. A published one says so, with the role it is published with.
 */
export const ListedWorkspaceRow = ({ workspace, listing }: {
  workspace: SpaceWorkspaceInfo
  /** Where the row links to, and the way to change that address for a user who may. */
  listing: Pick<WorkspaceRowListing, 'address' | 'onAddressChange'> | undefined
}) => {
  const title = workspace.title || 'Untitled Workspace'
  return (
    <WorkspaceLink
      id={workspace.id}
      address={listing?.address}
      className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-kumo-tint"
    >
      <div
        aria-hidden="true"
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle"
      >
        <SquaresFour size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-medium text-kumo-default">{title}</h3>
          {workspace.published && <PublishedBadge role={workspace.published} />}
        </div>
        <p className="mt-0.5 truncate text-xs text-kumo-subtle">Owned by {workspace.owner.name}</p>
      </div>
      <span className="hidden flex-shrink-0 text-xs text-kumo-inactive lg:block">
        Created {workspace.created.toLocaleDateString()}
      </span>
      {listing?.onAddressChange && (
        // The wrapper keeps a press on the menu from following the row's link.
        <div onClick={(event) => { event.stopPropagation(); event.preventDefault() }}>
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <button
                  aria-label={`Actions for ${title}`}
                  className="rounded-md p-1.5 text-kumo-subtle transition-colors hover:bg-kumo-fill hover:text-kumo-default focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                >
                  <DotsThreeVertical size={16} />
                </button>
              }
            />
            <DropdownMenu.Content className={MENU_CONTENT}>
              <DropdownMenu.Item onClick={listing.onAddressChange} className={MENU_ITEM}>
                <LinkSimple size={13} className="mr-2" />
                Change address
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>
      )}
    </WorkspaceLink>
  )
}
