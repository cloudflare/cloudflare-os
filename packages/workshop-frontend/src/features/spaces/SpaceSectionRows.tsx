import type { GadgetListRows } from '../../components/GadgetList'
import type { WorkspaceSection } from './groupWorkspaces'
import { ListedWorkspaceRow } from './ListedWorkspaceRow'

// What a section with no rows says, once there is nothing left to wait for.
const emptyLine = (section: WorkspaceSection) => {
  switch (section.kind) {
    case 'personal': return 'No workspaces in your personal space yet.'
    case 'space': return section.listing === 'ready' ? 'No workspaces in this space yet.' : null
    default: return null
  }
}

/** The rows of one section, then one line when it has none and nothing is left to wait for. */
export const SpaceSectionRows = ({ section, renderRow }: {
  section: WorkspaceSection
  /** The list's own row for a workspace in the user's list, keyed. */
  renderRow: GadgetListRows['renderRow']
}) => {
  const empty = section.rows.length === 0 ? emptyLine(section) : null

  return (
    <>
      {section.rows.map(row => (row.kind === 'record'
        ? renderRow(row.gadget)
        : <ListedWorkspaceRow key={row.id} workspace={row.workspace} />))}

      {empty && <p className="px-3 py-2 text-[13px] leading-[18px] text-kumo-inactive">{empty}</p>}
    </>
  )
}
