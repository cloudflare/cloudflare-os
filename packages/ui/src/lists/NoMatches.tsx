import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import { EmptyState } from '../page/EmptyState'

export type NoMatchesProps = {
  /** What the list is of, plural ("chats"); left out, it says "Nothing matches". */
  noun?: string
  /** Drops the search and the filters (`useListView`'s `showAll`). */
  onShowAll: () => void
}

/** A list that has things, with none left by its search and filters, and the way to have them all back. */
export const NoMatches = ({ noun, onShowAll }: NoMatchesProps) => (
  <EmptyState
    size="section"
    tinted
    icon={MagnifyingGlassIcon}
    title={noun ? `No ${noun} match` : 'Nothing matches'}
    description="Try another search, or clear the filters to see everything again."
    actions={[{ label: 'Show all', onClick: onShowAll }]}
  />
)
