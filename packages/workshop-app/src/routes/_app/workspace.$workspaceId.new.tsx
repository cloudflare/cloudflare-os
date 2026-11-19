import { createFileRoute, redirect } from '@tanstack/react-router'
import { validateAsideParam } from '@/aside/asideItems'

/**
 * Where a new chat in a workspace used to be started. It is home's now, with the workspace chosen
 * (`/?workspace=`), so a link made before then goes there, with what it showed beside it.
 */
export const Route = createFileRoute('/_app/workspace/$workspaceId/new')({
  validateSearch: (search: Record<string, unknown>): { open?: string } => ({ open: validateAsideParam(search.open) }),
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: '/', search: { workspace: params.workspaceId, open: search.open }, replace: true })
  },
})
