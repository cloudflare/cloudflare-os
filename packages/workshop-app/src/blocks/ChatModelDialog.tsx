import { useState } from 'react'
import { SparkleIcon, XIcon } from '@phosphor-icons/react'
import { Banner, Button, Dialog, Select } from '@gadgets/ui'
import type { ModelChoice } from './ModelBindingDialog'

export type ChatModelDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The models it can be; none given, they are still being read. */
  models?: readonly ModelChoice[]
  /** The model it starts on, the user's default. */
  initialModel?: string
  /** Goes back to choosing what to connect. */
  onBack?: () => void
  /** Adds it, holding the dialog while it does, and leaving it open under why if it cannot. */
  onAdd: (modelId: string) => Promise<void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const ChatModelContent = ({ models, initialModel, onBack, onAdd, onDone }: Omit<ChatModelDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) => {
  const [chosen, setChosen] = useState<string>()
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const modelId = chosen ?? (models?.some(({ id }) => id === initialModel) ? initialModel : models?.[0]?.id)

  const submit = async () => {
    if (!modelId || pending) return
    setProblem(undefined)
    setPending(true)
    try {
      await onAdd(modelId)
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
          <SparkleIcon className="size-6" />
        </span>
        <div className="flex min-h-12 min-w-0 flex-1 flex-col justify-center gap-0.5 leading-snug">
          <Dialog.Title className="text-lg font-medium text-kumo-default">Add an AI model</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">The agent can give it to a gadget, whose code can then write text or decide things with it.</Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <div className="flex min-h-0 grow flex-col gap-5 overflow-y-auto px-6">
        <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
          <span className="text-base/5 text-kumo-default">Model</span>
          {models === undefined
            ? <span role="status" className="appears-late text-sm text-kumo-subtle">Reading your models…</span>
            : models.length === 0
              ? <span className="text-sm text-kumo-subtle">No models yet. Add one in your settings.</span>
              : (
                  <Select
                    aria-label="Model"
                    value={modelId ?? ''}
                    onValueChange={setChosen}
                    // A decision model says so: its name alone could be either.
                    options={models.map(({ id, name, kind }) => ({ id, label: kind === 'decision' ? `${name} · decides` : name }))}
                    searchable={models.length > 8}
                  />
                )}
        </div>
        <p className="text-sm/5 text-kumo-subtle">Say in your message what the gadget should do with it, such as “summarize each note with this”.</p>
      </div>
      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={problem} />}
        <div className="flex items-center justify-end gap-2">
          {onBack && <Button variant="ghost" className="me-auto" disabled={pending} onClick={onBack}>Back</Button>}
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button type="submit" variant="primary" disabled={!modelId || pending}>{pending ? 'Adding…' : 'Add'}</Button>
        </div>
      </footer>
    </form>
  )
}

/**
 * One of the user's models, added to a chat as a connection (`newAiModelGatekeeper`), which the
 * chat's agent can then give to a gadget (its `setGadgetBinding`), as main's Workshop offered.
 */
export const ChatModelDialog = ({ open, onOpenChange, ...props }: ChatModelDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <ChatModelContent {...props} onDone={() => onOpenChange(false)} />
  </Dialog>
)
