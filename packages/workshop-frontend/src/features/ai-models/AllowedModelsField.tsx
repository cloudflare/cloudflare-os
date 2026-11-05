import {
  useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent,
} from 'react'
import { Button } from '@cloudflare/kumo'
import { Cpu, Plus } from '@phosphor-icons/react'
import type { AiModelProvider } from '@gadgets/workshop-shared/api'
import { ComposerChip } from '../../components/ComposerChip'
import { isImeComposing } from '../../keyboardEvent'
import {
  PROVIDER_LABELS,
  isAllowedModelName,
  type AllowedModelSuggestion,
} from './modelForm'
import { useFieldErrorAlert } from './useFieldErrorAlert'

const POOL_DOCS = 'https://developers.cloudflare.com/ai-gateway/features/auto-router/#models'

const malformedError = (name: string) =>
  `“${name}” is not a gateway model name. Name each model as provider/model, like ` +
  'anthropic/claude-sonnet-5.5, or a provider’s every model, like anthropic/*'

const commas = (text: string) => text.split(',').length - 1

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
  // The staged names and the server's list they were staged from, or null while the field shows
  // the server's list. A draft is shown only while the server's list is still the one it was
  // staged from, so a save the server refuses keeps it and one that lands retires it.
  const [draft, setDraft] = useState<{ from: string; names: string[] } | null>(null)
  const [query, setQuery] = useState('')
  // The typed text that was refused, which the field reports until the text changes.
  const [refused, setRefused] = useState<string | null>(null)
  const [listDismissed, setListDismissed] = useState(true)
  // The highlighted option, or -1 for none: with nothing typed, none is until the arrow keys pick
  // one, so that Enter in an empty field saves the list.
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  // Whether a pointer is pressed anywhere on the page while the list is open.
  const pressing = useRef(false)
  const listboxRef = useRef<HTMLDivElement>(null)
  // Set when the arrow keys move the highlight, whose option the list then scrolls to.
  const revealActive = useRef(false)
  const inputId = useId()
  const facts = useId()
  const listboxId = useId()
  const alert = useFieldErrorAlert()

  const held = (allowedModels ?? []).join(',')
  const names = draft !== null && draft.from === held ? draft.names : allowedModels ?? []
  const typed = query.trim()
  const lowered = typed.toLowerCase()
  const matches = suggestions.filter(({ name, description }) => !names.includes(name) &&
    (name.toLowerCase().includes(lowered) || description.toLowerCase().includes(lowered)))
  const typedOption: Option[] = typed && !typed.includes(',') && !names.includes(typed) &&
    !matches.some(({ name }) => name === typed)
    ? [{ name: typed, description: 'Use the text as a gateway model name', typed: true }]
    : []
  const suggested = matches.map((suggestion) => ({ ...suggestion, typed: false }))
  // A typed gateway name leads, so that Enter adds what was typed rather than a longer suggestion
  // it is the start of; text that is no such name is a search, whose matches lead.
  const options: Option[] = isAllowedModelName(typed)
    ? [...typedOption, ...suggested]
    : [...suggested, ...typedOption]
  const open = !listDismissed && !busy && options.length > 0
  const active = Math.min(activeIndex, options.length - 1)

  // Scrolls the list, not the page, so that the option the arrow keys highlight can be seen.
  useLayoutEffect(() => {
    if (!revealActive.current) return
    revealActive.current = false
    const list = listboxRef.current
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !option) return
    const listRect = list.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    if (optionRect.top < listRect.top) list.scrollTop -= listRect.top - optionRect.top
    else if (optionRect.bottom > listRect.bottom) list.scrollTop += optionRect.bottom - listRect.bottom
  }, [active, open])

  useEffect(() => {
    if (!open) return
    const press = () => { pressing.current = true }
    const release = () => { pressing.current = false }
    window.addEventListener('pointerdown', press, true)
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    return () => {
      window.removeEventListener('pointerdown', press, true)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
      pressing.current = false
    }
  }, [open])
  const error = refused !== null ? malformedError(refused) : undefined
  const optionId = (index: number) => `${listboxId}-option-${index}`

  const stage = (next: string[]) => {
    setDraft({ from: held, names: next })
    alert.clear()
  }

  const editQuery = (text: string) => {
    setQuery(text)
    setRefused(null)
    setActiveIndex(text.trim() ? 0 : -1)
    setListDismissed(false)
    alert.clear()
  }

  // Stage the names in `text`, one or a comma-separated list, and leave in the field the entries
  // that are no name followed by `rest`, the text after the last comma, so that a refused entry
  // can be corrected without losing anything else typed or pasted. Returns the names staged with
  // it, or null when some of it was refused.
  const add = (text: string, rest = ''): string[] | null => {
    const entries = text.split(',').map((entry) => entry.trim()).filter(Boolean)
    const bad = entries.filter((entry) => !isAllowedModelName(entry))
    const next = [...names]
    for (const entry of entries) {
      if (isAllowedModelName(entry) && !next.includes(entry)) next.push(entry)
    }
    if (next.length !== names.length) stage(next)
    setQuery([...bad, rest.trimStart()].filter(Boolean).join(', '))
    setRefused(bad[0] ?? null)
    setActiveIndex(-1)
    if (bad.length === 0) return next
    alert.pointAt(inputRef.current, malformedError(bad[0]))
    return null
  }

  // Close the list once focus leaves the field. A press elsewhere takes focus before its click
  // lands, and the list sits in the page's flow, so closing it at once would move what is under
  // the pointer, such as Save, and the click would miss; the list waits for the press to end.
  const dismissOnBlur = () => {
    if (!pressing.current) {
      setListDismissed(true)
      return
    }
    const done = () => {
      window.removeEventListener('pointerup', done, true)
      window.removeEventListener('pointercancel', done, true)
      // After the click the release dispatches, unless that click brought focus back.
      setTimeout(() => {
        if (document.activeElement !== inputRef.current) setListDismissed(true)
      })
    }
    window.addEventListener('pointerup', done, true)
    window.addEventListener('pointercancel', done, true)
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
    const option = open && active >= 0 ? options[active] : undefined
    if (event.key === 'Enter' && (option || typed)) {
      // Enter with nothing typed or highlighted saves the list, as the form's submit.
      event.preventDefault()
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
      revealActive.current = true
      const step = event.key === 'ArrowDown' ? 1 : -1
      const from = active >= 0 ? active : step > 0 ? -1 : 0
      setActiveIndex((from + step + options.length) % options.length)
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
              aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
              aria-invalid={error !== undefined}
              aria-describedby={facts}
              value={query}
              disabled={busy}
              onChange={(event) => {
                const text = event.target.value
                // A comma ends a name, so a typed or pasted list is staged as it comes.
                // Only a comma just typed or pasted ends a name: editing an entry before one, such
                // as a refused entry being corrected, leaves the field as typed until it is
                // added with Enter, Save or another comma.
                if (commas(text) > commas(query)) {
                  setListDismissed(false)
                  const cut = text.lastIndexOf(',')
                  add(text.slice(0, cut), text.slice(cut + 1))
                } else {
                  editQuery(text)
                }
              }}
              onFocus={() => setListDismissed(false)}
              onBlur={dismissOnBlur}
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
            ref={listboxRef}
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
