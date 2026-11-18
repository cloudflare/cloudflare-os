import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { greeting } from '@/chat/greeting'
import { NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { startableFormats, useOutputFormats } from '@/library/useOutputFormats'
import { useApi } from '@/rpc/ApiContext'
import { UpdateNotice } from '@/settings/admin/UpdateNotice'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceTitle } from '@/workspaces/workspaceList'

/**
 * The start of a new conversation: in a new workspace, which sending the first message creates
 * with it, unless one there already is has been chosen for it under the composer.
 * `?format=` is what the first message asks for something as, by the format's id (`document`), as
 * the library's New menu starts one.
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
  // Those a chat can be started in, which one the user may only use is not.
  const startable = workspaces.status === 'ready' ? workspaces.workspaces.filter(({ role }) => role !== 'use') : []
  // One that is no longer listed is not chosen, so what the page says is what sending does.
  const startsIn = startable.some(({ id }) => id === chosenId) ? chosenId : undefined
  // The new workspace it starts in, made before it is sent where a connection was added to it
  // first, which needs a workspace to be made in. Until it has a chat the backend leaves it out
  // of the list (a provisional workspace), so one that is never sent leaves nothing behind.
  const [made, setMade] = useState<string>()
  const makeConnectable = async () => {
    const overseer = api.newWorkspace()
    try {
      setMade((await overseer.getMetadata()).id)
    } finally {
      overseer[Symbol.dispose]()
    }
  }
  const startIn = startsIn ?? made
  return (
    <NewChatPane
      // A newer release of the deployment, said to its admins where main's home page said it.
      header={<UpdateNotice onOpen={() => navigate({ to: '/settings', search: { section: 'admin-updates' } })} />}
      greeting={greeting(user.name)}
      format={format && { noun: format.noun, icon: format.icon, onRemove: () => navigate({ to: '/', replace: true }) }}
      workspace={{
        workspaces: startable.map((workspace) => ({ id: workspace.id, title: workspaceTitle(workspace), label: workspaceLabel(workspace.title), look: looks[workspace.id] })),
        value: startsIn,
        onValueChange: setChosenId,
      }}
      connectsIn={startIn}
      makeConnectable={makeConnectable}
      start={(text, files, modelId, command, formats, capsules) =>
        startConversation(() => (startIn === undefined ? api.newWorkspace() : api.openWorkspace(startIn)), text, files, modelId, command, formats, capsules)}
      onStarted={({ workspaceId, chatId }) => navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId } })}
    />
  )
}
