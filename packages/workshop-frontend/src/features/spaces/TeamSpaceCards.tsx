import { useId } from 'react'
import type { WorkspaceSection } from './groupWorkspaces'
import { TeamSpaceCard } from './TeamSpaceCard'

/**
 * The user's team spaces as cards under a heading of their own, side by side where the list is
 * wide enough for two and one under another where it is not.
 */
export const TeamSpaceCards = ({ sections, onMembersOpen, onListingReload }: {
  sections: Extract<WorkspaceSection, { kind: 'space' }>[]
  /** The user asked for the members of the space with this id. */
  onMembersOpen: (spaceId: string) => void
  /** Reads what a space lists again, resolving once the read has settled either way. */
  onListingReload: (spaceId: string) => Promise<void>
}) => {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex shrink-0 flex-col gap-1.5 pb-5">
      <h2
        id={headingId}
        className="flex min-h-9 items-center px-3 text-[13px] leading-[18px] font-semibold tracking-[-0.25px] text-kumo-default"
      >
        Team spaces
      </h2>
      {/* The columns follow the room the list has, of which the window's width says little: the
          sidebar and the page's margins take their share of it first. */}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-2 px-3">
        {sections.map(section => (
          <TeamSpaceCard
            key={section.space.id}
            section={section}
            onMembersOpen={onMembersOpen}
            onListingReload={onListingReload}
          />
        ))}
      </ul>
    </section>
  )
}
