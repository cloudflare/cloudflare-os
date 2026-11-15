import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ConnectionPane } from '@/connections/ConnectionPane'

/** One connected account, on a page of its own: opened from the Gatekeepers page, which is where going back goes. */
export const Route = createFileRoute('/_app/gatekeepers_/$accountId')({
  component: GatekeeperPage,
})

function GatekeeperPage() {
  const { accountId } = Route.useParams()
  const navigate = useNavigate()
  return <ConnectionPane key={accountId} accountId={Number(accountId)} onBack={() => navigate({ to: '/gatekeepers' })} />
}
