import { createFileRoute } from '@tanstack/react-router'
import GadgetEditor from '../GadgetEditor'
import { validateWorkspaceSearch } from '../workspaceSearch'

const WorkspaceRoute = () => {
  const { id } = Route.useParams()
  return <GadgetEditor workspaceId={id} />
}

export const Route = createFileRoute('/workspace/$id')({
  component: WorkspaceRoute,
  validateSearch: validateWorkspaceSearch,
})
