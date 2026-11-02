import { Link } from '@tanstack/react-router'
import { Plus, UsersThree } from '@phosphor-icons/react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'
import { isOwnPersonalSpace } from './spaceKinds'

/** The size of the small buttons a space's heading and status lines carry. */
export const SPACE_ACTION_CLASS_NAME = '!h-7 gap-1.5 !px-2.5 !text-[12px]'

/**
 * The entry points beside a space's name: to its members, and to a new workspace in it. Only its
 * owner adds workspaces to a personal space, so another person's offers no new workspace.
 */
export const SpaceEntryPoints = ({ label, space, onMembersOpen }: {
  /** What the space is called where these are shown, which names the two entry points. */
  label: string
  /**
   * Undefined for the user's own personal space while the list of spaces does not have it: there
   * is nothing to open the members of, and a new workspace goes there all the same.
   */
  space: SpaceInfo | undefined
  onMembersOpen: (spaceKey: string) => void
}) => (
  <>
    {space && (
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
