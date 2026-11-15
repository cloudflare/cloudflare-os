import { CaretLeftIcon } from '@phosphor-icons/react'
import { AgentView } from '@/blocks/AgentView'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { groupByTime } from '@/chat/timeGroups'
import { useModels } from '@/chat/useModels'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useLibrary } from '@/library/useLibrary'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useChatThreads } from '@/workspaces/WorkspacesContext'
import type { AutomationLink } from './AutomationsTab'
import { useAgents } from './useAgents'

export type AgentPaneProps = {
  workspaceId: string
  /** Its connection. */
  agentId: number
  /** Where its gadgets, chats and runs open. */
  link: AutomationLink
  onBack: () => void
}

/**
 * An agent's page (`AgentView`), opened from Automations: renamed, and its model changed, through
 * `updateAgentSpawner`; the gadgets and chats that call on it, by name; and its runs, by when.
 */
export const AgentPane = ({ workspaceId, agentId, link, onBack }: AgentPaneProps) => {
  const { api } = useApi()
  const connection = useConnectionNotice()
  const { state, reload } = useAgents([workspaceId])
  const agent = state.status === 'ready' ? state.agents.find(({ id }) => id === agentId) : undefined
  const { models } = useModels()
  const library = useLibrary(agent && agent.gadgetIds.length > 0 ? 'automations' : null)
  const chats = useChatThreads()
  useDocumentTitle(agent?.name ?? 'Agent')

  const header = (
    <HeaderBubble>
      <Button icon={CaretLeftIcon} onClick={onBack}>Back</Button>
    </HeaderBubble>
  )

  if (!agent) {
    return (
      <PageLayout header={header}>
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 pt-16 text-center">
          {state.status === 'loading' && <p role="status" className="appears-late text-base text-kumo-subtle">Loading the agent…</p>}
          {state.status === 'failed' && <p className="text-base text-kumo-subtle">Couldn’t load the agent: {state.message}</p>}
          {state.status === 'ready' && <p className="text-base text-kumo-subtle">This agent isn’t here anymore.</p>}
        </div>
      </PageLayout>
    )
  }

  const update = async (change: { displayName?: string; modelId?: string }) => {
    if (connection?.blocked()) return
    const overseer = api.openWorkspace(workspaceId)
    try {
      await overseer.updateAgentSpawner(agentId, { displayName: agent.name, modelId: agent.modelId, ...change })
    } finally {
      overseer[Symbol.dispose]()
    }
    reload()
  }

  const gadgetTitle = (id: number) =>
    (library.status === 'ready' ? library.outputs.find((output) => output.workspaceId === workspaceId && output.workpieceId === id)?.title : undefined) || 'Gadget'
  const chatTitle = (id: number) => chats?.find((chat) => chat.workspaceId === workspaceId && chat.chatId === id)?.chatTitle || 'A chat'

  return (
    <PageLayout header={header}>
      <AgentView
        key={agent.key}
        name={agent.name}
        onRename={(displayName) => update({ displayName })}
        models={models.status === 'ready' ? models.offered.map(({ id, name }) => ({ id, name })) : models.status === 'failed' ? [] : undefined}
        modelId={agent.modelId}
        modelName={agent.modelName}
        onModelChange={(modelId) => update({ modelId })}
        calledBy={[
          ...agent.gadgetIds.map((gadgetId) => ({ title: gadgetTitle(gadgetId), ...link(workspaceId, { type: 'gadget', gadgetId }) })),
          ...[...agent.startedFrom].map((chatId) => ({ title: chatTitle(chatId), ...link(workspaceId, { type: 'chat', chatId }) })),
        ]}
        access={agent.access.map(({ title }) => title)}
        runs={groupByTime(agent.runs.map((run) => ({ value: run, at: run.lastActive }))).map(({ key, label, entries }) => ({
          key,
          label,
          runs: entries.map(({ value: run, time }) => ({
            key: String(run.chatId),
            title: run.title,
            time,
            waiting: run.waiting,
            ...link(workspaceId, { type: 'chat', chatId: run.chatId }),
          })),
        }))}
      />
    </PageLayout>
  )
}
