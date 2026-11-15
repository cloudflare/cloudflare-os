import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ConnectionsPane } from '@/connections/ConnectionsPane'

/** The services the user has connected, and those they can (the sidebar's connect button). */
export const Route = createFileRoute('/_app/gatekeepers')({
  component: GatekeepersPage,
})

function GatekeepersPage() {
  const navigate = useNavigate()
  return <ConnectionsPane onOpenAccount={(accountId) => navigate({ to: '/gatekeepers/$accountId', params: { accountId: String(accountId) } })} />
}
