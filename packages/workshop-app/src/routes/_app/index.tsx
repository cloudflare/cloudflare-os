import { useState } from 'react'
import { createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { validateAsideParam } from '@/aside/asideItems'
import { rememberShown } from '@/aside/lastShown'
import { carryAside } from '@/aside/useAsideNavigation'
import { greeting } from '@/chat/greeting'
import { ChatHeader } from '@/blocks/ChatHeader'
import { NEW_CHAT_TITLE, NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { startableFormats, useOutputFormats } from '@/library/useOutputFormats'
import { useApi } from '@/rpc/ApiContext'
import { UpdateNotice } from '@/settings/admin/UpdateNotice'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceTitle } from '@/workspaces/workspaceList'

/** Where a new chat starts: in a workspace (`workspace`), with what is shown beside it (`open`), or in a new one. */
export type NewChatSearch = { format?: string; workspace?: string; open?: string }

/**
 * The start of a new conversation: in the workspace `?workspace=` names, which the picker under
 * the composer changes in place, or else in a new workspace, which sending the first message
 * creates with it. What is shown beside it (`?open=`) is the workspace's, and stays beside the
 * chat. `?format=` is what the first message asks for something as, by the format's id
 * (`document`), as the library's New menu starts one.
 */
export const Route = createFileRoute('/_app/')({
  validateSearch: (search: Record<string, unknown>): NewChatSearch => {
    const workspace = typeof search.workspace === 'string' && search.workspace !== '' ? search.workspace : undefined
    return {
      format: typeof search.format === 'string' ? search.format : undefined,
      workspace,
      // Only a workspace has anything to show beside it.
      open: workspace === undefined ? undefined : validateAsideParam(search.open),
    }
  },
  component: Home,
})

function Home() {
  const { api, user } = useApi()
  const navigate = useNavigate()
  const { format: formatId, workspace: namedId, open } = Route.useSearch()
  // Written in the composer as the page opens, where the page before had something to ask for.
  const draft = useRouterState({ select: ({ location }) => location.state.draft })
  // Started from a gadget's page, beside the gadget, it is greeted by the gadget's name.
  const about = useRouterState({ select: ({ location }) => (open ? location.state.gadgetTitle : undefined) })
  // One the deployment does not offer starts nothing.
  const format = startableFormats(useOutputFormats(formatId !== undefined)).find(({ id }) => id === formatId)
  const workspaces = useWorkspaces()
  const looks = useWorkspaceLooks()
  // Those a chat can be started in, which one the user may only use is not.
  const startable = workspaces.status === 'ready' ? workspaces.workspaces.filter(({ role }) => role !== 'use') : []
  // One that is not listed is not chosen, so what the page says is what sending does. Until the
  // list is read, the one named is taken at its word, so that a message sent meanwhile goes there.
  const startsIn = workspaces.status === 'loading' || startable.some(({ id }) => id === namedId) ? namedId : undefined
  const chosen = startable.find(({ id }) => id === startsIn)
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
  // With none to choose, there is nothing to pick but a new workspace, so it is left out. Kept
  // while the list loads, so that it does not pop in under the composer for whoever has some,
  // unless one is named, which it could not say the title of until then.
  const offersChoice = workspaces.status === 'loading' ? namedId === undefined : startable.length > 0
  // As the chat's will be, in the workspace it starts in; a new one is named once it is listed.
  const chatHeader = (
    <ChatHeader
      workspace={chosen && {
        id: chosen.id,
        title: workspaceTitle(chosen),
        label: workspaceLabel(chosen.title),
        look: looks[chosen.id],
        // What is shown beside the chat to be stays beside the workspace.
        onOpen: () => navigate({ to: '/workspace/$workspaceId', params: { workspaceId: chosen.id }, search: { open: carryAside(open, { workspaceId: chosen.id }) } }),
      }}
      title={NEW_CHAT_TITLE}
    />
  )
  return (
    <NewChatPane
      // In a workspace, under it, as its chats are; otherwise a newer release of the deployment,
      // said to its admins where main's home page said it.
      header={chosen ? chatHeader : <UpdateNotice onOpen={() => navigate({ to: '/settings', search: { section: 'admin-updates' } })} />}
      sendingHeader={chatHeader}
      greeting={greeting(user.name, about)}
      format={format && { noun: format.noun, icon: format.icon, onRemove: () => navigate({ to: '/', search: (previous: NewChatSearch) => ({ ...previous, format: undefined }), replace: true }) }}
      // In place, so that the draft stays and going back does not step through each choice.
      // What was shown beside one workspace is not another's.
      workspace={offersChoice ? {
        workspaces: startable.map((workspace) => ({ id: workspace.id, title: workspaceTitle(workspace), label: workspaceLabel(workspace.title), look: looks[workspace.id] })),
        value: startsIn,
        onValueChange: (id) => navigate({ to: '/', search: (previous: NewChatSearch) => ({ ...previous, workspace: id, open: undefined }), replace: true }),
      } : undefined}
      initialText={draft}
      connectsIn={startIn}
      makeConnectable={makeConnectable}
      start={(text, files, modelId, command, formats, capsules) =>
        startConversation(() => (startIn === undefined ? api.newWorkspace() : api.openWorkspace(startIn)), text, files, modelId, command, formats, capsules)}
      // From a workspace, in its place, so that going back goes to where it was started from
      // rather than to an empty chat.
      onStarted={({ workspaceId, chatId }) => {
        if (open) rememberShown(workspaceId, chatId, open)
        return navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId }, search: { open }, state: { chatTitle: NEW_CHAT_TITLE }, replace: startsIn !== undefined })
      }}
    />
  )
}
