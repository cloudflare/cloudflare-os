import { createFileRoute } from '@tanstack/react-router'
import ConnectHandoffPage from '../ConnectHandoffPage'

export const Route = createFileRoute('/connect/handoff')({
  component: ConnectHandoffPage,
})
