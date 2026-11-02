import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Plus, SquaresFour, UsersThree } from '@phosphor-icons/react'
import type { GadgetMetadataWithTimestamps, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'
import type { WorkspaceSection } from './groupWorkspaces'
import { spaceLabel } from './spaceKinds'
import { SPACE_ROLE_LABELS } from './spaceRoles'

/** The size of the small buttons a section's header and status lines carry. */
export const SECTION_ACTION_CLASS_NAME = '!h-7 gap-1.5 !px-2.5 !text-[12px]'

const sectionTitle = (section: WorkspaceSection) => {
  switch (section.kind) {
    case 'personal': return 'Personal'
    case 'space': return spaceLabel(section.space)
    case 'elsewhere': return 'In other spaces'
    case 'shared': return 'Shared with me'
  }
}

// What a section with no rows says, once there is nothing left to wait for.
const emptyLine = (section: WorkspaceSection) => {
  switch (section.kind) {
    case 'personal': return 'No workspaces in your personal space yet.'
    case 'space': return section.listing === 'ready' ? 'No workspaces in this space yet.' : null
    default: return null
  }
}

/**
 * A workspace that a space lists and the user's own list does not have: another member's. The
 * listing is all that is known of it, and whether it opens is the workspace's to decide.
 */
const ListedWorkspaceRow = ({ workspace }: { workspace: SpaceWorkspaceInfo }) => (
  <Link
    to="/workspace/$id"
    params={{ id: workspace.id }}
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

/**
 * One section of the grouped workspace list: its heading, with the entry points to the space's
 * members and to a new workspace in it, then its rows, then one line when it has none or when
 * what the space lists is still loading or could not be read.
 */
export const SpaceSection = ({
  section,
  hidden,
  focused,
  onFocused,
  listingsSettled,
  renderRow,
  onMembersOpen,
  onListingReload,
}: {
  section: WorkspaceSection
  /**
   * A search has left the section no row. It stays mounted, so that a request for it is spent on
   * nothing while it is out of view, and does not wait to take focus from the search field as
   * the section comes back.
   */
  hidden: boolean
  /** The page is being asked for this section: it is scrolled to and takes focus. */
  focused: boolean
  /**
   * The section has answered that request, which the caller now withdraws. A request left
   * standing would be answered again each time the section mounted, as it does whenever the list
   * is loaded again.
   */
  onFocused: () => void
  /** Every space's listing has been read, so the sections above this one have all their rows. */
  listingsSettled: boolean
  /** The list's own row for a workspace in the user's list, keyed. */
  renderRow: (gadget: GadgetMetadataWithTimestamps) => ReactNode
  onMembersOpen: (spaceKey: string) => void
  /** Reads what the space lists again, resolving once the read has settled either way. */
  onListingReload: (spaceKey: string) => Promise<void>
}) => {
  const headingId = useId()
  const sectionRef = useRef<HTMLElement>(null)
  const [reloading, setReloading] = useState(false)
  const title = sectionTitle(section)
  const space = section.kind === 'personal' || section.kind === 'space' ? section.space : undefined
  const empty = section.rows.length === 0 ? emptyLine(section) : null

  // Whether the section has been scrolled to and focused on request since it mounted.
  const askedFor = useRef(false)

  useEffect(() => {
    if (!focused) return
    if (!hidden) {
      sectionRef.current?.scrollIntoView({ block: 'start' })
      sectionRef.current?.focus({ preventScroll: true })
      askedFor.current = true
    }
    onFocused()
  }, [focused])

  // The sections above grow as their listings arrive, which moves this one down the page, and a
  // page too short to scroll when it was asked for may not be any more. So the section is
  // scrolled to once more when they have all arrived, unless focus has moved on from it.
  useEffect(() => {
    if (!askedFor.current || !listingsSettled) return
    if (document.activeElement === sectionRef.current) {
      sectionRef.current?.scrollIntoView({ block: 'start' })
    }
  }, [listingsSettled])

  const reloadListing = async (spaceKey: string) => {
    setReloading(true)
    try {
      await onListingReload(spaceKey)
    } finally {
      setReloading(false)
    }
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      tabIndex={-1}
      hidden={hidden}
      className={hidden ? undefined : 'flex shrink-0 flex-col gap-0.5 pb-5 outline-none'}
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-3">
        <h2 id={headingId} className="min-w-0 truncate text-[13px] leading-[18px] font-semibold tracking-[-0.25px] text-kumo-default">
          {title}
        </h2>
        {section.kind === 'space' && (
          <p className="text-[12px] leading-4 text-kumo-subtle">
            Your role: {SPACE_ROLE_LABELS[section.space.role]}
          </p>
        )}
        {section.kind === 'elsewhere' && (
          <p className="text-[12px] leading-4 text-kumo-subtle">
            Your workspaces in spaces that are not in your list.
          </p>
        )}
        {(section.kind === 'personal' || section.kind === 'space') && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {space && (
              <WorkshopButton
                className={SECTION_ACTION_CLASS_NAME}
                aria-label={`Members of ${title}`}
                onClick={() => onMembersOpen(space.key)}
              >
                <UsersThree size={13} />
                Members
              </WorkshopButton>
            )}
            {/* Only its owner adds workspaces to a personal space, so another person's offers none. */}
            {(section.kind === 'personal' || section.space.kind === 'team') && (
              <Link
                to="/"
                search={section.kind === 'space' ? { space: section.space.key } : {}}
                aria-label={`New workspace in ${title}`}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-base px-2.5 text-[12px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-elevated"
              >
                <Plus size={12} weight="bold" />
                New workspace
              </Link>
            )}
          </div>
        )}
      </div>

      {section.rows.map(row => (row.kind === 'record'
        ? renderRow(row.gadget)
        : <ListedWorkspaceRow key={row.id} workspace={row.workspace} />))}

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
            className={SECTION_ACTION_CLASS_NAME}
            aria-label={`Try again to load ${title}`}
            loading={reloading}
            onClick={() => void reloadListing(section.space.key)}
          >
            Try again
          </WorkshopButton>
        </div>
      )}
    </section>
  )
}
