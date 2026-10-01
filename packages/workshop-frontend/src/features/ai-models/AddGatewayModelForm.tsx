import { useRef, useState, type FormEvent } from 'react'
import { Autocomplete, Button, Input, Select } from '@cloudflare/kumo'
import { Plus } from '@phosphor-icons/react'
import type { AiModelProvider, GatewayModel } from '@gadgets/workshop-shared/api'
import { PROVIDER_LABELS, parseTokenLimit } from './modelForm'
import type { ModelSuggestion } from './modelsDev'

const TOKEN_LIMIT_ERROR = 'Enter a positive whole number of tokens'
const MODEL_ID = {
  label: 'Model ID',
  description:
    'The model’s name in the provider’s API. Chats and preferences refer to the model by it.',
}

/**
 * The form an admin describes a new gateway model with. It checks only what the server would
 * refuse outright as malformed; whether the ID is free and the provider usable is the server's to
 * say, and its refusal is shown as it is, beside the values that caused it.
 */
export const AddGatewayModelForm = ({ providers, disabled, suggestions, onAdd }: {
  /** The providers a model may be added under. Not empty. */
  providers: readonly AiModelProvider[]
  /** Whether the form is locked, because a write to the models is in flight. */
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
}) => {
  const [chosenProvider, setChosenProvider] = useState(providers[0])
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [outputLimit, setOutputLimit] = useState('')
  // Field errors stay out of sight until a submit is attempted, so an untouched form isn't red.
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  // A field error that focus could not announce, with the attempt that found it so that finding
  // the same error again says it again.
  const [unannounced, setUnannounced] = useState<{ error: string; attempt: number } | null>(null)
  // The ID a picked suggestion filled the form in with.
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)

  const idRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const contextWindowRef = useRef<HTMLInputElement>(null)
  const outputLimitRef = useRef<HTMLInputElement>(null)

  const provider = providers.includes(chosenProvider) ? chosenProvider : providers[0]
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
    fields.map((field) => (submitAttempted ? field.error : undefined))
  const model: GatewayModel | null =
    id.trim() && name.trim() && contextWindowTokens && outputLimitTokens !== null
      ? {
          provider,
          id: id.trim(),
          name: name.trim(),
          contextWindow: contextWindowTokens,
          ...(outputLimitTokens && { outputLimit: outputLimitTokens }),
        }
      : null

  const edit = (setValue: (value: string) => void) => (event: { target: { value: string } }) => {
    setValue(event.target.value)
    setRefusal(null)
    setUnannounced(null)
  }

  const clear = () => {
    setId('')
    setName('')
    setContextWindow('')
    setOutputLimit('')
    setSubmitAttempted(false)
    setPickedId(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    setRefusal(null)
    const invalid = fields.find((field) => field.error)
    if (!model || invalid) {
      setSubmitAttempted(true)
      // Each error describes its field, so landing on the field announces it. A field that
      // already has focus fires no focus event, and its error is not a live region.
      const input = invalid?.ref.current
      if (input && input === document.activeElement) {
        setUnannounced((last) => ({ error: invalid.error!, attempt: (last?.attempt ?? 0) + 1 }))
      } else {
        input?.focus()
      }
      return
    }
    try {
      await onAdd(model)
    } catch (err) {
      console.error('Failed to add gateway model:', err)
      setRefusal(err instanceof Error && err.message ? err.message : 'The model could not be added.')
      return
    }
    clear()
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Select<AiModelProvider>
        label="Provider"
        className="w-full"
        disabled={disabled}
        value={provider}
        onValueChange={(value) => {
          setRefusal(null)
          if (!value || value === provider) return
          setChosenProvider(value)
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
          className="grid content-start gap-2"
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
      <div className="flex flex-col items-start gap-2 sm:col-span-2">
        {unannounced && (
          <p key={unannounced.attempt} role="alert" className="sr-only">
            {unannounced.error}
          </p>
        )}
        {refusal && (
          <p role="alert" className="text-sm leading-snug text-kumo-danger">
            {refusal}
          </p>
        )}
        <Button type="submit" variant="secondary" icon={Plus} disabled={disabled}>
          Add model
        </Button>
      </div>
    </form>
  )
}
