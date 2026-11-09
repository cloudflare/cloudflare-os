import { useId } from 'react'
import { Link } from '@tanstack/react-router'
import type { GadgetListRows } from '../../components/GadgetList'
import { sectionTitle, type WorkspaceSection } from './groupWorkspaces'
import { SpaceEntryPoints } from './SpaceEntryPoints'
import { SpaceSectionRows } from './SpaceSectionRows'

/**
 * One section of the workspaces page that is not a team space's (those are cards, see
 * `TeamSpaceCard`): its heading, which for the personal space links to the space's own page and
 * carries the entry point to a new workspace in it, then its rows.
 */
export const SpaceSection = ({ section, renderRow }: {
  section: Exclude<WorkspaceSection, { kind: 'space' }>
  /** The list's own row for a workspace in the user's list, keyed. */
  renderRow: GadgetListRows['renderRow']
}) => {
  const headingId = useId()
  const title = sectionTitle(section)

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
            Your workspaces in spaces that are not in your list.
          </p>
        )}
        {section.kind === 'personal' && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <SpaceEntryPoints label={title} space={section.space} />
          </div>
        )}
      </div>

      <SpaceSectionRows section={section} renderRow={renderRow} />
    </section>
  )
}
