import { useMemo, useState } from 'react'
import { createFileRoute, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { pageOf } from '@/aside/asideItems'
import { ChatHeader } from '@/blocks/ChatHeader'
import { WorkspacePicker } from '@/blocks/WorkspacePicker'
import { FeaturedBlueprints } from '@/blueprints/FeaturedBlueprints'
import { greeting } from '@/chat/greeting'
import { NEW_CHAT_TITLE, NewChatPane } from '@/chat/NewChatPane'
import { RecentGadgets } from '@/library/RecentGadgets'
import { skillCommandOf } from '@/chat/slashCommands'
import { startConversation } from '@/chat/startConversation'
import { useProfile } from '@/profile/ProfileContext'
import { startableFormats, useOutputFormats } from '@/library/useOutputFormats'
import { useApi } from '@/rpc/ApiContext'
import { isNamedWorkspace, UNTITLED_WORKSPACE } from '@/workspaces/workspaceKind'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceTitle } from '@/workspaces/workspaceList'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'

/**
 * The start of a new conversation: in a new workspace, which sending the first message creates
 * with it, named as the chat is once its title is written (the server titles an untitled
 * workspace after its first chat), unless one of the user's named workspaces has been chosen for it under the composer
 * (`WorkspacePicker`). A skill chosen to use elsewhere (`useSkill`) is what the draft starts with;
 * `?format=` is what the first message asks for something as, by the format's id (`document`), as
 * the library's New menu starts one. Further down, the gadgets lately worked on, or a few of the
 * blueprints the deployment features to start one from.
 */
export const Route = createFileRoute('/_app/')({
  validateSearch: (search: Record<string, unknown>): { format?: string } => ({ format: typeof search.format === 'string' ? search.format : undefined }),
  component: Home,
})

// What a workspace started with its chat is called until the chat is titled, and its crumb meanwhile.
const NEW_WORKSPACE = { id: 'new', title: UNTITLED_WORKSPACE, label: workspaceLabel(UNTITLED_WORKSPACE), onOpen: () => {} }

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
  // A skill chosen again starts the draft again, by the history entry it was chosen in; kept as it
  // was while the page is left, or the page would start again, greeting and all, on its way out.
  const [draftKey, setDraftKey] = useState(location.state.key)
  if (location.pathname === '/' && location.state.key !== draftKey) setDraftKey(location.state.key)
  const workspaces = useWorkspaces()
  const looks = useWorkspaceLooks()
  // Where the chat goes: one of the user's named workspaces, or a new one. It lasts for the visit.
  const [where, setWhere] = useState<string>()
  // Those the user may chat in, starred first, then as listed: not one only an app of was shared
  // with them, nor a chat on its own.
  const named = useMemo(() => (workspaces.status === 'ready' ? workspaces.workspaces : [])
    .filter((workspace) => isNamedWorkspace(workspace) && workspace.role !== 'use')
    .toSorted((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
    .map((workspace) => ({ id: workspace.id, title: workspaceTitle(workspace), label: workspaceLabel(workspace.title), look: looks[workspace.id] })), [workspaces, looks])
  // One that is no longer listed is not chosen, so what the page says is what sending does.
  const chosen = named.find(({ id }) => id === where)
  const into = chosen?.id

  const { format: formatId } = Route.useSearch()
  // One the deployment does not offer starts nothing.
  const format = startableFormats(useOutputFormats(formatId !== undefined)).find(({ id }) => id === formatId)
  return (
    <NewChatPane
      key={draftKey}
      greeting={greeting(user.name)}
      initialCommand={skill && skillCommandOf(skill, skill.source)}
      format={format && { noun: format.noun, icon: format.icon, onRemove: () => navigate({ to: '/', replace: true }) }}
      start={(text, files, modelId, command, formats) => startConversation(() => (into ? api.openWorkspace(into) : api.newWorkspace({ kind: 'workspace' })), text, files, modelId, command, formats)}
      // Under the header the chat will have, which it opens under with the message where it was.
      // A new one is named, so it has a crumb too: as the server calls it until the chat is titled.
      startedHeader={<ChatHeader workspace={chosen ? { ...chosen, onOpen: () => navigate({ to: '/workspace/$workspaceId', params: { workspaceId: chosen.id } }) } : NEW_WORKSPACE} title={NEW_CHAT_TITLE} />}
      onStarted={({ workspaceId, chatId }, sent) =>
        navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId }, state: { chatTitle: NEW_CHAT_TITLE, sending: sent } })}
      below={<WorkspacePicker workspaces={named} value={into} onValueChange={setWhere} />}
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
