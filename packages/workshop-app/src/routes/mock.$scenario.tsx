import { useEffect, useState, type ReactNode } from 'react'
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { asideItemFor, formatAsideRef, parseAsideRef } from '@/aside/asideItems'
import { AsidePane, EmptyAsidePane } from '@/aside/AsidePane'
import { useChatLibrary } from '@/aside/useChatLibrary'
import { ChatPane, type ChatPaneProps } from '@/chat/ChatPane'
import { ChatSettingsPane } from '@/chat/ChatSettingsPane'
import { ChatSessionsProvider } from '@/chat/ChatSessionsProvider'
import { MockControls } from '@/chat/mock/MockControls'
import { createMockApi, MOCK_WORKSPACE_ID } from '@/chat/mock/mockApi'
import type { Scenario } from '@/chat/mock/scenario'
import { SCENARIOS } from '@/chat/mock/scenarios'
import { SplitLayout } from '@/layouts/SplitLayout'
import { ApiContext } from '@/rpc/ApiContext'
import { WorkspacesProvider } from '@/workspaces/WorkspacesProvider'

/** One scripted chat: the real `ChatPane` over a fake backend, so it needs no server. */
export const Route = createFileRoute('/mock/$scenario')({
  loader: ({ params }) => {
    const scenario = SCENARIOS.find(({ id }) => id === params.scenario)
    if (!scenario) throw notFound()
    return scenario
  },
  component: MockRoute,
})

function MockRoute() {
  const scenario = Route.useLoaderData()
  const navigate = useNavigate()
  // Bumped to start the scenario again from its recorded history.
  const [attempt, setAttempt] = useState(0)

  return (
    <MockChat
      key={`${scenario.id}/${attempt}`}
      scenario={scenario}
      onSelectScenario={(id) => navigate({ to: '/mock/$scenario', params: { scenario: id } })}
      onOpenScenarios={() => navigate({ to: '/mock' })}
      onRestart={() => setAttempt((current) => current + 1)}
    />
  )
}

const MockChat = ({ scenario, onSelectScenario, onOpenScenarios, onRestart }: {
  scenario: Scenario
  onSelectScenario: (id: string) => void
  /** The list of scenarios stands in for the workspace's page, which the fake backend does not have. */
  onOpenScenarios: () => void
  onRestart: () => void
}) => {
  // Made once, so the callbacks handed to the chat stay the same.
  const [{ session, overseer, onSetUpConnection, onAlwaysApprove }] = useState(() => {
    const mock = createMockApi(scenario)
    return {
      ...mock,
      // What the real connect flow ends with, and what confirming a standing approval does.
      onSetUpConnection: (requestId: string) => mock.overseer.acceptConnectionRequest(requestId, { gatekeeperId: 1 }),
      onAlwaysApprove: ({ gatekeeperId, actionKind }: Parameters<NonNullable<ChatPaneProps['onAlwaysApprove']>>[0]) =>
        mock.overseer.setAutoApprovedActionKind(gatekeeperId, actionKind),
    }
  })

  useEffect(() => {
    overseer.player.play()
    return () => overseer.player.pause()
  }, [overseer])

  return (
    <ApiContext value={session}>
      <WorkspacesProvider>
        <ChatSessionsProvider>
          <MockLayout onOpenScenarios={onOpenScenarios} onSetUpConnection={onSetUpConnection} onAlwaysApprove={onAlwaysApprove}>
            <MockControls
              scenarios={SCENARIOS}
              scenario={scenario}
              player={overseer.player}
              onSelectScenario={onSelectScenario}
              onRestart={onRestart}
            />
          </MockLayout>
        </ChatSessionsProvider>
      </WorkspacesProvider>
    </ApiContext>
  )
}

const CHAT = { workspaceId: MOCK_WORKSPACE_ID, chatId: 0 }

/**
 * Laid out as the app lays out a chat, without the sidebar, so what it opens shows beside it. What
 * is shown is kept here rather than in the URL, which belongs to the scenario.
 */
const MockLayout = ({ onOpenScenarios, onSetUpConnection, onAlwaysApprove, children }: {
  onOpenScenarios: () => void
  onSetUpConnection: ChatPaneProps['onSetUpConnection']
  onAlwaysApprove: ChatPaneProps['onAlwaysApprove']
  /** Over the chat, such as the player's controls. */
  children: ReactNode
}) => {
  const [open, setOpen] = useState<string>()
  const named = parseAsideRef(open)
  // Had back before anything the chat has is known: open empty while the chat is read for it.
  const [askedEmpty, setAskedEmpty] = useState(false)
  if (askedEmpty && named) setAskedEmpty(false)
  const openedEmpty = askedEmpty && !named
  const library = useChatLibrary(CHAT, openedEmpty)
  const { items } = library
  const firstFound = openedEmpty ? items[0]?.key : undefined
  useEffect(() => {
    if (firstFound !== undefined) setOpen(firstFound)
  }, [firstFound])
  // The chat's settings, in the chat's place, with nothing beside them.
  const [settings, setSettings] = useState(false)
  // What is beside the chat, as a page of its own: the chat is gone meanwhile, as it is in the app.
  const [expanded, setExpanded] = useState(false)
  // Made once, so the chat's rows are not rendered again for them.
  const [handlers] = useState(() => ({
    onOpenAttachment: (file: { id: string }) => setOpen(formatAsideRef({ kind: 'file', fileId: file.id })),
    onOpenOutput: (output: { workpieceId: number }) => setOpen(formatAsideRef({ kind: 'output', workpieceId: output.workpieceId })),
    onFullScreenChange: () => {},
  }))

  return (
    <div className="flex h-full p-2">
      <SplitLayout
        asideAlone={expanded && named !== undefined}
        aside={!settings && openedEmpty ? (
          <EmptyAsidePane reading={library.reading} problem={library.problem} onRetry={library.retry} onHide={() => setAskedEmpty(false)} />
        ) : named && !settings && (expanded ? (
          <AsidePane
            placement="page"
            item={asideItemFor(CHAT.workspaceId, named, CHAT.chatId, items)}
            fullScreen={false}
            onFullScreenChange={handlers.onFullScreenChange}
            onCollapse={() => setExpanded(false)}
          />
        ) : (
          <AsidePane
            placement="beside"
            item={asideItemFor(CHAT.workspaceId, named, CHAT.chatId, items)}
            items={items}
            onSelect={setOpen}
            onHide={() => setOpen(undefined)}
            onExpand={() => setExpanded(true)}
            onFullScreenChange={handlers.onFullScreenChange}
          />
        ))}
        onOpenAside={!named && !settings && !openedEmpty ? () => (items.length > 0 ? setOpen(items[0].key) : setAskedEmpty(true)) : undefined}
        onCloseAside={() => {
          setOpen(undefined)
          setAskedEmpty(false)
        }}
        edgeInset={8}
      >
        <div className="relative flex min-h-0 flex-1 flex-col">
          {expanded && named ? null : settings ? (
            <ChatSettingsPane
              {...CHAT}
              onBack={() => setSettings(false)}
              onOpenWorkspace={onOpenScenarios}
              onOpenItem={(item) => {
                setOpen(item.key)
                setSettings(false)
              }}
            />
          ) : (
            <ChatPane
              {...CHAT}
              onOpenWorkspace={onOpenScenarios}
              onOpenSettings={() => setSettings(true)}
              onOpenAttachment={handlers.onOpenAttachment}
              onOpenOutput={handlers.onOpenOutput}
              onSetUpConnection={onSetUpConnection}
              onAlwaysApprove={onAlwaysApprove}
            />
          )}
          {children}
        </div>
      </SplitLayout>
    </div>
  )
}
