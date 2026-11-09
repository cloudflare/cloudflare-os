import { useEffect, type RefObject } from 'react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { takeLostFocus } from '../../features/spaces/lostFocus'
import { SpaceBreadcrumb } from '../../features/spaces/SpaceBreadcrumb'
import { SpaceEntryPoints, type NewSpaceEntry } from '../../features/spaces/SpaceEntryPoints'
import { spaceLabel } from '../../features/spaces/spaceKinds'
import { SPACE_ROLE_LABELS } from '../../features/spaces/spaceRoles'

/**
 * The head of a space's page: the way up, for a space that reports a parent; the space's name,
 * which takes the focus of a user who arrives with none; the role the space says the user
 * holds, or that it is their personal space; and the entry points to its members, to a space
 * inside it and to a workspace in it.
 */
export const SpaceHeader = ({ info, ancestors, headingRef, onMembersOpen, newSpace }: {
  /** The space as it reported itself (`Space.getInfo`): `role` is the role the user holds in it. */
  info: SpaceInfo
  /** The spaces it is inside, outermost first (`useSpaceAncestors`). Shown only when `info.parent` is set. */
  ancestors: SpaceInfo[]
  /** Set to the heading, for the page to give it the focus a control of the page lost. */
  headingRef: RefObject<HTMLHeadingElement | null>
  /** The user asked for the space's members. */
  onMembersOpen: () => void
  /** Offers a space inside this one (see `SpaceEntryPoints`). The page shows the dialog it asks for. */
  newSpace?: NewSpaceEntry
}) => {
  const label = spaceLabel(info)
  // The heading takes the focus of a user who arrives with none: the button that led here, in
  // a dialog or on a page that is gone, could not keep it.
  useEffect(() => takeLostFocus(headingRef.current), [headingRef])
  return (
    <header className="flex flex-col items-stretch gap-4 px-3 pb-3 pt-6 sm:flex-row sm:items-end sm:justify-between sm:pt-10">
      <div className="min-w-0">
        {/* Only a space that reports a parent keeps a line for the way up: a user who holds no
            role above is shown nothing that hints at a space above. */}
        {info.parent !== undefined && <SpaceBreadcrumb ancestors={ancestors} />}
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="truncate text-2xl font-semibold tracking-tight text-kumo-default"
        >
          {label}
        </h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          {info.kind === 'personal'
            ? 'Your personal space. Only you are in it.'
            : `Your role: ${SPACE_ROLE_LABELS[info.role]}`}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <SpaceEntryPoints label={label} space={info} onMembersOpen={onMembersOpen} newSpace={newSpace} />
      </div>
    </header>
  )
}
