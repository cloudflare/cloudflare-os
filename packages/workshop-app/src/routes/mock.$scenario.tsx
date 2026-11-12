import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { useAsideState } from '@/aside/AsideContext'
import { AsidePane } from '@/aside/AsidePane'
import type { OutputItem } from '@/chat/chatItems'
import { ChatPane, type ChatPaneProps } from '@/chat/ChatPane'
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

  const aside = useAsideState()
  const { openOutput } = aside.actions
  const openChatOutput = useCallback((output: OutputItem) => openOutput({ workspaceId: MOCK_WORKSPACE_ID, chatId: 0 }, output), [openOutput])

  useEffect(() => {
    overseer.player.play()
    return () => overseer.player.pause()
  }, [overseer])

  return (
    <ApiContext value={session}>
      <WorkspacesProvider>
        {/* Laid out as the app lays out a page, without the sidebar, so what a chat opens shows beside it. */}
        <div className="flex h-full p-2">
          <SplitLayout
            aside={aside.shown && <AsidePane tabs={aside.tabs} fullScreen={aside.fullScreen} actions={aside.actions} />}
            asideFullScreen={aside.fullScreen}
            onOpenAside={aside.actions.show}
            onCloseAside={aside.actions.hide}
            edgeInset={8}
          >
            <div className="relative flex min-h-0 flex-1 flex-col">
              <ChatPane
                workspaceId={MOCK_WORKSPACE_ID}
                chatId={0}
                onOpenWorkspace={onOpenScenarios}
                onOpenAttachment={aside.actions.openFile}
                onOpenOutput={openChatOutput}
                onSetUpConnection={onSetUpConnection}
                onAlwaysApprove={onAlwaysApprove}
              />
              <MockControls
                scenarios={SCENARIOS}
                scenario={scenario}
                player={overseer.player}
                onSelectScenario={onSelectScenario}
                onRestart={onRestart}
              />
            </div>
          </SplitLayout>
        </div>
      </WorkspacesProvider>
    </ApiContext>
  )
}
