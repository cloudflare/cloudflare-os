import { Link } from '@tanstack/react-router'
import { ArrowsClockwise, Plus, UsersThree } from '@phosphor-icons/react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'
import { isOwnPersonalSpace } from './spaceKinds'

/** The size of the small buttons a space's heading and status lines carry. */
export const SPACE_ACTION_CLASS_NAME = '!h-7 gap-1.5 !px-2.5 !text-[12px]'

/** Opens the dialog that syncs a source into a space (`StartSpaceSyncDialog`). */
export const SyncFromSourceButton = ({ label, sourceName, onOpen }: {
  /** What the space is called where the button is shown. */
  label: string
  /** What the source is called (`syncSourceName`). */
  sourceName: string
  onOpen: () => void
}) => (
  <WorkshopButton
    className={SPACE_ACTION_CLASS_NAME}
    aria-label={`Sync from ${sourceName} into ${label}`}
    onClick={onOpen}
  >
    <ArrowsClockwise size={13} aria-hidden="true" />
    Sync from {sourceName}
  </WorkshopButton>
)

/**
 * The entry points beside a space's name: to a team space's members, with `onMembersOpen`, to a
 * new workspace in the space, and, with `sync`, to syncing a source into it. A personal space has
 * no members besides its owner, so it offers no members, and only its owner adds workspaces to it.
 */
export const SpaceEntryPoints = ({ label, space, onMembersOpen, sync }: {
  /** What the space is called where these are shown, which names the entry points. */
  label: string
  /**
   * Undefined for the user's own personal space while the list of spaces does not have it: a new
   * workspace goes there all the same.
   */
  space: SpaceInfo | undefined
  /** Offers a team space's members, where the caller shows them. */
  onMembersOpen?: (spaceKey: string) => void
  /**
   * Given only to a user who may add workspaces to the space and has a connected account that
   * can sync a source into it.
   */
  sync?: { sourceName: string; onOpen: () => void }
}) => (
  <>
    {sync && <SyncFromSourceButton label={label} sourceName={sync.sourceName} onOpen={sync.onOpen} />}
    {space?.kind === 'team' && onMembersOpen && (
      <WorkshopButton
        className={SPACE_ACTION_CLASS_NAME}
        aria-label={`Members of ${label}`}
        onClick={() => onMembersOpen(space.key)}
      >
        <UsersThree size={13} />
        Members
      </WorkshopButton>
    )}
    {(!space || space.kind === 'team' || isOwnPersonalSpace(space)) && (
      <Link
        to="/"
        search={space?.kind === 'team' ? { space: space.key } : {}}
        aria-label={`New workspace in ${label}`}
        className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-base px-2.5 text-[12px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-elevated"
      >
        <Plus size={12} weight="bold" />
        New workspace
      </Link>
    )}
  </>
)
