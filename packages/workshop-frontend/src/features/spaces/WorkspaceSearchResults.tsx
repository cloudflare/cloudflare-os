import { useId, useState } from 'react'
import type { GadgetListRows } from '../../components/GadgetList'
import { BusyButton } from './BusyButton'
import { matchingRows, sectionTitle, type WorkspaceSection } from './groupWorkspaces'
import { ListedWorkspaceRow } from './ListedWorkspaceRow'
import { useFocusAfterAction } from './lostFocus'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import { spaceLabel } from './spaceKinds'

/**
 * Every section's rows whose workspace's title matches the search, as one list in the order of
 * the sections, each described by which space it is in. A team space whose listing is still
 * being read or could not be read says so, since its workspaces are missing from the results.
 */
export const WorkspaceSearchResults = ({ sections, search, renderRow, onListingReload, onFocusLost }: {
  sections: WorkspaceSection[]
  /** The text workspaces are being searched for: not empty. */
  search: string
  renderRow: GadgetListRows['renderRow']
  /** Reads what a space lists again, resolving once the read has settled either way. */
  onListingReload: (spaceId: string) => Promise<void>
  /** `Try again` went, every space having been searched, and the focus it had went with it. */
  onFocusLost: () => void
}) => {
  const captionIdPrefix = useId()
  const [retrying, setRetrying] = useState(false)
  const retrySettled = useFocusAfterAction(onFocusLost)
  const results = sections.flatMap(section =>
    matchingRows(section.rows, search).map(row => ({ section, row })))
  const loading = sections.some(section => section.kind === 'space' && section.listing === 'loading')
  // The team spaces whose listing could not be read.
  const failed = sections.flatMap(section =>
    (section.kind === 'space' && section.listing === 'failed' ? [section.space] : []))

  const retry = async () => {
    setRetrying(true)
    try {
      await Promise.all(failed.map(space => onListingReload(space.id)))
    } finally {
      setRetrying(false)
      retrySettled()
    }
  }

  return (
    <>
      {failed.length > 0 && (
        <div role="alert" className="flex shrink-0 items-center gap-3 px-3 pb-2">
          <p className="text-[13px] leading-[18px] text-kumo-danger">
            Couldn’t search {failed.map(spaceLabel).join(', ')}.
          </p>
          <BusyButton
            className={`shrink-0 ${SPACE_ACTION_CLASS_NAME}`}
            aria-label="Try again to search every space"
            busy={retrying}
            onClick={() => void retry()}
          >
            Try again
          </BusyButton>
        </div>
      )}
      {/* The rows' titles are third-level headings, and the sections whose headings they come
          under are not on show: this one keeps them from following the page's own directly. */}
      {results.length > 0 && <h2 className="sr-only">Search results</h2>}
      {results.length > 0 && (
        <ul aria-label="Search results" className="flex shrink-0 flex-col gap-0.5">
          {results.map(({ section, row }) => {
            const captionId = `${captionIdPrefix}${row.id}`
            return (
              <li key={row.id}>
                <p id={captionId} className="px-3 pt-1.5 text-[12px] leading-4 text-kumo-subtle">
                  {sectionTitle(section)}
                </p>
                {row.kind === 'record'
                  ? renderRow(row.gadget, captionId)
                  : <ListedWorkspaceRow workspace={row.workspace} describedBy={captionId} />}
              </li>
            )
          })}
        </ul>
      )}
      {loading && (
        <p role="status" className="px-3 py-2 text-[13px] leading-[18px] text-kumo-inactive">
          Loading the workspaces of your spaces…
        </p>
      )}
      {results.length === 0 && !loading && (
        <div className="py-12 text-center text-sm text-kumo-inactive">
          {failed.length > 0
            ? 'No workspaces found, but the results may be incomplete.'
            : 'No workspaces found'}
        </div>
      )}
    </>
  )
}
