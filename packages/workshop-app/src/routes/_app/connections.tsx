import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ConnectionsPane } from '@/connections/ConnectionsPane'

/**
 * The services the app can use on the user's behalf: those connected, and those that could be.
 * `?open=` names a connection (its `key`) whose dialog is shown on arrival, as search goes to one.
 */
export const Route = createFileRoute('/_app/connections')({
  validateSearch: (search: Record<string, unknown>): { open?: string } => ({
    open: typeof search.open === 'string' && search.open !== '' ? search.open : undefined,
  }),
  component: Connections,
})

function Connections() {
  const { open } = Route.useSearch()
  const navigate = useNavigate()
  // In place, so that going back does not open it again.
  return <ConnectionsPane requested={open} onRequestHandled={() => void navigate({ to: '/connections', replace: true })} />
}
