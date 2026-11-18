import { describe, expect, it } from 'vitest'
import type { AiGatewayInfo } from '@gadgets/workshop-shared/api'
import {
  fieldsOf, formOf, headerIsSaved, keyIsSaved, knownModels, newHeaderRow, noProblems, parseTokens, problemsOf, providerChoices,
  renameHeader, saveOf, userModelsAllowed, withProvider, type ModelDialogMode, type ModelForm, type ModelSource,
} from './modelForm'

const direct = { gateway: false }
const ADD: ModelDialogMode = { kind: 'add' }

const SOURCE: ModelSource = {
  profile: { type: 'agent', id: 'gpt-proxy', name: 'GPT via proxy' },
  config: {
    provider: 'openai',
    model: 'gpt-proxy',
    apiToken: null,
    apiUrl: 'https://proxy.example/v1',
    extraHeaders: { 'X-Proxy-Key': null, 'X-Team': 'design' },
    contextWindow: 128000,
  },
}
const EDIT: ModelDialogMode = { kind: 'edit', source: SOURCE }
const DUPLICATE: ModelDialogMode = { kind: 'duplicate', source: SOURCE }

const form = (patch: Partial<ModelForm>): ModelForm => ({ ...formOf(ADD), ...patch })

describe('userModelsAllowed and providerChoices', () => {
  const gateway: AiGatewayInfo = { enabled: true, enabledProviders: ['anthropic', 'google'], builtInModelIds: [], userModelsEnabled: false }

  it('allows the user’s own models without AI Gateway, and with it only where its admin does', () => {
    expect(userModelsAllowed({ enabled: false })).toBe(true)
    expect(userModelsAllowed(gateway)).toBe(false)
    expect(userModelsAllowed({ ...gateway, userModelsEnabled: true })).toBe(true)
  })

  it('offers every provider but the Auto Router without AI Gateway, and only those it enables with it', () => {
    expect(providerChoices({ enabled: false })).not.toContain('cloudflare-auto-router')
    expect(providerChoices({ enabled: false })).toContain('ollama')
    expect(providerChoices(gateway)).toEqual(['anthropic', 'google'])
  })

  it('offers known chat models by name without AI Gateway only, leaving out those that only decide', () => {
    expect(knownModels('anthropic', false).length).toBeGreaterThan(0)
    expect(knownModels('anthropic', true)).toEqual([])
    expect(knownModels('cloudflare', false).map(({ id }) => id)).not.toContain('@cf/cloudflare/clef')
  })
})

describe('fieldsOf', () => {
  it('asks for no key, address or headers with AI Gateway', () => {
    expect(fieldsOf('openai', true)).toEqual({ key: 'none', accountId: false, apiUrl: 'none', headers: false })
  })

  it('follows the provider', () => {
    expect(fieldsOf('anthropic', false)).toMatchObject({ key: 'required', accountId: false, apiUrl: 'optional' })
    expect(fieldsOf('ollama', false)).toMatchObject({ key: 'optional', apiUrl: 'required' })
    expect(fieldsOf('cloudflare', false)).toMatchObject({ key: 'required', accountId: true, apiUrl: 'none' })
  })

  it('makes the key optional for a proxy the headers sign in to, where the provider can send none', () => {
    const headers = [{ ...newHeaderRow(), name: 'X-Proxy-Key', value: 'secret' }]
    expect(fieldsOf('openai', false, headers).key).toBe('optional')
    expect(fieldsOf('google', false, headers).key).toBe('required')
  })
})

describe('formOf', () => {
  it('starts a model being changed as it is, its saved secrets kept as null', () => {
    const edited = formOf(EDIT)
    expect(edited).toMatchObject({ provider: 'openai', model: 'gpt-proxy', name: 'GPT via proxy', apiToken: null, apiUrl: 'https://proxy.example/v1', contextWindow: '128000' })
    expect(edited.headers.map(({ name, value, savedName }) => ({ name, value, savedName }))).toEqual([
      { name: 'X-Proxy-Key', value: null, savedName: 'X-Proxy-Key' },
      { name: 'X-Team', value: 'design', savedName: undefined },
    ])
  })

  it('starts a duplicate with the same provider and secrets, but not the model, its name or its limits', () => {
    expect(formOf(DUPLICATE)).toMatchObject({ provider: 'openai', model: '', name: '', apiToken: null, apiUrl: 'https://proxy.example/v1', contextWindow: '' })
  })

  it('starts Ollama at its usual address when it is chosen, keeping only the name', () => {
    expect(withProvider(form({ name: 'Mine', model: 'x', apiToken: 'k' }), 'ollama')).toMatchObject({ provider: 'ollama', name: 'Mine', model: '', apiToken: '', apiUrl: 'http://localhost:11434' })
  })
})

describe('saved secrets', () => {
  it('are kept only while the address is the one they were saved for', () => {
    const edited = formOf(EDIT)
    expect(keyIsSaved(edited, EDIT)).toBe(true)
    expect(keyIsSaved({ ...edited, apiUrl: 'https://elsewhere.example' }, EDIT)).toBe(false)
    expect(keyIsSaved(edited, ADD)).toBe(false)
  })

  it('belong to the header’s name, so renaming a header loses its saved value', () => {
    const [saved] = formOf(EDIT).headers
    expect(headerIsSaved(saved, true)).toBe(true)
    expect(headerIsSaved(saved, false)).toBe(false)
    expect(renameHeader(saved, 'X-Other')).toMatchObject({ name: 'X-Other', value: '' })
    expect(renameHeader(saved, 'X-Proxy-Key ')).toMatchObject({ value: null })
  })
})

describe('problemsOf', () => {
  it('asks for a provider first', () => {
    expect(problemsOf(formOf(ADD), { ...direct, mode: ADD }).provider).toBeDefined()
  })

  it('asks for the model and the key a provider needs', () => {
    const problems = problemsOf(form({ provider: 'anthropic' }), { ...direct, mode: ADD })
    expect(problems.model).toBeDefined()
    expect(problems.apiToken).toBe('Enter your Anthropic API key.')
  })

  it('asks Workers AI for its account, and Ollama for its address', () => {
    expect(problemsOf(form({ provider: 'cloudflare', model: '@cf/x', apiToken: 'k' }), { ...direct, mode: ADD }).accountId).toBeDefined()
    const ollama = problemsOf(form({ provider: 'ollama', model: 'llama' }), { ...direct, mode: ADD })
    expect(ollama.apiUrl).toBe('Enter the address Ollama runs at.')
    expect(ollama.apiToken).toBeUndefined()
  })

  it('asks for no key with AI Gateway', () => {
    expect(noProblems(problemsOf(form({ provider: 'anthropic', model: 'claude-x' }), { gateway: true, mode: ADD }))).toBe(true)
  })

  it('refuses a model that only decides, which would not be listed', () => {
    expect(problemsOf(form({ provider: 'cloudflare', model: '@cf/cloudflare/clef', apiToken: 'k', accountId: 'a' }), { ...direct, mode: ADD }).model).toBeDefined()
  })

  it('asks for the key again once the address changes', () => {
    const moved = { ...formOf(EDIT), apiUrl: 'https://elsewhere.example' }
    const problems = problemsOf(moved, { ...direct, mode: EDIT })
    // Optional here, as the headers sign in to the proxy: but the saved header must be typed again.
    expect(problems.apiToken).toBeUndefined()
    expect(Object.values(problems.headers)).toEqual(['Enter this header’s value again, as the address changed.'])
    const unheaded = { ...moved, headers: [] }
    expect(problemsOf(unheaded, { ...direct, mode: EDIT }).apiToken).toBe('Enter the API key again, as the address changed.')
  })

  it('checks header names and token counts', () => {
    const rows = [{ ...newHeaderRow(), name: 'Bad: name', value: 'x' }, { ...newHeaderRow(), name: 'X-A', value: '1' }, { ...newHeaderRow(), name: 'x-a', value: '2' }]
    const problems = problemsOf(form({ provider: 'openai', model: 'm', apiToken: 'k', headers: rows, contextWindow: 'lots' }), { ...direct, mode: ADD })
    expect(Object.keys(problems.headers).map(Number)).toEqual([rows[0].id, rows[2].id])
    expect(problems.contextWindow).toBeDefined()
  })
})

describe('parseTokens', () => {
  it('reads a whole number, with or without its thousands set apart', () => {
    expect(parseTokens('')).toBeUndefined()
    expect(parseTokens('200,000')).toBe(200000)
    expect(parseTokens('0')).toBeNull()
    expect(parseTokens('1.5k')).toBeNull()
  })
})

describe('saveOf', () => {
  it('adds a known model under its id, named as the Workshop knows it when no name is given', () => {
    const save = saveOf(form({ provider: 'anthropic', model: ' claude-haiku-4-5 ', apiToken: ' sk-ant ', contextWindow: '100,000' }), { ...direct, mode: ADD })
    expect(save).toEqual({
      kind: 'add',
      profile: { type: 'agent', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      config: { provider: 'anthropic', model: 'claude-haiku-4-5', apiToken: 'sk-ant', contextWindow: 100000 },
    })
  })

  it('sends no key, address or headers with AI Gateway', () => {
    const save = saveOf(form({ provider: 'openai', model: 'gpt-x', apiToken: 'typed before', apiUrl: 'https://x' }), { gateway: true, mode: ADD })
    expect(save.config).toEqual({ provider: 'openai', model: 'gpt-x', apiToken: '' })
  })

  it('keeps the saved key and headers of a model being changed, under its own id', () => {
    const save = saveOf({ ...formOf(EDIT), name: 'Renamed' }, { ...direct, mode: EDIT })
    expect(save).toEqual({
      kind: 'update',
      profile: { type: 'agent', id: 'gpt-proxy', name: 'Renamed' },
      config: { ...SOURCE.config, extraHeaders: { 'X-Proxy-Key': null, 'X-Team': 'design' } },
    })
  })

  it('sends what was typed over a saved key, and never null for one at another address', () => {
    const typed = saveOf({ ...formOf(EDIT), apiToken: 'new-key' }, { ...direct, mode: EDIT })
    expect(typed.config.apiToken).toBe('new-key')
    const moved = saveOf({ ...formOf(EDIT), apiUrl: 'https://elsewhere.example', headers: [] }, { ...direct, mode: EDIT })
    expect(moved.config.apiToken).toBe('')
  })

  it('copies a duplicate’s saved secrets from the model it was made from', () => {
    const save = saveOf({ ...formOf(DUPLICATE), model: 'gpt-other' }, { ...direct, mode: DUPLICATE })
    expect(save).toMatchObject({ kind: 'add', profile: { id: 'gpt-other', name: 'gpt-other' }, copySecretsFrom: 'gpt-proxy' })
    expect(save.config).toMatchObject({ apiToken: null, extraHeaders: { 'X-Proxy-Key': null } })
  })

  it('copies nothing for a duplicate whose secrets were all typed again', () => {
    const save = saveOf({ ...formOf(DUPLICATE), model: 'gpt-other', apiToken: 'k', headers: [] }, { ...direct, mode: DUPLICATE })
    expect(save).not.toHaveProperty('copySecretsFrom')
  })
})
