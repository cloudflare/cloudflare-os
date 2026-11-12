import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { itemPage } from '@/aside/asideItems'
import { LibraryPane } from '@/library/LibraryPane'

/** Everything the user can open, from all their workspaces. Each opens as its own page. */
export const Route = createFileRoute('/_app/library/')({
  component: Library,
})

// Listed outputs are what was made, so one with no format is an app.
const page = ({ workspaceId, workpieceId, output }: OutputSummary) => itemPage(workspaceId, { kind: 'output', workpieceId }, !output)

function Library() {
  const navigate = useNavigate()
  const router = useRouter()
  return <LibraryPane onOpenOutput={(output) => navigate(page(output))} outputHref={(output) => router.buildLocation(page(output)).href} />
}
