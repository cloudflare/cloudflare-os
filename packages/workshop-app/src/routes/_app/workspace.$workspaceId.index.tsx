import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { carriedOpen, outputPage, outputSettings, validateAsideParam } from '@/aside/asideItems'
import { asideFor, carryAside, useAsideNavigation } from '@/aside/useAsideNavigation'
import { usePreferences } from '@/prefs/UserPreferencesContext'
import { WORKSPACE_TABS, WorkspacePane, type WorkspaceTab } from '@/workspaces/WorkspacePane'

const validateTab = (value: unknown): WorkspaceTab | undefined =>
  WORKSPACE_TABS.find((tab) => tab.value === value && value !== 'chats')?.value

/**
 * One workspace: its chats, or with `?tab=`, its agents, what it has made, what runs in it by
 * itself or who has access to it, and what is shown beside it (`?open=`, see `asideItems`), which
 * the frame lays out (`_app`). The old app's `?chat=`, which a notification opens, goes to that
 * chat's own page before this (`legacyTarget`). `?invite` asks for the dialog to invite people, which
 * search does, and is forgotten once it has been.
 */
export const Route = createFileRoute('/_app/workspace/$workspaceId/')({
  validateSearch: (search: Record<string, unknown>): { tab?: WorkspaceTab; open?: string; invite?: true } => ({
    tab: validateTab(search.tab),
    open: validateAsideParam(search.open),
    invite: search.invite === true || search.invite === 'true' ? true : undefined,
  }),
  component: Workspace,
})

function Workspace() {
  const { workspaceId } = Route.useParams()
  const { tab = 'chats', open, invite } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  const aside = useAsideNavigation()
  const preferences = usePreferences()
  return (
    <WorkspacePane
      // Keyed, so each workspace loads its own chats rather than showing the previous one's.
      key={workspaceId}
      workspaceId={workspaceId}
      tab={tab}
      // In place, so that going back leaves the workspace rather than going through its tabs.
      onTabChange={(next) =>
        navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: next === 'chats' ? undefined : next, open }, replace: true })
      }
      // What is shown beside the workspace stays beside the chat, so that it is there from one
      // chat to the next; otherwise the chat has what was last shown beside it.
      onOpenChat={({ id, title }) =>
        navigate({
          to: '/workspace/$workspaceId/chat/$chatId',
          params: { workspaceId, chatId: id },
          search: { open: carryAside(preferences, open, { workspaceId, chatId: id }) ?? asideFor(preferences, { workspaceId, chatId: id }) },
          state: { chatTitle: title },
        })
      }
      chatHref={(id) => router.buildLocation({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId: id } }).href}
      onOpenAgent={({ key }) => navigate({ to: '/workspace/$workspaceId/agent/$agentKey', params: { workspaceId, agentKey: key } })}
      agentHref={({ key }) => router.buildLocation({ to: '/workspace/$workspaceId/agent/$agentKey', params: { workspaceId, agentKey: key } }).href}
      onOpenItem={(item) => aside.show(item.key, { workspaceId })}
      itemHref={(item) => router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'library', open: item.key } }).href}
      outputHref={(output) => router.buildLocation(outputPage(output)).href}
      onOpenSettings={(output) => navigate(outputSettings(output))}
      onOpenOutput={(output) => navigate(outputPage(output))}
      onOpenLibrary={() => navigate({ to: '/library' })}
      inviteRequested={invite === true}
      // In place, with the rest of the address as it was, so that going back does not ask again.
      onInviteHandled={() => navigate({ to: '.', search: (previous: Record<string, unknown>) => ({ ...previous, invite: undefined }), replace: true })}
      onNewChat={(draft) => navigate({ to: '/', search: { workspace: workspaceId, open: carriedOpen(open) }, state: draft === undefined ? undefined : { draft } })}
      // Its own address, whole, as it is copied to be opened elsewhere.
      link={new URL(router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId } }).href, window.location.origin).href}
      // Deleted, or out of the viewer's list, it is left for home, as there is nothing here to go back to.
      onRemoved={() => navigate({ to: '/' })}
    />
  )
}
