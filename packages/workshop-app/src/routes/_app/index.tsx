import { useMemo, useState } from 'react'
import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { WorkspacePicker } from '@/blocks/WorkspacePicker'
import { greeting } from '@/chat/greeting'
import { NewChatPane } from '@/chat/NewChatPane'
import { skillCommandOf } from '@/chat/slashCommands'
import { startConversation } from '@/chat/startConversation'
import { useApi } from '@/rpc/ApiContext'
import { isNamedWorkspace } from '@/workspaces/workspaceKind'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'

/**
 * The start of a new conversation: on its own, in a workspace of its own that sending the first
 * message creates, or in one of the user's named workspaces, as the picker under the composer
 * says. A skill chosen to use elsewhere (`useSkill`) is what the draft starts with.
 */
export const Route = createFileRoute('/_app/')({
  component: Home,
})

function Home() {
  const { api, user } = useApi()
  const navigate = useNavigate()
  const location = useLocation()
  const skill = location.state.useSkill
  const workspaces = useWorkspaces()
  // Where the chat goes: a named workspace, or none.
  const [where, setWhere] = useState<string>()
  // Those the user works in, starred first: not one only an app of was shared with them.
  const named = useMemo(() => (workspaces.status === 'ready' ? workspaces.workspaces : [])
    .filter((workspace) => isNamedWorkspace(workspace) && workspace.role !== 'use')
    .toSorted((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.title.localeCompare(b.title))
    .map(({ id, title }) => ({ id, title, label: workspaceLabel(title) })), [workspaces])
  // One that has gone meanwhile is no longer where it goes.
  const into = named.some(({ id }) => id === where) ? where : undefined

  return (
    <NewChatPane
      // A skill chosen again starts the draft again.
      key={location.state.key}
      greeting={greeting(user.name)}
      initialCommand={skill && skillCommandOf(skill, skill.source)}
      start={(text, files, modelId, command) => startConversation(() => (into ? api.openWorkspace(into) : api.newWorkspace()), text, files, modelId, command)}
      onStarted={({ workspaceId, chatId }) => navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId } })}
      below={<WorkspacePicker workspaces={named} value={into} onChange={setWhere} onCreate={() => void navigate({ to: '/workspaces/new' })} />}
    />
  )
}
