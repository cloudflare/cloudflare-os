import { useEffect, useState } from 'react'
import { Dialog, Select, Switch } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AgentSpawnerConfig, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { AgentMark } from '../../components/icons/brandMarks'
import { GatekeeperIcon } from '../../components/GatekeeperIcon'
import { roundButtonClass } from '../../components/RoundButton'
import { WorkshopInput } from '../../components/WorkshopControls'

/** Something the chat can use that its new agent may be given: a connection made in the chat. */
export type AgentAccessChoice = { target: WorkpieceId; name: string; title: string; vendorId?: string }

/** "EMAIL_RESPONDER" as a name: "Email responder". Generic names give nothing to go on. */
export function agentNameFrom(bindingName: string | undefined): string {
  const words = (bindingName ?? '').toLowerCase().split(/[_\s]+/).filter(word => word && !['agent', 'agents', 'spawner'].includes(word))
  if (words.length === 0) return 'Assistant'
  const name = words.join(' ')
  return name[0]!.toUpperCase() + name.slice(1)
}

/**
 * Accepting a chat's request for an agent its app can start (an agent spawner): what the agent is
 * for, in the chat agent's words, then its name (filled in from the request), the model it runs,
 * and which of the chat's connections it may use, all on to begin with. One step, with nothing to
 * pick from a list of connection types.
 */
export function SetUpAgentDialog({ open, overseer, chatId, reason, suggestedName, access, onClose, onCreate }: {
  open: boolean
  overseer: RpcStub<Overseer>
  /** The chat asking for it, where each run's result can be posted. */
  chatId?: number
  /** Why the chat's agent asked for it. */
  reason?: string
  suggestedName: string
  access: AgentAccessChoice[]
  onClose: () => void
  /** Creates the agent; rejects, leaving the dialog open, if it could not be. */
  onCreate: (config: AgentSpawnerConfig) => Promise<void>
}) {
  const [name, setName] = useState(suggestedName)
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [modelId, setModelId] = useState<string | null>(null)
  const [granted, setGranted] = useState<ReadonlySet<WorkpieceId>>(new Set())
  const [creating, setCreating] = useState(false)
  // Whoever asks a chat for an agent most likely wants to hear back there.
  const [reportHere, setReportHere] = useState(true)

  useEffect(() => {
    if (!open) return
    setName(suggestedName)
    setReportHere(true)
    setGranted(new Set(access.map(choice => choice.target)))
    overseer.listModels().then(list => {
      setModels(list)
      setModelId(current => current ?? list[0]?.id ?? null)
    }, err => console.error('Failed to load models:', err))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      await onCreate({
        displayName: name.trim(),
        modelId,
        env: Object.fromEntries(access.filter(choice => granted.has(choice.target)).map(choice => [choice.name, choice.target])),
        ...(chatId !== undefined && reportHere ? { reportsToChatId: chatId } : {}),
      })
    } catch {
      // The caller says what went wrong; the dialog stays for another try.
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={next => { if (!next && !creating) onClose() }}>
      <Dialog className="responsive-dialog !z-[1000] !w-[min(440px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0" size="sm">
        <form onSubmit={event => { event.preventDefault(); void create() }}>
          <div className="flex flex-col items-center gap-2 px-6 pb-2 pt-6 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-kumo-tint" aria-hidden="true">
              <AgentMark size={24} />
            </span>
            <Dialog.Title className="text-[17px] font-medium leading-[22px] text-kumo-default">Set up an agent</Dialog.Title>
            <Dialog.Description className="max-w-[340px] text-[13px] leading-[18px] text-kumo-subtle">
              {reason || 'Your app starts it to take on tasks of its own, each in a chat you can open.'}
            </Dialog.Description>
          </div>

          <div className="flex flex-col gap-4 px-6 py-4">
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
                renderValue={id => id === null ? 'None: its chats wait for you' : models.find(m => m.id === id)?.name ?? 'Loading…'}
              >
                {models.map(model => <Select.Option key={model.id} value={model.id}>{model.name}</Select.Option>)}
                <Select.Option value={null as never}>None: its chats wait for you</Select.Option>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-kumo-default">It can use</span>
              {access.length === 0 ? (
                <p className="text-[13px] leading-[18px] text-kumo-subtle">Nothing yet. The chat can give it connections later, with your OK.</p>
              ) : (
                <div className="flex flex-col rounded-xl ring-1 ring-kumo-line">
                  {access.map((choice, index) => (
                    <label key={choice.target} className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 ${index > 0 ? 'border-t border-kumo-line' : ''}`}>
                      <GatekeeperIcon vendorId={choice.vendorId} fallbackText={choice.title} className="size-6 rounded-md" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-default">{choice.title}</span>
                      <Switch
                        size="sm"
                        checked={granted.has(choice.target)}
                        aria-label={`Let it use ${choice.title}`}
                        onCheckedChange={on => setGranted(prev => {
                          const next = new Set(prev)
                          if (on) next.add(choice.target); else next.delete(choice.target)
                          return next
                        })}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>

            {chatId !== undefined && (
              <label className="flex cursor-pointer items-start gap-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-kumo-default">Post results in this chat</span>
                  <span className="text-[13px] leading-[18px] text-kumo-subtle">
                    {reportHere
                      ? 'Each run’s answer shows up here, as it finishes.'
                      : 'Each run’s answer stays in its own conversation, under the agent in Automations.'}
                  </span>
                </span>
                <Switch size="sm" checked={reportHere} aria-label="Post results in this chat" onCheckedChange={setReportHere} />
              </label>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-kumo-line px-6 py-3.5">
            <button type="button" onClick={onClose} disabled={creating} className={roundButtonClass('pill')}>Not now</button>
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="inline-flex h-[34px] cursor-pointer items-center rounded-full bg-kumo-contrast px-3.5 text-[13px] font-medium text-kumo-inverse hover:opacity-85 disabled:cursor-default disabled:opacity-50"
            >
              {creating ? 'Setting up…' : 'Set up agent'}
            </button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
