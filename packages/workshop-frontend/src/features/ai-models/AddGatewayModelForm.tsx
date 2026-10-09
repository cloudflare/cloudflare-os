import { useRef, useState, type FormEvent } from 'react'
import { Autocomplete, Button, Input, Select } from '@cloudflare/kumo'
import { Plus } from '@phosphor-icons/react'
import { REASONING_LEVELS } from '@gadgets/workshop-shared/api'
import type {
  AiModelProvider,
  GatewayModel,
  GatewayModelCapabilities,
  GatewayModelLevelTest,
  ReasoningLevel,
} from '@gadgets/workshop-shared/api'
import { GatewayLevelTestsStatus, GatewayTestButton } from './GatewayTest'
import { PROVIDER_LABELS, REASONING_LEVEL_LABELS, parseTokenLimit } from './modelForm'
import type { ModelSuggestion } from './modelsDev'
import { useFieldErrorAlert } from './useFieldErrorAlert'
import { useGatewayTests } from './useGatewayTests'

const TOKEN_LIMIT_ERROR = 'Enter a positive whole number of tokens'
const BEHAVES_LIKE_HELP =
  'The model chosen here lends the new one its thinking format and, where they are not stated ' +
  'here, its reasoning levels and its image input, until this version knows the new model ' +
  'itself. From then on the choice is not used. The name, the limits and the cost are never ' +
  'borrowed.'
// What a capability field shows while nothing is stated in it.
const NOT_STATED = 'Not stated'
const REASONING_LEVELS_HELP =
  'The levels the model can be asked for. Pick only Off for a model that does no reasoning.'
const MODEL_ID = {
  label: 'Model ID',
  description:
    'The model’s name in the provider’s API. Chats and preferences refer to the model by it.',
}
const TEST_HELP =
  'Test sends the model described here one request with no reasoning level set and one at each ' +
  'reasoning level it would list once added. Each request can use up to 2,048 output tokens, ' +
  'and nothing is added.'

/**
 * The form an admin describes a new gateway model with. It checks only what the server would
 * refuse outright as malformed; whether the ID is free and the provider usable is the server's to
 * say, and its refusal is shown as it is, beside the values that caused it. The model the form
 * describes can be tested before it is added. A test is of the model as described, so its results
 * show only while the form describes that model, and an edit and an add each forget them.
 */
export const AddGatewayModelForm = ({
  providers, behavesLikeOptions, disabled, suggestions, onAdd, onTest,
}: {
  /** The providers a model may be added under. Not empty. */
  providers: readonly AiModelProvider[]
  /** The models, of any provider, that a new model of the same provider may behave like. */
  behavesLikeOptions: readonly GatewayModel[]
  /**
   * Whether the form is locked, because a write to the models is in flight. Its test writes
   * nothing, so it is not locked.
   */
  disabled: boolean
  /**
   * Present while the Model ID field suggests models. Picking one only fills the form in: what is
   * added is what the form holds when it is submitted.
   */
  suggestions?: {
    /** The models to suggest, each under the provider it belongs to. */
    models: readonly ModelSuggestion[]
    /** Whether the suggestions could not be loaded. */
    unavailable: boolean
    /** Called whenever the Model ID field is turned to, which is when suggestions are wanted. */
    onEngage: () => void
  }
  /** Adds the model. Rejects with the server's refusal. */
  onAdd: (model: GatewayModel) => Promise<void>
  /** Tests the model as described, without adding it. Rejects when the test could not be run. */
  onTest: (model: GatewayModel) => Promise<GatewayModelLevelTest[]>
}) => {
  const [chosenProvider, setChosenProvider] = useState(providers[0])
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [outputLimit, setOutputLimit] = useState('')
  const [chosenBehavesLike, setChosenBehavesLike] = useState<string | null>(null)
  // What is stated of the model: null and an empty list each state nothing.
  const [imageInput, setImageInput] = useState<boolean | null>(null)
  const [reasoningLevels, setReasoningLevels] = useState<ReasoningLevel[]>([])
  // Field errors stay out of sight until an add or a test is attempted, so an untouched form
  // isn't red.
  const [errorsShown, setErrorsShown] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const fieldError = useFieldErrorAlert()
  // The ID a picked suggestion filled the form in with.
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)

  const idRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const contextWindowRef = useRef<HTMLInputElement>(null)
  const outputLimitRef = useRef<HTMLInputElement>(null)

  const provider = providers.includes(chosenProvider) ? chosenProvider : providers[0]
  const behavesLikeOffered = behavesLikeOptions.filter((option) => option.provider === provider)
  const behavesLike = behavesLikeOffered.find((option) => option.id === chosenBehavesLike)
  // The chosen provider's suggestions whose ID holds what is typed. Matched here rather than by
  // the field, which would report itself expanded over a list with nothing in it.
  const typed = id.trim().toLowerCase()
  const offered = suggestions?.models.filter((suggestion) =>
    suggestion.provider === provider && suggestion.id.toLowerCase().includes(typed)) ?? []
  const contextWindowTokens = parseTokenLimit(contextWindow)
  const outputLimitTokens = parseTokenLimit(outputLimit)
  const fields = [
    { ref: idRef, error: id.trim() ? undefined : 'Enter the model ID' },
    { ref: nameRef, error: name.trim() ? undefined : 'Enter a display name' },
    { ref: contextWindowRef, error: contextWindowTokens ? undefined : TOKEN_LIMIT_ERROR },
    {
      ref: outputLimitRef,
      error: outputLimitTokens === null ? `${TOKEN_LIMIT_ERROR}, or leave this blank` : undefined,
    },
  ]
  const [idError, nameError, contextWindowError, outputLimitError] =
    fields.map((field) => (errorsShown ? field.error : undefined))
  const capabilities: GatewayModelCapabilities = {
    ...(imageInput !== null && { imageInput }),
    ...(reasoningLevels.length > 0 && { reasoningLevels }),
  }
  const model: GatewayModel | null =
    id.trim() && name.trim() && contextWindowTokens && outputLimitTokens !== null
      ? {
          provider,
          id: id.trim(),
          name: name.trim(),
          contextWindow: contextWindowTokens,
          ...(outputLimitTokens && { outputLimit: outputLimitTokens }),
          ...(behavesLike && { behavesLike: behavesLike.id }),
          ...(Object.keys(capabilities).length > 0 && { capabilities }),
        }
      : null
  // A test is kept under the model it is of. The form comes to describe another model without an
  // edit when the lists it is given lose the provider or the model to behave like, and the test of
  // the model it described before is then not shown. `testDescribed` starts a test only for a form
  // that describes a model.
  const testKey = JSON.stringify(model)
  const { tests, startTest, clearTests } =
    useGatewayTests<string, GatewayModelLevelTest[]>(() => onTest(model!))
  const test = tests.get(testKey)

  // What every edit does: the refusal and the test were of the model as it was described.
  const edited = () => {
    setRefusal(null)
    clearTests()
  }

  const edit = (setValue: (value: string) => void) => (event: { target: { value: string } }) => {
    setValue(event.target.value)
    edited()
    fieldError.clear()
  }

  const clear = () => {
    setId('')
    setName('')
    setContextWindow('')
    setOutputLimit('')
    setChosenBehavesLike(null)
    setImageInput(null)
    setReasoningLevels([])
    setErrorsShown(false)
    setPickedId(null)
    clearTests()
  }

  // The model the form describes. While a field is in error there is none: the errors are then
  // shown, and the first field in error is pointed at.
  const validate = () => {
    const invalid = fields.find((field) => field.error)
    if (model && !invalid) return model
    setErrorsShown(true)
    if (invalid?.error) fieldError.pointAt(invalid.ref.current, invalid.error)
    return null
  }

  const testDescribed = () => {
    if (validate()) startTest(testKey)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    setRefusal(null)
    const described = validate()
    if (!described) return
    try {
      await onAdd(described)
    } catch (err) {
      console.error('Failed to add gateway model:', err)
      setRefusal(err instanceof Error && err.message ? err.message : 'The model could not be added.')
      return
    }
    clear()
  }

  return (
    <form noValidate onSubmit={submit} className="grid items-start gap-4 sm:grid-cols-2">
      <Select<AiModelProvider>
        label="Provider"
        className="w-full"
        disabled={disabled}
        value={provider}
        onValueChange={(value) => {
          edited()
          if (!value || value === provider) return
          setChosenProvider(value)
          setChosenBehavesLike(null)
          // A suggested model belongs to the provider it was suggested under, so it does not
          // follow the form to another one.
          if (pickedId !== null && pickedId === id.trim()) clear()
        }}
        renderValue={(value) => PROVIDER_LABELS[value]}
      >
        {providers.map((option) => (
          <Select.Option key={option} value={option}>
            {PROVIDER_LABELS[option]}
          </Select.Option>
        ))}
      </Select>
      {suggestions ? (
        // Kumo's Autocomplete hands out no ref to its input, and takes neither a focus handler nor
        // aria-invalid for it, so all three go through this wrapper.
        <div
          ref={(wrapper) => {
            idRef.current = wrapper?.querySelector<HTMLInputElement>('[role="combobox"]') ?? null
            idRef.current?.setAttribute('aria-invalid', String(idError !== undefined))
          }}
          className="grid gap-2"
          onFocus={suggestions.onEngage}
        >
          <Autocomplete<ModelSuggestion>
            label={MODEL_ID.label}
            description={MODEL_ID.description}
            error={idError}
            items={offered}
            filter={null}
            open={listOpen && offered.length > 0}
            onOpenChange={(open) => setListOpen(open)}
            itemToStringValue={(suggestion) => suggestion.id}
            value={id}
            disabled={disabled}
            onValueChange={(value, { reason }) => {
              suggestions.onEngage()
              // With the list closed, Escape asks to empty the field. What was typed stays.
              if (reason === 'escape-key') return
              edit(setId)({ target: { value } })
              const picked =
                reason === 'item-press' && offered.find((suggestion) => suggestion.id === value)
              if (!picked) return
              setPickedId(picked.id)
              setName(picked.name)
              setContextWindow(String(picked.contextWindow))
              setOutputLimit(String(picked.outputLimit ?? ''))
              setImageInput(picked.capabilities?.imageInput ?? null)
              setReasoningLevels(picked.capabilities?.reasoningLevels ?? [])
            }}
          >
            <Autocomplete.InputGroup />
            <Autocomplete.Content>
              <Autocomplete.List>
                {(suggestion: ModelSuggestion) => (
                  <Autocomplete.Item key={suggestion.id} value={suggestion}>
                    <span className="block break-all font-mono text-sm">{suggestion.id}</span>
                    <span className="block text-xs text-kumo-subtle">{suggestion.name}</span>
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </Autocomplete.Content>
          </Autocomplete>
          {suggestions.unavailable && (
            <p role="status" className="text-sm leading-snug text-kumo-subtle">
              Suggestions from models.dev couldn’t be loaded. Enter the model’s details by hand.
            </p>
          )}
        </div>
      ) : (
        <Input
          ref={idRef}
          label={MODEL_ID.label}
          description={MODEL_ID.description}
          value={id}
          disabled={disabled}
          onChange={edit(setId)}
          error={idError}
          aria-invalid={idError !== undefined}
        />
      )}
      <Input
        ref={nameRef}
        label="Display name"
        description="Shown wherever the model is listed."
        value={name}
        disabled={disabled}
        onChange={edit(setName)}
        error={nameError}
        aria-invalid={nameError !== undefined}
      />
      <Input
        ref={contextWindowRef}
        label="Context window"
        inputMode="numeric"
        description="The maximum tokens one request may total."
        value={contextWindow}
        disabled={disabled}
        onChange={edit(setContextWindow)}
        error={contextWindowError}
        aria-invalid={contextWindowError !== undefined}
      />
      <Input
        ref={outputLimitRef}
        label="Output limit"
        required={false}
        inputMode="numeric"
        description="The maximum tokens in one response, also reserved out of the context window."
        value={outputLimit}
        disabled={disabled}
        onChange={edit(setOutputLimit)}
        error={outputLimitError}
        aria-invalid={outputLimitError !== undefined}
      />
      {behavesLikeOffered.length > 0 && (
        <Select<string | null>
          label="Behaves like"
          labelTooltip={BEHAVES_LIKE_HELP}
          required={false}
          className="w-full"
          placeholder="None"
          disabled={disabled}
          value={behavesLike?.id ?? null}
          onValueChange={(value) => {
            edited()
            setChosenBehavesLike(value)
          }}
          renderValue={() => behavesLike?.name}
        >
          <Select.Option value={null}>None</Select.Option>
          {behavesLikeOffered.map((option) => (
            <Select.Option key={option.id} value={option.id}>{option.name}</Select.Option>
          ))}
        </Select>
      )}
      <Select<boolean | null>
        label="Image input"
        description="Whether the model takes images beside text."
        required={false}
        className="w-full"
        placeholder={NOT_STATED}
        disabled={disabled}
        value={imageInput}
        onValueChange={(value) => {
          edited()
          setImageInput(value)
        }}
        renderValue={(value) => (value ? 'Yes' : 'No')}
      >
        <Select.Option value={null}>{NOT_STATED}</Select.Option>
        <Select.Option value={true}>Yes</Select.Option>
        <Select.Option value={false}>No</Select.Option>
      </Select>
      <Select<ReasoningLevel, true>
        multiple
        label="Reasoning levels"
        description={REASONING_LEVELS_HELP}
        required={false}
        className="w-full"
        placeholder={NOT_STATED}
        disabled={disabled}
        value={reasoningLevels}
        onValueChange={(levels) => {
          edited()
          // In the order of the levels, whichever order they were picked in.
          setReasoningLevels(REASONING_LEVELS.filter((level) => levels.includes(level)))
        }}
        // The placeholder shows for a value rendered as nothing, which an empty list is not.
        renderValue={(levels) =>
          levels.map((level) => REASONING_LEVEL_LABELS[level]).join(', ') || undefined}
      >
        {REASONING_LEVELS.map((level) => (
          <Select.Option key={level} value={level}>{REASONING_LEVEL_LABELS[level]}</Select.Option>
        ))}
      </Select>
      <div className="flex min-w-0 flex-col items-start gap-2 sm:col-span-2">
        {fieldError.alert}
        {refusal && (
          <p role="alert" className="text-sm leading-snug text-kumo-danger">
            {refusal}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="secondary" icon={Plus} disabled={disabled}>
            Add model
          </Button>
          <GatewayTestButton
            name="this model"
            size="base"
            testing={test?.state === 'testing'}
            onTest={testDescribed}
          />
        </div>
        {/* As wide as the form and no wider, so that a provider's long message wraps. */}
        <div className="self-stretch">
          <p className="text-xs leading-4 text-kumo-subtle">{TEST_HELP}</p>
          <GatewayLevelTestsStatus test={test} />
        </div>
      </div>
    </form>
  )
}
