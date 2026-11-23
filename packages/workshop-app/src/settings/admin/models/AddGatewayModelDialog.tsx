import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Cancel01Icon } from '@/components/icons'
import { REASONING_LEVELS, type AiModelProvider, type GatewayModel, type GatewayModelCapabilities, type GatewayModelLevelTest, type ReasoningLevel } from '@gadgets/workshop-shared/api'
import { Banner, Button, Dialog, DropdownMenu, Select, TextField } from '@gadgets/ui'
import { messageOf } from '../../useAttempt'
import { GatewayLevelTestsStatus } from './GatewayTest'
import { parseTokenLimit, PROVIDER_LABELS, REASONING_LEVEL_LABELS } from './modelForm'
import type { ModelSuggestion } from './modelsDev'
import { useGatewayTests } from './useGatewayTests'

// The choices that state nothing.
const NONE = '::none'
const TOKENS_PROBLEM = 'a positive whole number of tokens'

/** Where the Model ID field suggests models, from models.dev, while that is turned on. */
export type ModelSuggestions = {
  /** The models to suggest, each under the provider it is of. */
  models: readonly ModelSuggestion[]
  /** They could not be loaded. */
  unavailable: boolean
  /** The field was turned to, which is when they are wanted. */
  onEngage: () => void
}

export type AddGatewayModelDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The providers a model may be added under. Not empty. */
  providers: readonly AiModelProvider[]
  /** The models, of any provider, that a new one of the same provider may behave like. */
  behavesLikeOptions: readonly GatewayModel[]
  suggestions?: ModelSuggestions
  /** Adds it. Rejects with the server's refusal, which the dialog stays open under. */
  onAdd: (model: GatewayModel) => Promise<void>
  /** Tests it as described, adding nothing. Rejects where the test could not be run. */
  onTest: (model: GatewayModel) => Promise<GatewayModelLevelTest[]>
}

// A field's name over what is chosen, as a `TextField`'s label is over what is typed.
const Labelled = ({ label, help, children }: { label: string; help?: string; children: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <span aria-hidden="true" className="text-sm font-medium text-kumo-default">{label}</span>
    {children}
    {help && <span className="text-sm text-kumo-subtle">{help}</span>}
  </div>
)

const AddGatewayModelForm = ({ providers, behavesLikeOptions, suggestions, onAdd, onTest }: Omit<AddGatewayModelDialogProps, 'open' | 'onOpenChange'>) => {
  const [chosenProvider, setChosenProvider] = useState(providers[0]!)
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [outputLimit, setOutputLimit] = useState('')
  const [chosenBehavesLike, setChosenBehavesLike] = useState(NONE)
  // What is stated of the model: nothing and an empty list each state nothing.
  const [imageInput, setImageInput] = useState<boolean>()
  const [reasoningLevels, setReasoningLevels] = useState<ReasoningLevel[]>([])
  // What is wrong is said only once adding or testing is tried, so an untouched form isn't red.
  const [tried, setTried] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const [pending, setPending] = useState(false)
  const suggestionsId = useId()

  const provider = providers.includes(chosenProvider) ? chosenProvider : providers[0]!
  const behavesLikeOffered = behavesLikeOptions.filter((option) => option.provider === provider)
  const behavesLike = behavesLikeOffered.find((option) => option.id === chosenBehavesLike)
  const offered = suggestions?.models.filter((suggestion) => suggestion.provider === provider) ?? []
  const contextWindowTokens = parseTokenLimit(contextWindow)
  const outputLimitTokens = parseTokenLimit(outputLimit)
  const problems = [
    !id.trim() && 'Enter the model ID.',
    !name.trim() && 'Enter a display name.',
    !contextWindowTokens && `Enter the context window as ${TOKENS_PROBLEM}.`,
    outputLimitTokens === null && `Enter the output limit as ${TOKENS_PROBLEM}, or leave it empty.`,
  ].filter((problem): problem is string => typeof problem === 'string')
  const capabilities: GatewayModelCapabilities = {
    ...(imageInput !== undefined && { imageInput }),
    ...(reasoningLevels.length > 0 && { reasoningLevels }),
  }
  const model: GatewayModel | undefined = problems.length === 0 && contextWindowTokens
    ? {
        provider,
        id: id.trim(),
        name: name.trim(),
        contextWindow: contextWindowTokens,
        ...(outputLimitTokens && { outputLimit: outputLimitTokens }),
        ...(behavesLike && { behavesLike: behavesLike.id }),
        ...(Object.keys(capabilities).length > 0 && { capabilities }),
      }
    : undefined
  // A test is kept under the model it was of, so that it shows only while the form describes that model.
  const testKey = JSON.stringify(model ?? null)
  const { tests, startTest, clearTests } = useGatewayTests<string, GatewayModelLevelTest[]>(() => onTest(model!))
  const test = tests.get(testKey)

  // Whatever is changed was not what was refused or tested.
  const edited = () => {
    setRefusal(undefined)
    clearTests()
  }
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value)
    edited()
  }

  const add = async (event: FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (!model || pending) return
    setRefusal(undefined)
    setPending(true)
    try {
      await onAdd(model)
    } catch (error) {
      setRefusal(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <form noValidate onSubmit={(event) => void add(event)} className="flex min-h-0 flex-col">
      <header className="flex items-center gap-3 p-6 pb-5">
        <Dialog.Title className="min-w-0 flex-1 text-lg font-medium text-kumo-default">Add a model</Dialog.Title>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<Cancel01Icon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <div className="grid min-h-0 grid-cols-1 items-start gap-4 overflow-y-auto px-6 pb-1 sm:grid-cols-2">
        <Labelled label="Provider">
          <Select
            aria-label="Provider"
            value={provider}
            options={providers.map((option) => ({ id: option, label: PROVIDER_LABELS[option] }))}
            onValueChange={(next) => {
              edited()
              setChosenProvider(next)
              setChosenBehavesLike(NONE)
            }}
          />
        </Labelled>
        <div className="flex min-w-0 flex-col gap-1.5">
          <TextField
            label="Model ID"
            list={suggestions ? suggestionsId : undefined}
            autoComplete="off"
            spellCheck={false}
            value={id}
            invalid={tried && !id.trim()}
            onFocus={suggestions?.onEngage}
            onValueChange={(value) => {
              edit(setId)(value)
              // A suggestion picked from the field's list fills in the rest; it is only where the form starts.
              const picked = offered.find((suggestion) => suggestion.id === value)
              if (!picked) return
              setName(picked.name)
              setContextWindow(String(picked.contextWindow))
              setOutputLimit(String(picked.outputLimit ?? ''))
              setImageInput(picked.capabilities?.imageInput)
              setReasoningLevels(picked.capabilities?.reasoningLevels ?? [])
            }}
          />
          {suggestions && (
            <datalist id={suggestionsId}>
              {offered.map((suggestion) => <option key={suggestion.id} value={suggestion.id}>{suggestion.name}</option>)}
            </datalist>
          )}
          <span className="text-sm text-kumo-subtle">
            {suggestions?.unavailable ? 'Suggestions from models.dev couldn’t be loaded. Enter the model’s details by hand.' : 'Its name in the provider’s API, which chats and preferences know it by.'}
          </span>
        </div>
        <TextField label="Display name" value={name} invalid={tried && !name.trim()} onValueChange={edit(setName)} />
        <TextField label="Context window" inputMode="numeric" placeholder="Tokens" value={contextWindow} invalid={tried && !contextWindowTokens} onValueChange={edit(setContextWindow)} />
        <TextField label="Output limit" inputMode="numeric" placeholder="Optional" value={outputLimit} invalid={tried && outputLimitTokens === null} onValueChange={edit(setOutputLimit)} />
        {behavesLikeOffered.length > 0 && (
          <Labelled label="Behaves like" help="Lends it its thinking format, and its reasoning levels and image input where they are not stated here, until this version knows it itself.">
            <Select
              aria-label="Behaves like"
              value={behavesLike?.id ?? NONE}
              options={[{ id: NONE, label: 'None' }, ...behavesLikeOffered.map((option) => ({ id: option.id, label: option.name }))]}
              onValueChange={(next) => {
                edited()
                setChosenBehavesLike(next)
              }}
            />
          </Labelled>
        )}
        <Labelled label="Image input">
          <Select
            aria-label="Image input"
            value={imageInput === undefined ? NONE : imageInput ? 'yes' : 'no'}
            options={[{ id: NONE, label: 'Not stated' }, { id: 'yes', label: 'Takes images' }, { id: 'no', label: 'Takes no images' }]}
            onValueChange={(next) => {
              edited()
              setImageInput(next === NONE ? undefined : next === 'yes')
            }}
          />
        </Labelled>
        <Labelled label="Reasoning levels" help="The levels it can be asked for. Only Off, for a model that does no reasoning.">
          <DropdownMenu
            label={<span className="min-w-0 truncate">{reasoningLevels.map((level) => REASONING_LEVEL_LABELS[level]).join(', ') || 'Not stated'}</span>}
            aria-label={`Reasoning levels: ${reasoningLevels.map((level) => REASONING_LEVEL_LABELS[level]).join(', ') || 'not stated'}`}
            caret
            triggerClassName="max-w-full min-w-0 justify-between rounded-xl px-3 font-normal"
            align="start"
            inPlace
          >
            {REASONING_LEVELS.map((level) => (
              <DropdownMenu.CheckboxItem
                key={level}
                checked={reasoningLevels.includes(level)}
                onCheckedChange={(checked) => {
                  edited()
                  // In the levels' order, whichever order they were chosen in.
                  setReasoningLevels((current) => REASONING_LEVELS.filter((other) => (other === level ? checked : current.includes(other))))
                }}
              >
                {REASONING_LEVEL_LABELS[level]}
              </DropdownMenu.CheckboxItem>
            ))}
          </DropdownMenu>
        </Labelled>
        <div className="flex min-w-0 flex-col gap-2 sm:col-span-2">
          <p className="text-sm text-kumo-subtle">Test sends the model described here one request with no reasoning level set and one at each level it would list once added. Each can use up to 2,048 output tokens, and nothing is added.</p>
          <GatewayLevelTestsStatus test={test} />
        </div>
      </div>
      <footer className="flex flex-col gap-3 p-6">
        {tried && problems.length > 0 && <Banner title={problems[0]!} />}
        {refusal && <Banner title={`Couldn’t add it: ${refusal}`} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            aria-disabled={test?.state === 'testing' || undefined}
            onClick={() => {
              setTried(true)
              if (model) startTest(testKey)
            }}
          >
            {test?.state === 'testing' ? 'Testing…' : 'Test'}
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>{pending ? 'Adding…' : 'Add model'}</Button>
        </div>
      </footer>
    </form>
  )
}

/**
 * Where an admin describes a model to add through the gateway, over the part: its provider, its
 * ID (suggested from models.dev while that is on, a suggestion only filling the form in), its name
 * and limits, and what is stated of it. It checks only what the server would refuse as malformed;
 * whether the ID is free is the server's to say, and its refusal is shown as it is. What it
 * describes can be tested first. It starts empty each time it is opened. Ported from
 * `workshop-frontend`'s `AddGatewayModelForm`.
 */
export const AddGatewayModelDialog = ({ open, onOpenChange, ...form }: AddGatewayModelDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange} wide>
    <AddGatewayModelForm {...form} />
  </Dialog>
)
