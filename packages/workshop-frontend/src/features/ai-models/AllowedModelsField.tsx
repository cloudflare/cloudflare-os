import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Button } from '@cloudflare/kumo'
import { Cpu, Plus } from '@phosphor-icons/react'
import type { AiModelProvider } from '@gadgets/workshop-shared/api'
import { ComposerChip } from '../../components/ComposerChip'
import { isImeComposing } from '../../keyboardEvent'
import {
  PROVIDER_LABELS,
  isAllowedModelName,
  parseAllowedModels,
  type AllowedModelSuggestion,
} from './modelForm'
import { useFieldErrorAlert } from './useFieldErrorAlert'

const POOL_DOCS = 'https://developers.cloudflare.com/ai-gateway/features/auto-router/#models'

const malformedError = (name: string) =>
  `“${name}” is not a gateway model name. Name each model as provider/model, like ` +
  'anthropic/claude-sonnet-5.5, or a provider’s every model, like anthropic/*'

// An option of the listbox: a suggested name, or the typed text added as it is.
type Option = AllowedModelSuggestion & { typed: boolean }

/**
 * The gateway models the Auto Router model may pick, staged as chips the way the Share dialog
 * stages people: picked from suggested names, or typed as the gateway names them and added with
 * Enter or a comma. An empty list leaves the router every model of the providers that are on,
 * which the field names so the admin can see the pool the rule resolves to.
 */
export const AllowedModelsField = ({ modelName, allowedModels, providers, suggestions, busy, onChange }: {
  modelName: string
  /** The list the server holds, or undefined while the router picks among the enabled providers. */
  allowedModels: string[] | undefined
  /** The providers that are on, whose models the router picks among while the list is unset. */
  providers: readonly AiModelProvider[]
  /** The names offered as the admin types. Any other name can still be added as typed. */
  suggestions: readonly AllowedModelSuggestion[]
  busy: boolean
  /** Called with the list to store, or undefined to unset it. */
  onChange: (allowedModels: string[] | undefined) => void
}) => {
  // The staged names, or null while the field shows the server's list.
  const [draft, setDraft] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
  // The typed text that was refused, which the field reports until the text changes.
  const [refused, setRefused] = useState<string | null>(null)
  const [listDismissed, setListDismissed] = useState(true)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const facts = useId()
  const listboxId = useId()
  const alert = useFieldErrorAlert()

  const names = draft ?? allowedModels ?? []
  const typed = query.trim()
  const lowered = typed.toLowerCase()
  const matches = suggestions.filter(({ name, description }) => !names.includes(name) &&
    (name.toLowerCase().includes(lowered) || description.toLowerCase().includes(lowered)))
  const options: Option[] = [
    ...matches.map((suggestion) => ({ ...suggestion, typed: false })),
    ...(typed && !names.includes(typed) && !matches.some(({ name }) => name === typed)
      ? [{ name: typed, description: 'Use the text as a gateway model name', typed: true }]
      : []),
  ]
  const open = !listDismissed && !busy && options.length > 0
  const active = Math.min(activeIndex, options.length - 1)
  const error = refused !== null ? malformedError(refused) : undefined
  const optionId = (index: number) => `${listboxId}-option-${index}`

  const stage = (next: string[]) => {
    setDraft(next)
    alert.clear()
  }

  const editQuery = (text: string) => {
    setQuery(text)
    setRefused(null)
    setActiveIndex(0)
    setListDismissed(false)
    alert.clear()
  }

  // Stage `text`, one name or a comma-separated list, and keep in the field what is no name, so
  // that it can be corrected. Returns the names staged with it, or null when some of it was refused.
  const add = (text: string): string[] | null => {
    const entries = text.split(',').map((entry) => entry.trim()).filter(Boolean)
    const bad = entries.find((entry) => !isAllowedModelName(entry))
    const parsed = parseAllowedModels(entries.filter((entry) => entry !== bad).join(','))
    const next = [...names]
    for (const name of 'names' in parsed ? parsed.names : []) {
      if (!next.includes(name)) next.push(name)
    }
    if (next.length !== names.length) stage(next)
    setQuery(bad ?? '')
    setRefused(bad ?? null)
    setActiveIndex(0)
    if (bad === undefined) return next
    alert.pointAt(inputRef.current, malformedError(bad))
    return null
  }

  const remove = (name: string) => {
    stage(names.filter((staged) => staged !== name))
    inputRef.current?.focus()
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const saved = typed ? add(typed) : names
    if (saved === null) return
    setDraft(null)
    setListDismissed(true)
    const list = saved.length > 0 ? saved : undefined
    if (list?.join(',') !== allowedModels?.join(',')) onChange(list)
  }

  const reset = () => {
    setDraft(null)
    setQuery('')
    setRefused(null)
    alert.clear()
    // The button leaves with the list it resets, so focus moves to the field first.
    inputRef.current?.focus()
    onChange(undefined)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (busy || isImeComposing(event)) return
    if (event.key === 'Enter' && typed) {
      // Enter with nothing typed saves the list, as the form's submit.
      event.preventDefault()
      const option = open ? options[active] : undefined
      add(option?.name ?? typed)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setListDismissed(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setListDismissed(false)
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((active + step + options.length) % options.length)
    } else if (event.key === 'Backspace' && query === '' && names.length > 0) {
      stage(names.slice(0, -1))
    }
  }

  return (
    <form noValidate onSubmit={save} className="grid content-start gap-2 sm:col-span-2">
      <label htmlFor={inputId} className="m-0 text-base font-medium text-kumo-default select-none">
        Allowed models<span className="sr-only"> for {modelName}</span>
      </label>
      <div>
        <div
          className={`flex min-h-12 items-center gap-2 rounded-2xl border bg-kumo-base p-1.5 pl-3 transition-[border-color,box-shadow] ${
            error ? 'border-kumo-danger' : 'border-kumo-line/80 focus-within:border-kumo-fill'
          }`}
        >
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
            <Cpu size={15} weight="duotone" />
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {names.map((name) => (
              <ComposerChip
                key={name}
                label={name}
                removeLabel={`Remove ${name} from the allowed models of ${modelName}`}
                disabled={busy}
                onRemove={() => remove(name)}
              />
            ))}
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              role="combobox"
              placeholder={names.length > 0
                ? 'Add a model'
                : 'Every model of the providers that are on'}
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? listboxId : undefined}
              aria-activedescendant={open ? optionId(active) : undefined}
              aria-invalid={error !== undefined}
              aria-describedby={facts}
              value={query}
              disabled={busy}
              onChange={(event) => {
                const text = event.target.value
                // A comma ends a name, so a typed or pasted list is staged as it comes.
                if (text.includes(',')) {
                  setListDismissed(false)
                  const cut = text.lastIndexOf(',')
                  if (add(text.slice(0, cut)) !== null) setQuery(text.slice(cut + 1).trimStart())
                } else {
                  editQuery(text)
                }
              }}
              onFocus={() => setListDismissed(false)}
              onBlur={() => setListDismissed(true)}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              className="h-9 min-w-0 grow basis-40 appearance-none border-0 bg-transparent p-0 font-mono text-[13px] leading-5 text-kumo-default outline-none placeholder:font-sans placeholder:text-kumo-inactive disabled:cursor-not-allowed"
            />
          </div>
        </div>
        {open && (
          <div
            id={listboxId}
            role="listbox"
            aria-label={`Models to allow ${modelName}`}
            // In the page's flow rather than floating, since the settings panel clips what
            // overflows it. Pressing in the list must not blur the field, which would close the
            // list before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            className="mt-2 max-h-64 overflow-y-auto overscroll-contain rounded-xl border border-kumo-line/70 bg-kumo-base p-2"
          >
            {options.map((option, index) => (
              <button
                key={`${option.typed}:${option.name}`}
                id={optionId(index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => add(option.name)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${
                  option.typed && index > 0 ? 'mt-1 border-t border-kumo-line/60' : ''
                } ${index === active ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/70'}`}
              >
                {option.typed && <Plus size={15} className="shrink-0 text-kumo-subtle" />}
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[13px] text-kumo-default">
                    {option.typed ? <>Add &ldquo;{option.name}&rdquo; exactly</> : option.name}
                  </span>
                  <span className="block truncate text-[11px] text-kumo-subtle">
                    {option.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <p id={facts} className="text-sm leading-snug text-kumo-subtle">
        {error !== undefined && <span className="block text-kumo-danger">{error}</span>}
        {providers.length > 0 ? (
          <>
            With none listed, Auto picks from every model of the providers that are on (
            {providers.map((provider) => PROVIDER_LABELS[provider]).join(', ')}) in{' '}
            <a href={POOL_DOCS} target="_blank" rel="noreferrer" className="underline">
              Cloudflare’s model pool
            </a>
            .
          </>
        ) : (
          <>No provider is on for Auto to pick from: turn one on above.</>
        )}{' '}
        To narrow it, add a provider’s every model, or type a model’s gateway name and press
        Enter: <span className="font-mono">anthropic/claude-sonnet-5.5</span>,{' '}
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
