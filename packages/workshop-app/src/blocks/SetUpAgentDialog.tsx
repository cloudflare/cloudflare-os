import { useState } from 'react'
import { Input, Switch } from '@cloudflare/kumo'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { KindMark } from '@/components/KindMark'
import { MenuChooser, type MenuChoice } from './MenuChooser'

/** What setting up an agent chose. */
export type AgentSetup = {
  name: string
  /** The model it thinks with. */
  modelId: string
  /** Each run's result is posted in the chat that asked for it. */
  reportHere: boolean
}

export type SetUpAgentDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Why the chat's agent asked for it, in its words. */
  reason: string
  /** The models it can think with; `undefined` while they are read. */
  models?: readonly MenuChoice[]
  /** The model it starts on: the one the user prefers. */
  initialModel?: string
  /** Sets it up; held while out, and open under why if it rejects. */
  onSetUp: (setup: AgentSetup) => Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Setting up an agent a chat asked for: one that works on its own each time it is called on, by a
 * gadget, a schedule or the chat, each run a conversation of its own. It is named, given a model
 * to think with, and, unless told not to, reports what each run did back in the chat that asked.
 * It starts with access to nothing, which it says.
 */
export const SetUpAgentDialog = ({ open, onOpenChange, reason, models, initialModel, onSetUp }: SetUpAgentDialogProps) => {
  const [name, setName] = useState('')
  const [model, setModel] = useState<string>()
  const [reportHere, setReportHere] = useState(true)
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const modelId = model ?? (models?.some(({ id }) => id === initialModel) ? initialModel : models?.[0]?.id)
  const trimmed = name.trim()
  const ready = trimmed !== '' && modelId !== undefined && !pending

  const submit = async () => {
    if (!ready) return
    setProblem(undefined)
    setPending(true)
    try {
      await onSetUp({ name: trimmed, modelId, reportHere })
      onOpenChange(false)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      size="md"
      title="Set up an agent"
      description={reason}
      footer={(
        <>
          <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void submit()}>Set up agent</Button>
        </>
      )}
    >
      <div className="flex items-start gap-3 rounded-2xl bg-kumo-tint p-3.5">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-kumo-base text-kumo-default shadow-xs ring-1 ring-kumo-line">
          <KindMark name="agent" className="size-[1.125rem]" />
        </span>
        <p className="text-sm/5 text-kumo-subtle">
          It works on its own whenever it’s called on, by a gadget, a schedule or this chat. Each run is a
          conversation of its own, which you can look in on from Automations.
        </p>
      </div>
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <Input label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Inbox helper" disabled={pending} autoFocus />
        <div className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-base/5 text-kumo-default">Thinks with</span>
            <span className="text-sm/5 text-kumo-subtle">Its runs use your model.</span>
          </span>
          {models === undefined
            ? <span role="status" className="appears-late text-sm text-kumo-subtle">Reading your models…</span>
            : <MenuChooser choices={models} value={modelId} onChoose={(id) => id && setModel(id)} label="Model" placeholder="No models" />}
        </div>
        <label className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-base/5 text-kumo-default">Report back here</span>
            <span className="text-sm/5 text-kumo-subtle">Post what each run did in this chat.</span>
          </span>
          <Switch size="sm" checked={reportHere} onCheckedChange={setReportHere} aria-label="Report back here" disabled={pending} />
        </label>
      </form>
      <p className="text-sm/5 text-kumo-subtle">It starts with access to nothing. What this chat gives it later is listed on its page.</p>
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
