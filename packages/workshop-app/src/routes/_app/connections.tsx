import { createFileRoute } from '@tanstack/react-router'
import { ConnectionsPane } from '@/connections/ConnectionsPane'

/** The services the app can use on the user's behalf: those connected, and those that could be. */
export const Route = createFileRoute('/_app/connections')({
  component: ConnectionsPane,
})
