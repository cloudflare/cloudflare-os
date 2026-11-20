import { useId, useState, type ReactNode } from 'react'
import { PlusIcon, XIcon } from '@phosphor-icons/react'
import type { AiModelProvider } from '@gadgets/workshop-shared/api'
import { Banner, Button, Dialog, Select, TextField } from '@gadgets/ui'
import { Disclosure } from '@/components/Disclosure'
import { SecretField } from '@/components/SecretField'
import {
  PROVIDER_NAMES, defaultNameOf, fieldsOf, formOf, headerIsSaved, keyIsSaved, knownModels, newHeaderRow, noProblems,
  problemsOf, renameHeader, saveOf, savedSecretsUsable, withProvider,
  type HeaderRow, type ModelDialogMode, type ModelForm, type ModelFormProblems, type ModelSave,
} from './modelForm'

/** A model to change or copy that is still being read, or could not be, and why. */
export type ModelDialogReading = { kind: 'edit' | 'duplicate'; reading: true; problem?: string }

export type ModelDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: ModelDialogMode | ModelDialogReading
  /** The providers a model can be added under. */
  providers: readonly AiModelProvider[]
  /** Requests go through the deployment's AI Gateway, with its keys: none are asked for. */
  gateway: boolean
  /**
   * Saves it, holding the dialog while it does, and leaving it open under why if it cannot.
   * Resolving `false` says it was not tried, as over a lost connection, which leaves it as it was.
   */
  onSave: (save: ModelSave) => Promise<boolean | void>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Chosen for a model the Workshop does not know, typed in. No model is called this.
const OTHER = '::other'

// What each provider's keys start with, so that the right one is pasted.
const KEY_PLACEHOLDER: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
  google: 'AIza…',
  cloudflare: 'API token',
  ollama: 'Optional',
  'cloudflare-auto-router': '',
}

const KEY_HINT: Partial<Record<AiModelProvider, string>> = {
  cloudflare: 'A Cloudflare API token that can use Workers AI.',
  ollama: 'Only if your Ollama server asks for one.',
}

// What a model's name at the provider looks like, for one the Workshop does not know any of.
const exampleModel = (provider: AiModelProvider, gateway: boolean) => knownModels(provider, gateway)[0]?.id ?? (provider === 'ollama' ? 'gemma4:31b' : 'model-name')

const TITLE = { add: 'Add model', edit: 'Edit model', duplicate: 'Duplicate model' }

/** A field's label, the field, and under it what it is for or, once it was tried, why it cannot be kept. */
const Field = ({ hint, problem, children }: { hint?: string; problem?: string; children: (describedBy: string | undefined) => ReactNode }) => {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      {children(hint || problem ? id : undefined)}
      {problem
        ? <p id={id} role="alert" className="text-sm text-pretty text-kumo-danger">{problem}</p>
        : hint && <p id={id} className="text-sm text-pretty text-kumo-subtle">{hint}</p>}
    </div>
  )
}

/** A choice on one line: what it is at the start, what it is set by at the end, as on a settings card. */
const ChoiceRow = ({ title, problem, children }: { title: string; problem?: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium text-kumo-default">{title}</span>
      {children}
    </div>
    {problem && <p role="alert" className="text-sm text-pretty text-kumo-danger">{problem}</p>}
  </div>
)

/** The extra headers, a row each: its name, its value, which may be a saved one, and the way to take it out. */
const HeaderRows = ({ rows, usable, problems, disabled, onChange }: {
  rows: readonly HeaderRow[]
  usable: boolean
  problems: Record<number, string>
  disabled: boolean
  onChange: (rows: HeaderRow[]) => void
}) => {
  const update = (id: number, change: (row: HeaderRow) => HeaderRow) => onChange(rows.map((row) => (row.id === id ? change(row) : row)))
  const titleId = useId()
  // A group rather than a fieldset, whose legend will not be laid out as the lines under it are.
  return (
    <div role="group" aria-labelledby={titleId} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span id={titleId} className="text-sm font-medium text-kumo-default">Extra headers</span>
        <p className="text-sm text-pretty text-kumo-subtle">Sent with every request, such as a key for a proxy. They replace the provider’s own of the same name.</p>
      </div>
      {rows.map((row) => (
        <div key={row.id} className="flex flex-col gap-1.5">
          <div className="flex items-end gap-2">
            <span className="min-w-0 flex-1">
              <TextField aria-label="Header name" placeholder="Name" autoComplete="off" spellCheck={false} disabled={disabled} invalid={problems[row.id] !== undefined} value={row.name} onValueChange={(name) => update(row.id, (each) => renameHeader(each, name))} />
            </span>
            <span className="min-w-0 flex-1">
              <SecretField aria-label="Header value" placeholder="Value" disabled={disabled} saved={headerIsSaved({ ...row, value: null }, usable)} value={row.value} onValueChange={(value) => update(row.id, (each) => ({ ...each, value }))} />
            </span>
            <Button variant="ghost" icon={<XIcon weight="bold" />} aria-label={`Remove ${row.name.trim() || 'this header'}`} disabled={disabled} onClick={() => onChange(rows.filter(({ id }) => id !== row.id))} className="text-kumo-subtle" />
          </div>
          {problems[row.id] && <p role="alert" className="text-sm text-pretty text-kumo-danger">{problems[row.id]}</p>}
        </div>
      ))}
      <div>
        <Button variant="ghost" icon={PlusIcon} disabled={disabled} onClick={() => onChange([...rows, newHeaderRow()])}>Add header</Button>
      </div>
    </div>
  )
}

// What lies under More options, which opens by itself where something there was set or is wrong.
const MORE: (keyof ModelFormProblems)[] = ['apiUrl', 'contextWindow', 'outputLimit', 'headers']

// The form, which is only there while the dialog is open: it starts over each time.
const ModelFormContent = ({ mode, providers, gateway, onSave, onDone }: Omit<ModelDialogProps, 'open' | 'onOpenChange' | 'mode'> & { mode: ModelDialogMode; onDone: () => void }) => {
  const [form, setForm] = useState<ModelForm>(() => formOf(mode))
  // A model of the provider's that the Workshop does not know, typed in rather than chosen.
  const [other, setOther] = useState(false)
  const [tried, setTried] = useState(false)
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [moreOpen, setMoreOpen] = useState(() =>
    form.headers.length > 0 || form.contextWindow !== '' || form.outputLimit !== '' || (form.apiUrl !== '' && form.provider !== 'ollama'))

  const context = { gateway, mode }
  const problems = problemsOf(form, context)
  const shown: ModelFormProblems = tried ? problems : { headers: {} }
  const { provider } = form
  const fields = provider ? fieldsOf(provider, gateway, form.headers) : undefined
  const known = provider ? knownModels(provider, gateway) : []
  const usable = savedSecretsUsable(form, mode)
  const editing = mode.kind === 'edit'
  const source = mode.kind === 'add' ? undefined : mode.source
  const set = (patch: Partial<ModelForm>) => setForm((current) => ({ ...current, ...patch }))

  const submit = async () => {
    setTried(true)
    if (MORE.some((key) => (key === 'headers' ? Object.keys(problems.headers).length > 0 : problems[key] !== undefined))) setMoreOpen(true)
    if (!noProblems(problems) || pending) return
    setProblem(undefined)
    setPending(true)
    try {
      if (await onSave(saveOf(form, context)) !== false) onDone()
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  const modelField = !provider ? null : editing ? (
    <ChoiceRow title="Model"><span className="min-w-0 truncate text-kumo-subtle">{form.model}</span></ChoiceRow>
  ) : known.length > 0 ? (
    <ChoiceRow title="Model" problem={shown.model}>
      <Select
        aria-label="Model"
        value={other ? OTHER : known.some(({ id }) => id === form.model) ? form.model : ''}
        placeholder="Choose…"
        options={[...known.map(({ id, name }) => ({ id, label: name })), { id: OTHER, label: 'Another model' }]}
        searchable={known.length > 8}
        onValueChange={(id) => {
          setOther(id === OTHER)
          set({ model: id === OTHER ? '' : id })
        }}
        typed={other ? { 'aria-label': 'Model name at the provider', placeholder: exampleModel(provider, gateway), autoComplete: 'off', spellCheck: false, value: form.model, invalid: shown.model !== undefined, onValueChange: (model) => set({ model }) } : undefined}
      />
    </ChoiceRow>
  ) : (
    <Field hint={`As ${PROVIDER_NAMES[provider]} names it.`} problem={shown.model}>
      {(describedBy) => <TextField label="Model" placeholder={exampleModel(provider, gateway)} autoComplete="off" spellCheck={false} disabled={pending} invalid={shown.model !== undefined} aria-describedby={describedBy} value={form.model} onValueChange={(model) => set({ model })} />}
    </Field>
  )

  return (
    <form className="contents" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <header className="flex items-start gap-3 p-6 pb-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium text-kumo-default">{TITLE[mode.kind]}</Dialog.Title>
          <Dialog.Description className="text-sm text-pretty text-kumo-subtle">
            {mode.kind === 'add'
              ? gateway ? 'Add a model from a provider your organization uses that isn’t offered here yet.' : 'Add a model from a provider you have an API key for.'
              : mode.kind === 'edit' ? `Changes to ${source!.profile.name} apply to new messages.` : `A new model with the same provider${gateway ? '' : ' and key'} as ${source!.profile.name}.`}
          </Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>

      <div className="flex min-h-0 grow flex-col gap-5 overflow-y-auto px-6 pb-1">
        {source ? (
          <ChoiceRow title="Provider"><span className="text-kumo-subtle">{PROVIDER_NAMES[source.config.provider]}</span></ChoiceRow>
        ) : (
          <ChoiceRow title="Provider" problem={shown.provider}>
            <Select
              aria-label="Provider"
              value={provider ?? ''}
              placeholder="Choose…"
              options={providers.map((each) => ({ id: each, label: PROVIDER_NAMES[each] }))}
              onValueChange={(next) => {
                if (next === '' || next === provider) return
                setForm((current) => withProvider(current, next))
                setOther(false)
              }}
            />
          </ChoiceRow>
        )}
        {modelField}
        {provider && fields && (
          <>
            <Field hint="Shown when you choose a model." problem={undefined}>
              {(describedBy) => <TextField label="Name" placeholder={defaultNameOf(provider, form.model) || 'What to call it'} disabled={pending} aria-describedby={describedBy} value={form.name} onValueChange={(name) => set({ name })} />}
            </Field>
            {fields.accountId && (
              <Field hint="The Cloudflare account Workers AI bills." problem={shown.accountId}>
                {(describedBy) => <TextField label="Account ID" placeholder="0123456789abcdef0123456789abcdef" autoComplete="off" spellCheck={false} disabled={pending} invalid={shown.accountId !== undefined} aria-describedby={describedBy} value={form.accountId} onValueChange={(accountId) => set({ accountId })} />}
              </Field>
            )}
            {fields.key !== 'none' && (
              <Field
                hint={KEY_HINT[provider] ?? (fields.key === 'optional' ? 'Not needed while the extra headers sign in to a proxy that adds its own.' : `Requests are billed to your ${PROVIDER_NAMES[provider]} account.`)}
                problem={shown.apiToken}
              >
                {(describedBy) => (
                  <SecretField
                    label="API key"
                    placeholder={fields.key === 'optional' ? 'Optional' : KEY_PLACEHOLDER[provider]}
                    // A saved key can be gone back to only while it could be kept.
                    saved={usable && source?.config.apiToken === null}
                    value={form.apiToken === null && !keyIsSaved(form, mode) ? '' : form.apiToken}
                    disabled={pending}
                    invalid={shown.apiToken !== undefined}
                    aria-describedby={describedBy}
                    onValueChange={(apiToken) => set({ apiToken })}
                  />
                )}
              </Field>
            )}
            {fields.apiUrl === 'required' && (
              <Field hint="Where your Ollama server runs." problem={shown.apiUrl}>
                {(describedBy) => <TextField label="Address" type="url" placeholder="http://localhost:11434" autoComplete="off" spellCheck={false} disabled={pending} invalid={shown.apiUrl !== undefined} aria-describedby={describedBy} value={form.apiUrl} onValueChange={(apiUrl) => set({ apiUrl })} />}
              </Field>
            )}
            <Disclosure summary="More options" open={moreOpen} onToggle={() => setMoreOpen(!moreOpen)} className="-ms-2">
              <div className="flex flex-col gap-5 ps-2 pt-3">
                {fields.apiUrl === 'optional' && (
                  <Field hint={source && source.config.apiToken === null ? 'To send requests through a proxy. Changing it means entering the key again.' : 'To send requests through a proxy instead of to the provider.'} problem={shown.apiUrl}>
                    {(describedBy) => <TextField label="Address" type="url" placeholder="https://…" autoComplete="off" spellCheck={false} disabled={pending} aria-describedby={describedBy} value={form.apiUrl} onValueChange={(apiUrl) => set({ apiUrl })} />}
                  </Field>
                )}
                {fields.headers && <HeaderRows rows={form.headers} usable={usable} problems={shown.headers} disabled={pending} onChange={(headers) => set({ headers })} />}
                <Field hint="The most one request may hold. Blank uses the model’s own." problem={shown.contextWindow}>
                  {(describedBy) => <TextField label="Context window, in tokens" inputMode="numeric" placeholder="Model default" disabled={pending} invalid={shown.contextWindow !== undefined} aria-describedby={describedBy} value={form.contextWindow} onValueChange={(contextWindow) => set({ contextWindow })} />}
                </Field>
                <Field hint="The most one answer may hold. Blank uses the model’s own." problem={shown.outputLimit}>
                  {(describedBy) => <TextField label="Answer limit, in tokens" inputMode="numeric" placeholder="Model default" disabled={pending} invalid={shown.outputLimit !== undefined} aria-describedby={describedBy} value={form.outputLimit} onValueChange={(outputLimit) => set({ outputLimit })} />}
                </Field>
              </div>
            </Disclosure>
          </>
        )}
      </div>

      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={`Couldn’t save it: ${problem}`} />}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          <Button type="submit" variant="primary" disabled={pending}>
            {editing ? (pending ? 'Saving…' : 'Save') : (pending ? 'Adding…' : 'Add model')}
          </Button>
        </div>
      </footer>
    </form>
  )
}

/**
 * Where one of the user's own models is added, changed or copied, over the page. What is asked
 * for follows the provider: its key, with Workers AI the account it bills, with Ollama where it
 * runs, and under More options an address to send it by, extra headers and its limits. Nothing is
 * asked of keys where the deployment's AI Gateway has its own. A saved key or header is never
 * shown, only said to be saved, and is kept unless something is typed over it; a copy keeps the
 * original's. It starts over each time it is opened.
 */
export const ModelDialog = ({ open, onOpenChange, mode, ...props }: ModelDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    {'reading' in mode ? (
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-start gap-3">
          <Dialog.Title className="min-w-0 flex-1 text-lg font-medium text-kumo-default">{TITLE[mode.kind]}</Dialog.Title>
          <Dialog.Close render={(close) => <Button {...close} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
        </div>
        {mode.problem
          ? <Banner title={`Couldn’t read the model: ${mode.problem}`} />
          : <p role="status" className="appears-late text-kumo-subtle">Reading the model…</p>}
      </div>
    ) : (
      <ModelFormContent
        key={mode.kind === 'add' ? 'add' : `${mode.kind}:${mode.source.profile.id}`}
        mode={mode}
        {...props}
        onDone={() => onOpenChange(false)}
      />
    )}
  </Dialog>
)
