import { useState } from 'react'
import { RobotIcon, XIcon } from '@phosphor-icons/react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { Select } from '@/components/Select'
import { TextField } from '@/components/TextField'

/** A model an agent can think with. */
export type AgentModel = { id: string; name: string }

/** What setting up an agent chose. */
export type AgentSetup = {
  name: string
  /** The model it thinks with. */
  modelId: string
}

export type SetUpAgentDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Why the chat's agent asked for it, in its own words. */
  reason: string
  /** The models it can think with; none given, they are still being read. */
  models?: readonly AgentModel[]
  /** The model it starts on: the one the user's messages are answered by. */
  initialModel?: string
  /** Sets it up, holding the dialog while it does, and leaving it open under why if it cannot. */
  onSetUp: (setup: AgentSetup) => Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// What the dialog holds, which is only there while it is open: what is typed starts over each time.
const SetUpAgentContent = ({ reason, models, initialModel, onSetUp, onDone }: Omit<SetUpAgentDialogProps, 'open' | 'onOpenChange'> & {
  onDone: () => void
}) => {
  const [name, setName] = useState('')
  const [model, setModel] = useState<string>()
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
      await onSetUp({ name: trimmed, modelId })
      onDone()
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="contents" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <header className="flex items-start gap-3 p-6">
        <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-full bg-kumo-fill text-kumo-default">
          <RobotIcon className="size-6" />
        </span>
        <div className="flex min-h-12 min-w-0 flex-1 flex-col justify-center gap-0.5 leading-snug">
          <Dialog.Title className="text-lg font-medium text-kumo-default">Set up an agent</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">It works on its own whenever it’s called on, each run a chat of its own.</Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>

      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6">
        {reason && <blockquote className="rounded-(--surface-radius) bg-kumo-tint px-4 py-3 text-base/5 text-kumo-default">{reason}</blockquote>}
        <TextField label="Name" value={name} onValueChange={setName} placeholder="Inbox helper" disabled={pending} autoFocus />
        <div className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-base/5 text-kumo-default">Thinks with</span>
            <span className="text-sm/5 text-kumo-subtle">Its runs use your model.</span>
          </span>
          {models === undefined
            ? <span role="status" className="appears-late text-sm text-kumo-subtle">Reading your models…</span>
            : <Select aria-label="Model" value={modelId ?? ''} onValueChange={setModel} options={models.map(({ id, name: label }) => ({ id, label }))} placeholder="No models" />}
        </div>
        <p className="text-sm/5 text-kumo-subtle">It starts with access to nothing. What the chat gives it later, it can use.</p>
      </div>

      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={problem} />}
        <div className="flex items-center justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button type="submit" variant="primary" disabled={!ready}>{pending ? 'Setting up…' : 'Set up agent'}</Button>
        </div>
      </footer>
    </form>
  )
}

/**
 * Setting up an agent a chat asked for: one that works on its own each time it is called on, by a
 * gadget, a schedule or the chat, each run a chat of its own. It is named and given a model to
 * think with, and starts with access to nothing, which it says.
 */
export const SetUpAgentDialog = ({ open, onOpenChange, ...props }: SetUpAgentDialogProps) => {
  const [pending, setPending] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <SetUpAgentContent
        {...props}
        onSetUp={async (setup) => {
          setPending(true)
          try {
            await props.onSetUp(setup)
          } finally {
            setPending(false)
          }
        }}
        onDone={() => onOpenChange(false)}
      />
    </Dialog>
  )
}
