import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { LibraryPage, type LibraryTab } from '../pages/library/LibraryPage'

type LibrarySearch = {
  /** Which part of the library to show; Favorites when absent. */
  tab?: LibraryTab
}

const TABS: readonly LibraryTab[] = ['favorites', 'gadgets', 'files', 'skills', 'scheduled']

export const Route = createFileRoute('/library')({
  component: LibraryRoute,
  validateSearch: (search: Record<string, unknown>): LibrarySearch => ({
    // `apps` is what the Gadgets tab was once called, kept so old links still land there.
    tab: search.tab === 'apps' ? 'gadgets' : TABS.find(tab => tab === search.tab),
  }),
})

function LibraryRoute() {
  const navigate = useNavigate()
  const { tab } = Route.useSearch()
  return (
    <LibraryPage
      tab={tab ?? 'favorites'}
      onTabChange={next => navigate({ to: '/library', search: next === 'favorites' ? {} : { tab: next }, replace: true })}
    />
  )
}
