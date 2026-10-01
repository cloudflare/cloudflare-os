import { useRef, useState, type FormEvent } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import { Plus } from '@phosphor-icons/react'
import type { AiModelProvider, GatewayModel } from '@gadgets/workshop-shared/api'
import { PROVIDER_LABELS, parseTokenLimit } from './modelForm'

const TOKEN_LIMIT_ERROR = 'Enter a positive whole number of tokens'

/**
 * The form an admin describes a new gateway model with. It checks only what the server would
 * refuse outright as malformed; whether the ID is free and the provider usable is the server's to
 * say, and its refusal is shown as it is, beside the values that caused it.
 */
export const AddGatewayModelForm = ({ providers, disabled, onAdd }: {
  /** The providers a model may be added under. Not empty. */
  providers: readonly AiModelProvider[]
  /** Whether the form is locked, because a write to the models is in flight. */
  disabled: boolean
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

  const idRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const contextWindowRef = useRef<HTMLInputElement>(null)
  const outputLimitRef = useRef<HTMLInputElement>(null)

  const provider = providers.includes(chosenProvider) ? chosenProvider : providers[0]
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
    setId('')
    setName('')
    setContextWindow('')
    setOutputLimit('')
    setSubmitAttempted(false)
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Select<AiModelProvider>
        label="Provider"
        className="w-full"
        disabled={disabled}
        value={provider}
        onValueChange={(value) => {
          if (value) setChosenProvider(value)
          setRefusal(null)
        }}
        renderValue={(value) => PROVIDER_LABELS[value]}
      >
        {providers.map((option) => (
          <Select.Option key={option} value={option}>
            {PROVIDER_LABELS[option]}
          </Select.Option>
        ))}
      </Select>
      <Input
        ref={idRef}
        label="Model ID"
        description="The model’s name in the provider’s API. Chats and preferences refer to the model by it."
        value={id}
        disabled={disabled}
        onChange={edit(setId)}
        error={idError}
        aria-invalid={idError !== undefined}
      />
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
