import { useId, useRef, useState, type FormEvent } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import type { AiModelProvider } from '@gadgets/workshop-shared/api'
import { PROVIDER_LABELS, parseAllowedModels } from './modelForm'
import { useFieldErrorAlert } from './useFieldErrorAlert'

const POOL_DOCS = 'https://developers.cloudflare.com/ai-gateway/features/auto-router/#models'

const malformedError = (name: string) =>
  `“${name}” is not a gateway model name. Name each model as provider/model, like ` +
  'anthropic/claude-sonnet-5.5, or a provider’s every model, like anthropic/*'

/**
 * The gateway models the Auto Router model may pick, edited as one comma-separated line the way
 * the gateway's own allow-list takes them. Blank leaves the router every model of the providers
 * that are on, which the field names so the admin can see the pool the rule resolves to.
 */
export const AllowedModelsField = ({ modelName, allowedModels, providers, busy, onChange }: {
  modelName: string
  /** The list the server holds, or undefined while the router picks among the enabled providers. */
  allowedModels: string[] | undefined
  /** The providers that are on, whose models the router picks among while the list is unset. */
  providers: readonly AiModelProvider[]
  busy: boolean
  /** Called with the list to store, or undefined to unset it. */
  onChange: (allowedModels: string[] | undefined) => void
}) => {
  // What is typed into the field, or null while the field shows the server's list.
  const [draft, setDraft] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const facts = useId()
  const alert = useFieldErrorAlert()

  const held = allowedModels?.join(', ') ?? ''
  const text = draft ?? held
  const parsed = parseAllowedModels(text)
  const error = 'malformed' in parsed ? malformedError(parsed.malformed) : undefined

  const edit = (next: string | null) => {
    setDraft(next)
    alert.clear()
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!('names' in parsed)) {
      alert.pointAt(ref.current, error!)
      return
    }
    edit(null)
    const saved = parsed.names.length > 0 ? parsed.names : undefined
    if (saved?.join(',') !== allowedModels?.join(',')) onChange(saved)
  }

  const reset = () => {
    edit(null)
    // The button leaves with the list it resets, so focus moves to the field first.
    ref.current?.focus()
    onChange(undefined)
  }

  return (
    <form noValidate onSubmit={save} className="grid content-start gap-2 sm:col-span-2">
      <Input
        ref={ref}
        label={<>Allowed models<span className="sr-only"> for {modelName}</span></>}
        placeholder="Every model of the providers that are on"
        value={text}
        disabled={busy}
        onChange={(event) => edit(event.target.value)}
        error={error}
        aria-invalid={error !== undefined}
        aria-describedby={facts}
      />
      <p id={facts} className="text-sm leading-snug text-kumo-subtle">
        {providers.length > 0 ? (
          <>
            Left blank, Auto picks from every model of the providers that are on (
            {providers.map((provider) => PROVIDER_LABELS[provider]).join(', ')}) in{' '}
            <a href={POOL_DOCS} target="_blank" rel="noreferrer" className="underline">
              Cloudflare’s model pool
            </a>
            .
          </>
        ) : (
          <>No provider is on for Auto to pick from: turn one on above.</>
        )}{' '}
        To narrow it, list models by their gateway names, separated by commas:{' '}
        <span className="font-mono">anthropic/claude-sonnet-5.5</span>,{' '}
        <span className="font-mono">anthropic/*</span> or{' '}
        <span className="font-mono">@cf/*/*</span>. Disabling a model above doesn’t take it out
        of the pool; listing does. After saving, press Test: a name the gateway doesn’t know
        fails every request.
      </p>
      {alert.alert}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={busy}
          aria-label={`Save the allowed models of ${modelName}`}
        >
          Save
        </Button>
        {allowedModels !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`Reset the allowed models of ${modelName}`}
            onClick={reset}
          >
            Reset
          </Button>
        )}
      </div>
    </form>
  )
}
