import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ConnectionsPane } from '@/connections/ConnectionsPane'

/** The services the user has connected, and those they can (the sidebar's connect button). */
export const Route = createFileRoute('/_app/connections')({
  component: ConnectionsPage,
})

function ConnectionsPage() {
  const navigate = useNavigate()
  return <ConnectionsPane onOpenAccount={(accountId) => navigate({ to: '/connections/$accountId', params: { accountId: String(accountId) } })} />
}
