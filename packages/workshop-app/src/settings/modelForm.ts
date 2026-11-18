import {
  SUGGESTED_MODELS,
  modelKind,
  type AiChatAuthorInfo,
  type AiGatewayInfo,
  type AiModelProvider,
  type RedactedAiModelConfig,
} from '@gadgets/workshop-shared/api'

/** A model the user added, as `getModelConfig()` reads it: its secrets withheld, as `null`. */
export type ModelSource = { profile: AiChatAuthorInfo; config: RedactedAiModelConfig }

/** Adding a model from nothing, changing one of the user's, or adding another like one of theirs, its saved keys and all. */
export type ModelDialogMode =
  | { kind: 'add' }
  | { kind: 'edit' | 'duplicate'; source: ModelSource }

/**
 * One extra header sent to the provider. `id` keeps its row while others are taken out. A `null`
 * value keeps the one saved for the header called `savedName`, which the client never has: the
 * server matches it by name, so it is kept only while the row keeps that name.
 */
export type HeaderRow = { id: number; name: string; value: string | null; savedName?: string }

/** What is typed into the model dialog. Numbers are kept as typed and read when it is saved. */
export type ModelForm = {
  provider: AiModelProvider | undefined
  /** What the provider calls the model. */
  model: string
  /** What it is called here; blank, it is called what the Workshop knows it as, or else its model id. */
  name: string
  /** `null` keeps the saved key, while the provider and address are what it was saved for. */
  apiToken: string | null
  accountId: string
  apiUrl: string
  headers: HeaderRow[]
  contextWindow: string
  outputLimit: string
}

/** What the dialog is told of the deployment. */
export type ModelFormContext = {
  /** Requests go through the deployment's AI Gateway, with its keys: no key, address or header is asked for. */
  gateway: boolean
  mode: ModelDialogMode
}

/** What is saved: the call, and what it is given. */
export type ModelSave =
  | { kind: 'add'; profile: AiChatAuthorInfo; config: RedactedAiModelConfig; copySecretsFrom?: string }
  | { kind: 'update'; profile: AiChatAuthorInfo; config: RedactedAiModelConfig }

/** Each provider's name as the dialog says it. */
export const PROVIDER_NAMES: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
  'cloudflare-auto-router': 'AI Gateway Auto Router',
}

/** Where Ollama runs on the user’s own machine, unless they moved it. */
export const OLLAMA_URL = 'http://localhost:11434'

/**
 * Whether the user may add models of their own: always without AI Gateway, where the models are
 * all theirs, and with it only where its admin allows.
 */
export const userModelsAllowed = (info: AiGatewayInfo) => !info.enabled || info.userModelsEnabled

/**
 * The providers a model can be added under. The Auto Router's one model is the deployment's alone,
 * and with AI Gateway only the providers it enables can be used.
 */
export const providerChoices = (info: AiGatewayInfo): AiModelProvider[] =>
  (Object.keys(SUGGESTED_MODELS) as AiModelProvider[]).filter((provider) =>
    provider !== 'cloudflare-auto-router' && (!info.enabled || info.enabledProviders.includes(provider)))

/**
 * The models the Workshop knows of a provider, offered by name, that can chat. None with AI
 * Gateway, whose deployment offers them already, so that one only adds a model it does not.
 */
export const knownModels = (provider: AiModelProvider, gateway: boolean): { id: string; name: string }[] =>
  gateway ? [] : Object.entries(SUGGESTED_MODELS[provider])
    .filter(([id, model]) => !model.hidden && modelKind(provider, id) === 'language')
    .map(([id, { name }]) => ({ id, name }))

// Providers that can send no key at all, so that a proxy the extra headers sign in to can add its
// own. Google's always sends one, and Workers AI cannot be sent to a proxy.
const KEY_OPTIONAL_WITH_HEADERS: ReadonlySet<AiModelProvider> = new Set(['anthropic', 'openai'])

/** What the dialog asks for of a provider. */
export type ProviderFields = {
  /** Its API key: needed, possible or not asked for. */
  key: 'required' | 'optional' | 'none'
  /** The Cloudflare account it bills, for Workers AI, whose address is the account's. */
  accountId: boolean
  /** Its address: where it runs (Ollama), one to send it by instead, or none. */
  apiUrl: 'required' | 'optional' | 'none'
  headers: boolean
}

let nextRowId = 0

/** An empty header row. */
export const newHeaderRow = (): HeaderRow => ({ id: nextRowId++, name: '', value: '' })

const hasHeaders = (rows: readonly HeaderRow[]) => rows.some((row) => row.name.trim() !== '')

/** What the dialog asks for of `provider`, which with extra headers may make its key optional. */
export const fieldsOf = (provider: AiModelProvider, gateway: boolean, headers: readonly HeaderRow[] = []): ProviderFields => {
  if (gateway) return { key: 'none', accountId: false, apiUrl: 'none', headers: false }
  const keyOptional = provider === 'ollama' || (KEY_OPTIONAL_WITH_HEADERS.has(provider) && hasHeaders(headers))
  return {
    key: keyOptional ? 'optional' : 'required',
    accountId: provider === 'cloudflare',
    apiUrl: provider === 'ollama' ? 'required' : provider === 'cloudflare' ? 'none' : 'optional',
    headers: true,
  }
}

const sourceOf = (mode: ModelDialogMode) => (mode.kind === 'add' ? undefined : mode.source)

/**
 * Whether the saved key and headers can still be kept: the server keeps them only for the
 * provider and address they were saved for, or anyone could send them to a server of their own.
 */
export const savedSecretsUsable = (form: Pick<ModelForm, 'provider' | 'apiUrl'>, mode: ModelDialogMode) => {
  const source = sourceOf(mode)
  return source !== undefined && form.provider === source.config.provider && form.apiUrl.trim() === (source.config.apiUrl ?? '')
}

/** Whether the key field stands for a saved key, which is kept unless something is typed over it. */
export const keyIsSaved = (form: ModelForm, mode: ModelDialogMode) => form.apiToken === null && savedSecretsUsable(form, mode)

/** Whether a header row's value stands for a saved one, which it keeps. */
export const headerIsSaved = (row: HeaderRow, usable: boolean) =>
  usable && row.value === null && row.savedName !== undefined && row.name.trim() === row.savedName

/** A row with another name, which loses the saved value: that is the old name's. */
export const renameHeader = (row: HeaderRow, name: string): HeaderRow =>
  row.value === null && name.trim() !== row.savedName ? { ...row, name, value: '' } : { ...row, name }

const EMPTY: ModelForm = { provider: undefined, model: '', name: '', apiToken: '', accountId: '', apiUrl: '', headers: [], contextWindow: '', outputLimit: '' }

/**
 * What the dialog starts with. A model being changed starts as it is, its saved key and headers
 * kept. One added like another keeps its provider, key, account, address and headers, but not
 * which model it is or its limits, which are that model's.
 */
export const formOf = (mode: ModelDialogMode): ModelForm => {
  if (mode.kind === 'add') return EMPTY
  const { profile, config } = mode.source
  const editing = mode.kind === 'edit'
  return {
    provider: config.provider,
    model: editing ? config.model : '',
    name: editing ? profile.name : '',
    apiToken: config.apiToken,
    accountId: config.accountId ?? '',
    apiUrl: config.apiUrl ?? '',
    headers: Object.entries(config.extraHeaders ?? {}).map(([name, value]) =>
      ({ id: nextRowId++, name, value, ...(value === null && { savedName: name }) })),
    contextWindow: editing && config.contextWindow !== undefined ? String(config.contextWindow) : '',
    outputLimit: editing && config.outputLimit !== undefined ? String(config.outputLimit) : '',
  }
}

/** The form for another provider: what was typed for one says nothing of the next, but for the name. */
export const withProvider = (form: ModelForm, provider: AiModelProvider): ModelForm =>
  ({ ...EMPTY, name: form.name, provider, apiUrl: provider === 'ollama' ? OLLAMA_URL : '' })

/** A number of tokens as typed, with or without its thousands set apart: `undefined` when blank, `null` when not a whole number above nought. */
export const parseTokens = (typed: string): number | undefined | null => {
  const digits = typed.replace(/[\s,._]/g, '')
  if (digits === '') return undefined
  if (!/^\d+$/.test(digits)) return null
  const value = Number(digits)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

// An HTTP header's name (RFC 9110, section 5.1).
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Why each part of the form could not be saved as it is, by field, and by row for the headers. */
export type ModelFormProblems = {
  provider?: string
  model?: string
  apiToken?: string
  accountId?: string
  apiUrl?: string
  contextWindow?: string
  outputLimit?: string
  headers: Record<number, string>
}

/** Whether there is nothing in the way of saving. */
export const noProblems = ({ headers, ...fields }: ModelFormProblems) =>
  Object.keys(headers).length === 0 && Object.values(fields).every((problem) => problem === undefined)

const headerProblems = (rows: readonly HeaderRow[], usable: boolean) => {
  const problems: Record<number, string> = {}
  const seen = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) {
      if (row.value?.trim()) problems[row.id] = 'Enter a name for this header.'
      continue
    }
    // Header names are the same whatever their case, so two rows would be one header.
    const key = name.toLowerCase()
    if (!HEADER_NAME.test(name)) problems[row.id] = 'A header’s name can’t have spaces or characters such as “:”.'
    else if (seen.has(key)) problems[row.id] = `There’s already a header called ${name}.`
    else if (row.value === null && !headerIsSaved(row, usable)) problems[row.id] = 'Enter this header’s value again, as the address changed.'
    seen.add(key)
  }
  return problems
}

/** Why the form cannot be saved as it is, which is nothing in a form that can. */
export const problemsOf = (form: ModelForm, { gateway, mode }: ModelFormContext): ModelFormProblems => {
  const problems: ModelFormProblems = { headers: {} }
  const { provider } = form
  if (!provider) return { ...problems, provider: 'Choose a provider.' }
  const model = form.model.trim()
  const fields = fieldsOf(provider, gateway, form.headers)
  const usable = savedSecretsUsable(form, mode)

  if (!model) problems.model = 'Choose a model, or enter its name as the provider gives it.'
  // The models listed are those that can chat, so one that can only decide would not be shown.
  else if (mode.kind !== 'edit' && modelKind(provider, model) === 'decision') problems.model = 'This model can’t chat, so it can’t be added here.'

  if (fields.key === 'required') {
    if (form.apiToken === null && !usable) problems.apiToken = 'Enter the API key again, as the address changed.'
    else if (form.apiToken !== null && form.apiToken.trim() === '') problems.apiToken = `Enter your ${PROVIDER_NAMES[provider]} API key.`
  }
  if (fields.accountId && !form.accountId.trim()) problems.accountId = 'Enter your Cloudflare account ID.'
  if (fields.apiUrl === 'required' && !form.apiUrl.trim()) problems.apiUrl = 'Enter the address Ollama runs at.'
  if (parseTokens(form.contextWindow) === null) problems.contextWindow = 'Enter a whole number of tokens, such as 200,000.'
  if (parseTokens(form.outputLimit) === null) problems.outputLimit = 'Enter a whole number of tokens, such as 8,000.'
  if (fields.headers) problems.headers = headerProblems(form.headers, usable)
  return problems
}

/** What the model is called where the form leaves it blank: what the Workshop knows it as, or its model id. */
export const defaultNameOf = (provider: AiModelProvider | undefined, model: string) =>
  (provider && SUGGESTED_MODELS[provider][model.trim()]?.name) || model.trim()

/**
 * What saving the form sends, for a form with no problems (`problemsOf`). A saved key or header is
 * sent as `null`, which keeps it, only while it can be kept, and a duplicate copies its from the
 * model it was made from: the client never has them. A model keeps its id when it is changed, as
 * chats and settings know it by that.
 */
export const saveOf = (form: ModelForm, { gateway, mode }: ModelFormContext): ModelSave => {
  const provider = form.provider!
  const fields = fieldsOf(provider, gateway, form.headers)
  const usable = savedSecretsUsable(form, mode)
  const model = mode.kind === 'edit' ? mode.source.config.model : form.model.trim()
  const name = form.name.trim() || defaultNameOf(provider, model)

  const headers = fields.headers
    ? form.headers.filter((row) => row.name.trim()).map((row) => [row.name.trim(), headerIsSaved(row, usable) ? null : (row.value ?? '').trim()] as const)
    : []
  const token = fields.key === 'none' ? '' : form.apiToken === null ? (usable ? null : '') : form.apiToken.trim()
  const contextWindow = parseTokens(form.contextWindow)
  const outputLimit = parseTokens(form.outputLimit)
  const config: RedactedAiModelConfig = {
    provider,
    model,
    apiToken: token,
    ...(fields.accountId && form.accountId.trim() && { accountId: form.accountId.trim() }),
    ...(fields.apiUrl !== 'none' && form.apiUrl.trim() && { apiUrl: form.apiUrl.trim() }),
    ...(headers.length > 0 && { extraHeaders: Object.fromEntries(headers) }),
    ...(contextWindow && { contextWindow }),
    ...(outputLimit && { outputLimit }),
  }

  if (mode.kind === 'edit') return { kind: 'update', profile: { ...mode.source.profile, name }, config }
  const profile: AiChatAuthorInfo = { type: 'agent', id: model, name }
  const keepsSecrets = config.apiToken === null || Object.values(config.extraHeaders ?? {}).includes(null)
  return mode.kind === 'duplicate' && keepsSecrets
    ? { kind: 'add', profile, config, copySecretsFrom: mode.source.profile.id }
    : { kind: 'add', profile, config }
}
