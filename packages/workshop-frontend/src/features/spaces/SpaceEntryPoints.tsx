import { Link } from '@tanstack/react-router'
import { Plus, UsersThree } from '@phosphor-icons/react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'

/** The size of the small buttons a space's heading and status lines carry. */
export const SPACE_ACTION_CLASS_NAME = '!h-7 gap-1.5 !px-2.5 !text-[12px]'

/**
 * The entry points beside a space's name: to a team space's members, and to a new workspace in
 * the space. A personal space has no members besides its owner, so it offers no members.
 */
export const SpaceEntryPoints = ({ label, space, onMembersOpen }: {
  /** What the space is called where these are shown, which names the two entry points. */
  label: string
  /**
   * Undefined for the user's personal space while the list of spaces does not have it: a new
   * workspace goes there all the same.
   */
  space: SpaceInfo | undefined
  /** Offers a team space's members, where the caller shows them. */
  onMembersOpen?: (spaceId: string) => void
}) => (
  <>
    {space?.kind === 'team' && onMembersOpen && (
      <WorkshopButton
        className={SPACE_ACTION_CLASS_NAME}
        aria-label={`Members of ${label}`}
        onClick={() => onMembersOpen(space.id)}
      >
        <UsersThree size={13} />
        Members
      </WorkshopButton>
    )}
    <Link
      to="/"
      search={space?.kind === 'team' ? { space: space.id } : {}}
      aria-label={`New workspace in ${label}`}
      className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-base px-2.5 text-[12px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-elevated"
    >
      <Plus size={12} weight="bold" />
      New workspace
    </Link>
  </>
)
