import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { LibraryPage, type LibraryTab } from '../pages/library/LibraryPage'

type LibrarySearch = {
  /** Which part of the library to show; Favorites when absent. */
  tab?: LibraryTab
}

const TABS: readonly LibraryTab[] = ['favorites', 'apps', 'files']

export const Route = createFileRoute('/library')({
  component: LibraryRoute,
  validateSearch: (search: Record<string, unknown>): LibrarySearch => ({
    tab: TABS.find(tab => tab === search.tab),
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
