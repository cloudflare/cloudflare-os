import { createFileRoute } from '@tanstack/react-router'
import { AutomationsPane } from '@/automations/AutomationsPane'

/** Everything set up to run by itself, across the workspaces the user builds in. */
export const Route = createFileRoute('/_app/automations')({
  component: AutomationsPane,
})
