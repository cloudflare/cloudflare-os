import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ConnectionPane } from '@/connections/ConnectionPane'

/** One connected account, on a page of its own: opened from the Connections page, which is where going back goes. */
export const Route = createFileRoute('/_app/connections_/$accountId')({
  component: ConnectionPage,
})

function ConnectionPage() {
  const { accountId } = Route.useParams()
  const navigate = useNavigate()
  return <ConnectionPane key={accountId} accountId={Number(accountId)} onBack={() => navigate({ to: '/connections' })} />
}
