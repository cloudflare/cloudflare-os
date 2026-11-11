import { useEffect, useState } from 'react'
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { ChatPane } from '@/chat/ChatPane'
import { MockControls } from '@/chat/mock/MockControls'
import { createMockApi, MOCK_WORKSPACE_ID } from '@/chat/mock/mockApi'
import type { Scenario } from '@/chat/mock/scenario'
import { SCENARIOS } from '@/chat/mock/scenarios'
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
      onRestart={() => setAttempt((current) => current + 1)}
    />
  )
}

const MockChat = ({ scenario, onSelectScenario, onRestart }: {
  scenario: Scenario
  onSelectScenario: (id: string) => void
  onRestart: () => void
}) => {
  const [{ session, overseer }] = useState(() => createMockApi(scenario))

  useEffect(() => {
    overseer.player.play()
    return () => overseer.player.pause()
  }, [overseer])

  return (
    <ApiContext value={session}>
      <WorkspacesProvider>
        <div className="relative flex h-full flex-col bg-kumo-base">
          <ChatPane workspaceId={MOCK_WORKSPACE_ID} chatId={0} />
          <MockControls
            scenarios={SCENARIOS}
            scenario={scenario}
            player={overseer.player}
            onSelectScenario={onSelectScenario}
            onRestart={onRestart}
          />
        </div>
      </WorkspacesProvider>
    </ApiContext>
  )
}
