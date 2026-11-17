import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { itemPage } from '@/aside/asideItems'
import { LibraryPane } from '@/library/LibraryPane'

/**
 * The library: everything the user can open, from all their workspaces, each opening as its own
 * page. `?tab=` names the tab that is showing: the starred, all of it, or a type's.
 */
export const Route = createFileRoute('/_app/library/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({ tab: typeof search.tab === 'string' && search.tab !== '' ? search.tab : undefined }),
  component: Library,
})

// Listed outputs are what was made, so one with no format is an app.
const page = ({ workspaceId, workpieceId, output }: OutputSummary) => itemPage(workspaceId, { kind: 'output', workpieceId }, !output)

function Library() {
  const { tab } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <LibraryPane
      tab={tab}
      // In place, so that going back leaves the library rather than going through its tabs.
      onTabChange={(next) => navigate({ to: '/library', search: { tab: next }, replace: true })}
      onOpenOutput={(output) => navigate({ ...page(output), state: { fromLibrary: true } })}
      outputHref={(output) => router.buildLocation(page(output)).href}
      onOpenWorkspace={({ workspaceId }) => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } })}
      workspaceHref={({ workspaceId }) => router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId } }).href}
      // Something is made by a chat started on the home page, which starts with the format asked for.
      onNew={(format) => navigate({ to: '/', search: { format: format?.id } })}
      onExplore={() => navigate({ to: '/library/templates' })}
    />
  )
}
