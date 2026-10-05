import { useState, type ReactNode } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { DotsThreeVertical, LinkSimple, SquaresFour } from '@phosphor-icons/react'
import type { GadgetMetadataWithTimestamps, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { MENU_CONTENT, MENU_ITEM } from '../../components/menuStyles'
import { WorkshopButton } from '../../components/WorkshopControls'
import type { WorkspaceSection } from './groupWorkspaces'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import type { WorkspaceRowListing } from './workspaceAddress'
import { WorkspaceLink } from './WorkspaceLink'

// What a section with no rows says, once there is nothing left to wait for.
const emptyLine = (section: WorkspaceSection) => {
  switch (section.kind) {
    case 'personal': return 'No workspaces in your personal space yet.'
    case 'space': return section.listing === 'ready' ? 'No workspaces in this space yet.' : null
    default: return null
  }
}

/**
 * A workspace that a space lists and the user's own list does not have: another member's, which
 * the user may open as a member of the space. The listing is all that is known of it.
 */
const ListedWorkspaceRow = ({ workspace, listing }: {
  workspace: SpaceWorkspaceInfo
  listing: WorkspaceRowListing | undefined
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
        <h3 className="truncate text-sm font-medium text-kumo-default">{title}</h3>
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

/**
 * The rows of one section, then one line when it has none or when what its space lists is still
 * loading or could not be read. A row whose workspace the space lists links to the workspace's
 * address there, once it has one.
 */
export const SpaceSectionRows = ({ section, label, renderRow, onListingReload, onAddressChange }: {
  section: WorkspaceSection
  /** What the section is called, which names its 'Try again'. */
  label: string
  /** The list's own row for a workspace in the user's list, keyed. */
  renderRow: (gadget: GadgetMetadataWithTimestamps, listing?: WorkspaceRowListing) => ReactNode
  /** Reads what the space lists again, resolving once the read has settled either way. */
  onListingReload: (spaceKey: string) => Promise<void>
  /**
   * The user asked to change the address of this entry of the space's listing. When given, the
   * rows of the entries the user may change offer it: the ones they own, as the listing records
   * the owner, and every one for an admin of the space.
   */
  onAddressChange?: (entry: SpaceWorkspaceInfo) => void
}) => {
  const { currentUser } = useAuthenticatedApi()
  const [reloading, setReloading] = useState(false)
  const space = section.kind === 'space' ? section.space : undefined
  const empty = section.rows.length === 0 ? emptyLine(section) : null

  const listingOf = (entry: SpaceWorkspaceInfo | undefined): WorkspaceRowListing | undefined => {
    if (!space || !entry) return undefined
    const mayChange = space.role === 'admin' || entry.owner.id === currentUser?.id
    return {
      address: entry.slug === undefined ? undefined : { spaceKey: space.key, slug: entry.slug },
      onAddressChange: onAddressChange && mayChange ? () => onAddressChange(entry) : undefined,
    }
  }

  const reloadListing = async (spaceKey: string) => {
    setReloading(true)
    try {
      await onListingReload(spaceKey)
    } finally {
      setReloading(false)
    }
  }

  return (
    <>
      {section.rows.map(row => (row.kind === 'record'
        ? renderRow(row.gadget, listingOf(row.entry))
        : <ListedWorkspaceRow key={row.id} workspace={row.workspace} listing={listingOf(row.workspace)} />))}

      {empty && <p className="px-3 py-2 text-[13px] leading-[18px] text-kumo-inactive">{empty}</p>}
      {section.kind === 'space' && section.listing === 'loading' && (
        <p role="status" className="px-3 py-2 text-[13px] leading-[18px] text-kumo-inactive">
          Loading this space’s workspaces…
        </p>
      )}
      {section.kind === 'space' && section.listing === 'refused' && (
        <p role="alert" className="px-3 py-2 text-[13px] leading-[18px] text-kumo-default">
          You are no longer a member of this space.
        </p>
      )}
      {section.kind === 'space' && section.listing === 'failed' && (
        <div role="alert" className="flex items-center gap-3 px-3 py-2">
          <p className="text-[13px] leading-[18px] text-kumo-danger">
            Couldn’t load this space’s workspaces.
          </p>
          <WorkshopButton
            className={SPACE_ACTION_CLASS_NAME}
            aria-label={`Try again to load ${label}`}
            loading={reloading}
            onClick={() => void reloadListing(section.space.key)}
          >
            Try again
          </WorkshopButton>
        </div>
      )}
    </>
  )
}
