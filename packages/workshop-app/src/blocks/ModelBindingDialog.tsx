import { useState } from 'react'
import { BrainIcon, XIcon } from '@phosphor-icons/react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { CodeBlock } from '@/components/CodeBlock'
import { Dialog } from '@/components/Dialog'
import { Select } from '@/components/Select'
import { TextField } from '@/components/TextField'

/** One of the user's models a gadget's code can be given: one that writes, or one that decides. */
export type ModelChoice = { id: string; name: string; kind: 'language' | 'decision' }

/** What was chosen: the model, and the name the gadget's code reaches it by. */
export type ModelBindingSetup = { modelId: string; name: string }

export type ModelBindingDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The gadget it is for, by its title. */
  gadget: string
  /** The models it can be; none given, they are still being read. */
  models?: readonly ModelChoice[]
  /** The model it starts on: the binding's own when changing one, else the user's default. */
  initialModel?: string
  /** Changing the model of the binding by this name, which stays as it is, rather than adding one. */
  changing?: string
  /** The name it starts with for a model of this kind, one the gadget has nothing by yet. */
  suggestName: (kind: ModelChoice['kind']) => string
  /** Why the gadget's code could not have this name, or nothing where it could. */
  nameProblem: (name: string) => string | undefined
  /**
   * Adds or changes it, holding the dialog while it does, and leaving it open under why if it
   * cannot. Resolving `false` says it was not tried, as over a lost connection, which leaves the
   * dialog as it was.
   */
  onSubmit: (setup: ModelBindingSetup) => Promise<boolean | void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const SAYS: Record<ModelChoice['kind'], string> = {
  language: 'Writes text from a prompt.',
  decision: 'Answers questions, saying how likely each answer is.',
}

// What the code says to use it, which is the binding's whole API (the backend's
// `ai-model-binding.d.ts` and `decision-model-binding.d.ts`), so that it can be asked for in a chat.
const usage = (kind: ModelChoice['kind'], name: string) => kind === 'language'
  ? `const text = await env.${name}.run({ prompt })`
  : `const answers = await env.${name}.decide({ state, questions })`

// What the dialog holds, which is only there while it is open: what is chosen starts over each time.
const ModelBindingContent = ({ gadget, models, initialModel, changing, suggestName, nameProblem, onSubmit, onDone }: Omit<ModelBindingDialogProps, 'open' | 'onOpenChange'> & {
  onDone: () => void
}) => {
  const [chosen, setChosen] = useState<string>()
  // What was typed, which a name made for another kind does not replace.
  const [typed, setTyped] = useState<string>()
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const modelId = chosen ?? (models?.some(({ id }) => id === initialModel) ? initialModel : models?.[0]?.id)
  const model = models?.find(({ id }) => id === modelId)
  const kind = model?.kind ?? 'language'
  const name = changing ?? typed ?? suggestName(kind)
  // Said once something was typed: the name it starts with is always one it can have.
  const invalid = changing === undefined && typed !== undefined ? nameProblem(name.trim()) : undefined
  const unchanged = changing !== undefined && modelId === initialModel
  const ready = model !== undefined && !invalid && !unchanged && !pending

  const submit = async () => {
    if (!ready) return
    setProblem(undefined)
    setPending(true)
    try {
      if (await onSubmit({ modelId: model.id, name: name.trim() }) !== false) onDone()
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
          <BrainIcon className="size-6" />
        </span>
        <div className="flex min-h-12 min-w-0 flex-1 flex-col justify-center gap-0.5 leading-snug">
          <Dialog.Title className="text-lg font-medium text-kumo-default">{changing === undefined ? 'Add an AI model' : 'Change model'}</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            {changing === undefined
              ? `${gadget} can call it from its code, to write text or decide things.`
              : `env.${changing} uses this model from now on. The code stays as it is.`}
          </Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>

      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6">
        <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
          <span className="flex min-w-0 flex-col">
            <span className="text-base/5 text-kumo-default">Model</span>
            <span className="text-sm/5 text-kumo-subtle">{model ? SAYS[model.kind] : 'One of your models.'}</span>
          </span>
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
                    options={models.map(({ id, name: label, kind: each }) => ({ id, label: each === 'decision' ? `${label} · decides` : label }))}
                    searchable={models.length > 8}
                  />
                )}
        </div>
        {changing === undefined && (
          <div className="flex flex-col gap-1.5">
            <TextField
              label="Name in its code"
              value={name}
              onValueChange={(next) => setTyped(next)}
              invalid={invalid !== undefined}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              className="font-mono"
            />
            {invalid && <p role="alert" className="text-sm text-pretty text-kumo-danger">{invalid}</p>}
          </div>
        )}
        {model && <CodeBlock label="Its code calls it like this" uncapped>{usage(kind, name.trim() || 'NAME')}</CodeBlock>}
        <p className="text-sm/5 text-kumo-subtle">
          {changing === undefined
            ? 'It’s there for the gadget as soon as it’s added. Ask the agent in a chat to use it.'
            : 'Whatever the gadget asks it from now on goes to the new model.'}
        </p>
      </div>

      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={problem} />}
        <div className="flex items-center justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button type="submit" variant="primary" disabled={!ready}>
            {changing === undefined ? (pending ? 'Adding…' : 'Add model') : (pending ? 'Changing…' : 'Change model')}
          </Button>
        </div>
      </footer>
    </form>
  )
}

/**
 * Giving a gadget's code one of the user's models, or changing the model a binding reaches: the
 * model, starting on the user's default (or the binding's own), and for a new one the name its
 * code reaches it by, starting on the one its kind is usually given, with how the code calls it
 * under them, so that it can be asked for in a chat.
 */
export const ModelBindingDialog = ({ open, onOpenChange, ...props }: ModelBindingDialogProps) => {
  const [pending, setPending] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <ModelBindingContent
        {...props}
        onSubmit={async (setup) => {
          setPending(true)
          try {
            return await props.onSubmit(setup)
          } finally {
            setPending(false)
          }
        }}
        onDone={() => onOpenChange(false)}
      />
    </Dialog>
  )
}
