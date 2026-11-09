import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { BlueprintsPage, type BlueprintsTab } from '../pages/blueprints/BlueprintsPage'

type BlueprintsSearch = {
  /** Which blueprints to show; Featured when absent. */
  tab?: BlueprintsTab
}

export const Route = createFileRoute('/blueprints')({
  component: BlueprintsRoute,
  validateSearch: (search: Record<string, unknown>): BlueprintsSearch => ({
    tab: search.tab === 'yours' ? 'yours' : undefined,
  }),
})

function BlueprintsRoute() {
  const navigate = useNavigate()
  const { tab } = Route.useSearch()
  return (
    <BlueprintsPage
      tab={tab ?? 'featured'}
      onTabChange={next => navigate({ to: '/blueprints', search: next === 'featured' ? {} : { tab: next }, replace: true })}
    />
  )
}
