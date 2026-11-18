import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { greeting } from '@/chat/greeting'
import { NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { pickStarterTasks } from '@/chat/starterTasks'
import { startableFormats, useOutputFormats } from '@/library/useOutputFormats'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceTitle } from '@/workspaces/workspaceList'

/**
 * The start of a new conversation: in a new workspace, which sending the first message creates
 * with it, unless one there already is has been chosen for it under the composer.
 * `?format=` is what the first message asks for something as, by the format's id (`document`), as
 * the library's New menu starts one. Under it are a few things to start with, chosen for the
 * visit, but for one that starts with a format, as each says what it makes.
 */
export const Route = createFileRoute('/_app/')({
  validateSearch: (search: Record<string, unknown>): { format?: string } => ({ format: typeof search.format === 'string' ? search.format : undefined }),
  component: Home,
})

function Home() {
  const { api, user } = useApi()
  const navigate = useNavigate()
  const { format: formatId } = Route.useSearch()
  // One the deployment does not offer starts nothing.
  const format = startableFormats(useOutputFormats(formatId !== undefined)).find(({ id }) => id === formatId)
  const workspaces = useWorkspaces()
  const looks = useWorkspaceLooks()
  const [chosenId, setChosenId] = useState<string>()
  // Chosen once, or they would change under the pointer.
  const [starters] = useState(() => pickStarterTasks())
  // Those a chat can be started in, which one the user may only use is not.
  const startable = workspaces.status === 'ready' ? workspaces.workspaces.filter(({ role }) => role !== 'use') : []
  // One that is no longer listed is not chosen, so what the page says is what sending does.
  const startsIn = startable.some(({ id }) => id === chosenId) ? chosenId : undefined
  return (
    <NewChatPane
      greeting={greeting(user.name)}
      format={format && { noun: format.noun, icon: format.icon, onRemove: () => navigate({ to: '/', replace: true }) }}
      workspace={{
        workspaces: startable.map((workspace) => ({ id: workspace.id, title: workspaceTitle(workspace), label: workspaceLabel(workspace.title), look: looks[workspace.id] })),
        value: startsIn,
        onValueChange: setChosenId,
      }}
      starters={format ? undefined : starters}
      start={(text, files, modelId, command, formats) =>
        startConversation(() => (startsIn === undefined ? api.newWorkspace() : api.openWorkspace(startsIn)), text, files, modelId, command, formats)}
      onStarted={({ workspaceId, chatId }) => navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId } })}
    />
  )
}
