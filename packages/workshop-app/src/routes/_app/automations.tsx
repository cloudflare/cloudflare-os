import { createFileRoute } from '@tanstack/react-router'
import { AutomationsPane } from '@/automations/AutomationsPane'

/**
 * Everything set up to run by itself, across the workspaces the user builds in. `?q=` is what it
 * starts searched for, as a link to one automation asks, by its title.
 */
export const Route = createFileRoute('/_app/automations')({
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({ q: typeof search.q === 'string' && search.q !== '' ? search.q : undefined }),
  component: Automations,
})

function Automations() {
  const { q } = Route.useSearch()
  // Keyed, so that a link to another search starts over, as it is only what the list starts with.
  return <AutomationsPane key={q} query={q} />
}
