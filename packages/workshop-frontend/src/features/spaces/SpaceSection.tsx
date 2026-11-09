import { useId } from 'react'
import { Link } from '@tanstack/react-router'
import type { GadgetListRows } from '../../components/GadgetList'
import { sectionTitle, type WorkspaceSection } from './groupWorkspaces'
import { SpaceEntryPoints, type NewSpaceEntry } from './SpaceEntryPoints'
import { SpaceSectionRows } from './SpaceSectionRows'
import { SubspaceCards } from './SubspaceCards'
import type { SubspaceListing } from './useSubspaces'

/** The sub-spaces of the user's personal space, for the Personal section. */
export type PersonalSubspaces = {
  /** As last read (`useSubspaces`). */
  listing: SubspaceListing
  /** Reads them again, resolving once the read has settled either way. */
  onReload: () => Promise<void>
  /** The user asked for the members of the sub-space with this id. */
  onMembersOpen: (spaceId: string) => void
  /** A `Try again` went and nothing of the cards is left to take the focus it had. */
  onFocusLost: () => void
  /** Offers a space inside the personal space (see `SpaceEntryPoints`). */
  newSpace: NewSpaceEntry
}

/**
 * One section of the workspaces page that is not a team space's (those are cards, see
 * `SpaceCard`): its heading, which for the personal space links to the space's own page and
 * carries the entry points to a space inside it and to a workspace in it, then its rows. The
 * personal section shows the sub-spaces of the personal space as cards between the two.
 */
export const SpaceSection = (props: {
  /** The list's own row for a workspace in the user's list, keyed. */
  renderRow: GadgetListRows['renderRow']
} & (
  | {
      section: Extract<WorkspaceSection, { kind: 'personal' }>
      /**
       * Shown as cards between the heading and the rows, with the `New space` that makes one
       * beside the heading. Left out while the list of spaces has no personal space.
       */
      subspaces?: PersonalSubspaces
    }
  | { section: Extract<WorkspaceSection, { kind: 'elsewhere' | 'shared' }> }
)) => {
  const { section, renderRow } = props
  const headingId = useId()
  const title = sectionTitle(section)
  const subspaces = 'subspaces' in props ? props.subspaces : undefined

  return (
    <section aria-labelledby={headingId} className="flex shrink-0 flex-col gap-0.5 pb-5">
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-3">
        <h2 id={headingId} className="min-w-0 truncate text-[13px] leading-[18px] font-semibold tracking-[-0.25px] text-kumo-default">
          {section.kind === 'personal' && section.space
            ? (
                <Link
                  to="/spaces/$spaceId"
                  params={{ spaceId: section.space.id }}
                  className="hover:underline"
                >
                  {title}
                </Link>
              )
            : title}
        </h2>
        {section.kind === 'elsewhere' && (
          <p className="text-[12px] leading-4 text-kumo-subtle">
            Your workspaces in sub-spaces, and in spaces that are not in your list.
          </p>
        )}
        {section.kind === 'personal' && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <SpaceEntryPoints label={title} space={section.space} newSpace={subspaces?.newSpace} />
          </div>
        )}
      </div>

      {subspaces && (
        <SubspaceCards
          label={title}
          listing={subspaces.listing}
          onMembersOpen={subspaces.onMembersOpen}
          onReload={subspaces.onReload}
          onFocusLost={subspaces.onFocusLost}
        />
      )}
      <SpaceSectionRows section={section} renderRow={renderRow} />
    </section>
  )
}
