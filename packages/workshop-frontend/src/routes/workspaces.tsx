import { createFileRoute } from '@tanstack/react-router'
import { WorkspacesPage } from '../pages/workspaces/WorkspacesPage'

/** Every named workspace the user has; the sidebar's folder button opens it. */
export const Route = createFileRoute('/workspaces')({
  component: WorkspacesPage,
})
