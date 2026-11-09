import type { Ref } from 'react'
import { Link } from '@tanstack/react-router'
import { Plus, UsersThree } from '@phosphor-icons/react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'

/** The size of the small buttons a space's heading and status lines carry. */
export const SPACE_ACTION_CLASS_NAME = '!h-7 gap-1.5 !px-2.5 !text-[12px]'

/** The `New space` button of a space's entry points, for the screen that shows the dialog it asks for. */
export type NewSpaceEntry = {
  /** The user asked for a space inside this one. */
  onOpen: () => void
  /** The button, which takes the focus back when the dialog is dismissed (`useNewSpaceDialog`). */
  buttonRef: Ref<HTMLButtonElement>
}

/**
 * The entry points beside a space's name: to a team space's members, to a space inside the
 * space, and to a workspace in it. A personal space has no members besides its owner, so it
 * offers no members. `Members` and `New space` only ask: the screen that shows the space holds
 * the dialogs, which outlast a list that renders these buttons again.
 */
export const SpaceEntryPoints = ({ label, space, onMembersOpen, newSpace }: {
  /** What the space is called where these are shown, which names the entry points. */
  label: string
  /**
   * Undefined for the user's personal space while the list of spaces does not have it: a new
   * workspace goes there all the same.
   */
  space: SpaceInfo | undefined
  /** Offers a team space's members, where the caller shows them. */
  onMembersOpen?: (spaceId: string) => void
  /** Offers a new space inside this one, where the user may create one: the caller decides by their role. */
  newSpace?: NewSpaceEntry
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
    {newSpace && (
      <WorkshopButton
        ref={newSpace.buttonRef}
        className={SPACE_ACTION_CLASS_NAME}
        aria-label={`New space in ${label}`}
        onClick={newSpace.onOpen}
      >
        New space
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
