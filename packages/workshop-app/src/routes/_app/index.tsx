import { useMemo, useState } from 'react'
import { createFileRoute, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { pageOf } from '@/aside/asideItems'
import { WorkspacePicker } from '@/blocks/WorkspacePicker'
import { FeaturedBlueprints } from '@/blueprints/FeaturedBlueprints'
import { greeting } from '@/chat/greeting'
import { NewChatPane } from '@/chat/NewChatPane'
import { RecentGadgets } from '@/library/RecentGadgets'
import { skillCommandOf } from '@/chat/slashCommands'
import { startConversation } from '@/chat/startConversation'
import { useProfile } from '@/profile/ProfileContext'
import { useApi } from '@/rpc/ApiContext'
import { isNamedWorkspace } from '@/workspaces/workspaceKind'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'

/**
 * The start of a new conversation: on its own, in a workspace of its own that sending the first
 * message creates, or in one of the user's named workspaces, as the picker under the composer
 * says. A skill chosen to use elsewhere (`useSkill`) is what the draft starts with. Further down, a
 * few of the blueprints the deployment features, to start a gadget from instead.
 */
export const Route = createFileRoute('/_app/')({
  component: Home,
})

const blueprintPage = (blueprintId: string) => ({ to: '/blueprints/$blueprintId', params: { blueprintId } }) as const
const allBlueprints = { to: '/library', search: { tab: 'blueprints' } } as const
const library = { to: '/library', search: { tab: 'gadgets' } } as const

function Home() {
  const { api } = useApi()
  // As renamed on the profile page, at once.
  const { user } = useProfile().snapshot
  const navigate = useNavigate()
  const router = useRouter()
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
      after={(
        <RecentGadgets
          onOpen={(entry) => navigate(pageOf(entry.workspaceId, entry.item))}
          href={(entry) => router.buildLocation(pageOf(entry.workspaceId, entry.item)).href}
          onBrowse={() => navigate(library)}
          browseHref={router.buildLocation(library).href}
          fewer={(
            <FeaturedBlueprints
              onOpen={(blueprintId) => navigate(blueprintPage(blueprintId))}
              href={(blueprintId) => router.buildLocation(blueprintPage(blueprintId)).href}
              onBrowse={() => navigate(allBlueprints)}
              browseHref={router.buildLocation(allBlueprints).href}
            />
          )}
        />
      )}
    />
  )
}
