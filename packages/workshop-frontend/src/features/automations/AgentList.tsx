import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Dialog, Select, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AgentSpawnerInfo, AiChatAuthorInfo, AiChatMetadata, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { formatRelativeTime } from '../../Activity'
import { AgentMark } from '../../components/icons/brandMarks'
import { roundButtonClass } from '../../components/RoundButton'
import { WorkshopInput } from '../../components/WorkshopControls'
import { reportIssue } from '../../errorReporting'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'

/** How many of an agent's conversations show before "Show all". */
const RECENT_CONVERSATIONS = 3

/**
 * The agents a chat's or an app's apps start (agent spawners): each with the model it runs, what
 * it can use, and the conversations it has started, which live here rather than among the
 * person's own chats; and a way to rename it or change its model. Nothing at all when there are
 * none, since most apps start no agents.
 */
export function AgentList({ overseer, workspaceId, gadgetIds, chatId }: {
  overseer: RpcStub<Overseer>
  workspaceId: string
  /** The apps whose agents to list; with no `chatId` either, all the workspace's. */
  gadgetIds?: readonly WorkpieceId[]
  /** A chat whose own agents to list too: those it has started conversations with. */
  chatId?: number
}) {
  const [agents, setAgents] = useState<AgentSpawnerInfo[] | null>(null)
  const [chats, setChats] = useState<AiChatMetadata[]>([])
  const [editing, setEditing] = useState<AgentSpawnerInfo | null>(null)
  const key = `${gadgetIds?.join(',') ?? '*'}:${chatId ?? ''}`

  const load = async () => {
    try {
      const [all, chatList] = await Promise.all([overseer.listAgentSpawners(), overseer.listChats()])
      const started = (agent: AgentSpawnerInfo) => chatList.filter(chat => chat.spawnerId === agent.gatekeeperId)
      setChats(chatList)
      setAgents(gadgetIds === undefined && chatId === undefined ? all : all.filter(agent =>
        agent.gadgetIds.some(id => gadgetIds?.includes(id)) ||
        (chatId !== undefined && started(agent).some(chat => chat.parentChatId === chatId))))
    } catch (err) {
      if (logRpcFailure('Failed to load agents:', err)) return
      reportIssue('agents.load', err)
      setAgents([])
    }
  }
  useEffect(() => { void load() }, [overseer, key]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!agents?.length) return null
  return (
    <section className="flex flex-col gap-2">
      <div className="px-1 pt-4">
        <h2 className="text-[14px] font-medium leading-5 text-kumo-default">Agents</h2>
        <p className="text-[13px] leading-[18px] text-kumo-subtle">Started by your gadgets to take on tasks, like answering each new email.</p>
      </div>
      {agents.map(agent => (
        <div key={agent.gatekeeperId} className="flex flex-col rounded-2xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="flex items-start gap-3 p-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-kumo-tint" aria-hidden="true">
            <AgentMark size={20} />
          </span>
          <div className="flex min-h-9 min-w-0 flex-1 flex-col justify-center">
            <p className="truncate text-[14px] font-medium leading-5 text-kumo-default">{agent.displayName}</p>
            <p className="line-clamp-2 text-[13px] leading-[18px] text-kumo-subtle">
              {agent.modelId === null ? 'No model: its chats wait for you' : `Runs on ${agent.modelName ?? 'your model'}`}
              {agent.access.length > 0 && ` · Can use ${agent.access.map(a => a.resourceTitle ?? a.name).join(', ')}`}
            </p>
          </div>
          <button type="button" onClick={() => setEditing(agent)} className={roundButtonClass('pill', 'h-9 shrink-0 !px-3 !text-[13px]')}>
            Edit
          </button>
        </div>
        <Conversations workspaceId={workspaceId}
          chats={chats.filter(chat => chat.spawnerId === agent.gatekeeperId)
            .toSorted((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())} />
        </div>
      ))}
      <EditAgentDialog
        overseer={overseer}
        agent={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void load() }}
      />
    </section>
  )
}

/** An agent's conversations, newest first: the latest few, and the rest on request. */
function Conversations({ workspaceId, chats }: { workspaceId: string; chats: AiChatMetadata[] }) {
  const [all, setAll] = useState(false)
  if (chats.length === 0) {
    return <p className="border-t border-kumo-line px-3 py-2.5 pl-[60px] text-[13px] leading-[18px] text-kumo-inactive">No conversations yet. Each task it takes on starts one.</p>
  }
  const shown = all ? chats : chats.slice(0, RECENT_CONVERSATIONS)
  return (
    <div className="flex flex-col border-t border-kumo-line py-1.5">
      {shown.map(chat => (
        <Link
          key={chat.id}
          to="/workspace/$id"
          params={{ id: workspaceId }}
          search={{ chat: chat.id }}
          className="mx-1.5 flex h-8 items-center gap-3 rounded-lg pl-[46px] pr-2 text-[13px] text-kumo-default transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
        >
          <span className="min-w-0 flex-1 truncate">{chat.title}</span>
          {chat.activeAgent && <span className="shrink-0 text-kumo-subtle">Working…</span>}
          <span className="shrink-0 text-[12px] text-kumo-inactive">{formatRelativeTime(new Date(chat.lastActive))}</span>
        </Link>
      ))}
      {chats.length > RECENT_CONVERSATIONS && (
        <button type="button" onClick={() => setAll(v => !v)}
          className="mx-1.5 flex h-8 cursor-pointer items-center rounded-lg pl-[46px] text-left text-[13px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
          {all ? 'Show fewer' : `Show all ${chats.length}`}
        </button>
      )}
    </div>
  )
}

function EditAgentDialog({ overseer, agent, onClose, onSaved }: {
  overseer: RpcStub<Overseer>
  agent: AgentSpawnerInfo | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [modelId, setModelId] = useState<string | null>(null)
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [saving, setSaving] = useState(false)
  const toasts = useKumoToastManager()

  useEffect(() => {
    if (!agent) return
    setName(agent.displayName)
    setModelId(agent.modelId)
    overseer.listModels().then(setModels, err => console.error('Failed to load models:', err))
  }, [agent, overseer])

  const save = async () => {
    if (!agent || !name.trim()) return
    setSaving(true)
    try {
      await overseer.updateAgentSpawner(agent.gatekeeperId, { displayName: name.trim(), modelId })
      toasts.add({ title: 'Agent updated', description: 'Its next tasks use the new settings.' })
      onSaved()
    } catch (err) {
      toasts.add({ title: "Couldn't update the agent", description: rpcFailureDescription(err), variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  // The agent's own model may be one only its creator has; keep it choosable as it is.
  const choices = agent?.modelId && !models.some(m => m.id === agent.modelId)
    ? [{ id: agent.modelId, name: agent.modelName ?? 'Current model' } as AiChatAuthorInfo, ...models]
    : models

  return (
    <Dialog.Root open={agent !== null} onOpenChange={open => { if (!open && !saving) onClose() }}>
      <Dialog className="responsive-dialog !z-[1000] !w-[min(420px,calc(100vw-32px))] bg-kumo-base p-5" size="sm">
        <Dialog.Title className="text-[16px] font-medium leading-5 text-kumo-default">Edit agent</Dialog.Title>
        <Dialog.Description className="mt-1.5 text-[13px] leading-[18px] text-kumo-subtle">
          Tasks it starts from now on use these settings. Ones already under way keep theirs.
        </Dialog.Description>
        <form className="mt-4 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void save() }}>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium text-kumo-default">
            Name
            <WorkshopInput value={name} onChange={event => setName(event.target.value)} className="w-full" autoFocus />
          </label>
          <div className="flex flex-col gap-1.5 text-[13px] font-medium text-kumo-default">
            Model
            <Select
              aria-label="Model"
              className="w-full text-sm [&_button]:!h-9"
              value={modelId}
              onValueChange={value => setModelId(value as string | null)}
              renderValue={id => id === null ? 'None: its chats wait for you' : choices.find(m => m.id === id)?.name ?? String(id)}
            >
              <Select.Option value={null as never}>None: its chats wait for you</Select.Option>
              {choices.map(model => <Select.Option key={model.id} value={model.id}>{model.name}</Select.Option>)}
            </Select>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={saving} className={roundButtonClass('pill')}>Cancel</button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="inline-flex h-[34px] cursor-pointer items-center rounded-full bg-kumo-contrast px-3.5 text-[13px] font-medium text-kumo-inverse hover:opacity-85 disabled:cursor-default disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
