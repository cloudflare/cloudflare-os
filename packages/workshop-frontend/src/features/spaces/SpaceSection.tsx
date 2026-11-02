import { useId, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { WorkspaceSection } from './groupWorkspaces'
import { SpaceEntryPoints } from './SpaceEntryPoints'
import { spaceLabel } from './spaceKinds'
import { SPACE_ROLE_LABELS } from './spaceRoles'
import { SpaceSectionRows } from './SpaceSectionRows'
import type { WorkspaceRowListing } from './workspaceAddress'

const sectionTitle = (section: WorkspaceSection) => {
  switch (section.kind) {
    case 'personal': return 'Personal'
    case 'space': return spaceLabel(section.space)
    case 'elsewhere': return 'In other spaces'
    case 'shared': return 'Shared with me'
  }
}

/**
 * One section of the grouped workspace list: its heading, which for a space links to the space's
 * own page and carries the entry points to its members and to a new workspace in it, then its
 * rows.
 */
export const SpaceSection = ({ section, renderRow, onMembersOpen, onListingReload }: {
  section: WorkspaceSection
  /** The list's own row for a workspace in the user's list, keyed. */
  renderRow: (gadget: GadgetMetadataWithTimestamps, listing?: WorkspaceRowListing) => ReactNode
  onMembersOpen: (spaceKey: string) => void
  /** Reads what the space lists again, resolving once the read has settled either way. */
  onListingReload: (spaceKey: string) => Promise<void>
}) => {
  const headingId = useId()
  const title = sectionTitle(section)
  const ofSpace = section.kind === 'personal' || section.kind === 'space'

  return (
    <section aria-labelledby={headingId} className="flex shrink-0 flex-col gap-0.5 pb-5">
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-3">
        <h2 id={headingId} className="min-w-0 truncate text-[13px] leading-[18px] font-semibold tracking-[-0.25px] text-kumo-default">
          {ofSpace && section.space
            ? (
                <Link
                  to="/spaces/$spaceKey"
                  params={{ spaceKey: section.space.key }}
                  className="hover:underline"
                >
                  {title}
                </Link>
              )
            : title}
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
        {ofSpace && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <SpaceEntryPoints label={title} space={section.space} onMembersOpen={onMembersOpen} />
          </div>
        )}
      </div>

      <SpaceSectionRows
        section={section}
        label={title}
        renderRow={renderRow}
        onListingReload={onListingReload}
      />
    </section>
  )
}
