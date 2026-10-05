// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AdminApi,
  AdminModelView,
  AdminSettingsView,
  GatewayModelLevelTest,
  GatewayModelTest,
  ReasoningLevel,
} from '@gadgets/workshop-shared/api'

const { addToast } = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; description?: string; variant: string }) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))

import { AdminModelsPanel } from './AdminModelsPanel'
import { MODELS_DEV_URL } from './modelsDev'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type GatewayModels = NonNullable<AdminSettingsView['gatewayModels']>

// A model that takes no reasoning level and that the runtime has no entry for.
const NO_SETTINGS = { reasoningLevels: [], builtInReasoning: null, runtimeKnown: false }

const SONNET: AdminModelView = {
  provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', contextWindow: 200000,
  mode: 'enabled', defaultMode: 'enabled', added: false,
  ...NO_SETTINGS, builtInCompactionInputBudget: 200000, maxCompactionInputBudget: 200000,
}
// A catalog model the admin took off its default.
const LEGACY: AdminModelView = {
  provider: 'anthropic', id: 'claude-legacy', name: 'Claude Legacy', contextWindow: 100000,
  mode: 'disabled', defaultMode: 'hidden', added: false,
  ...NO_SETTINGS, builtInCompactionInputBudget: 100000, maxCompactionInputBudget: 100000,
}
const ADDED: AdminModelView = {
  provider: 'openai', id: 'gpt-custom', name: 'GPT Custom', contextWindow: 128000, outputLimit: 4096,
  mode: 'enabled', defaultMode: 'enabled', added: true,
  ...NO_SETTINGS, builtInCompactionInputBudget: 123904, maxCompactionInputBudget: 123904,
}
const GATEWAY_MODELS: GatewayModels = {
  providers: ['anthropic', 'openai'],
  providerSettings: [
    { provider: 'anthropic', enabledBy: 'environment', needsApiToken: false },
    { provider: 'openai', enabledBy: 'admin', needsApiToken: false },
    { provider: 'google', needsApiToken: true },
    { provider: 'cloudflare', needsApiToken: false },
  ],
  models: [SONNET, LEGACY, ADDED],
  defaultReasoning: null,
  userModelsEnabled: true,
  modelsDevSuggestions: false,
}

// Catalog models that the runtime knows, each with levels of its own.
const OPUS: AdminModelView = {
  provider: 'anthropic', id: 'claude-opus', name: 'Claude Opus', contextWindow: 264000,
  outputLimit: 64000, mode: 'enabled', defaultMode: 'enabled', added: false,
  reasoningLevels: ['off', 'low', 'high'], builtInReasoning: 'adaptive',
  builtInCompactionInputBudget: 200000, maxCompactionInputBudget: 200000, runtimeKnown: true,
}
const HAIKU: AdminModelView = { ...OPUS, id: 'claude-haiku', name: 'Claude Haiku' }
const GPT: AdminModelView = {
  provider: 'openai', id: 'gpt-main', name: 'GPT Main', contextWindow: 400000, outputLimit: 128000,
  mode: 'enabled', defaultMode: 'enabled', added: false,
  reasoningLevels: ['minimal', 'low', 'medium', 'high'], builtInReasoning: 'medium',
  builtInCompactionInputBudget: 180000, maxCompactionInputBudget: 272000, runtimeKnown: true,
}
// The catalog models above, and a catalog model and an added one that the runtime has no entry for.
const RUNTIME_MODELS: GatewayModels = { ...GATEWAY_MODELS, models: [OPUS, HAIKU, SONNET, GPT, ADDED] }
// An added model that the runtime knows, as one is after an upgrade.
const KNOWN_ADDED: AdminModelView = { ...OPUS, id: 'claude-added', name: 'Claude Added', added: true }
// An added model with settings to change.
const LEVELLED_ADDED: AdminModelView = { ...ADDED, reasoningLevels: ['low', 'high'] }

// What a re-read reports once an admin has turned `provider` on or off.
const withProvider = (provider: 'google' | 'openai', enabled: boolean): GatewayModels => ({
  ...GATEWAY_MODELS,
  providerSettings: GATEWAY_MODELS.providerSettings.map((entry) => {
    if (entry.provider !== provider) return entry
    const { enabledBy: _enabledBy, ...off } = entry
    return enabled ? { ...off, enabledBy: 'admin' } : off
  }),
})

const TEST_PASSED: GatewayModelTest = { model: 'claude-sonnet', ok: true }
const TEST_PASSED_TEXT = 'claude-sonnet answered through the gateway.'
const MODEL_TEST_PASSED_TEXT = 'Answered through the gateway.'

// What one request of a described model's test found, at the level it asked for.
const levelPassed = (reasoning: ReasoningLevel | null): GatewayModelLevelTest =>
  ({ model: 'gpt-next', ok: true, reasoning })
const levelFailed = (
  reasoning: ReasoningLevel | null, message: string, status?: number,
): GatewayModelLevelTest => ({
  model: 'gpt-next', ok: false, message, reasoning, ...(status !== undefined && { status }),
})

const SUGGESTIONS_LABEL = 'Suggest models from models.dev'
const SUGGESTING: GatewayModels = { ...GATEWAY_MODELS, modelsDevSuggestions: true }

const listed = (id: string, name: string, limit: { context: number; output: number }) => ({
  id, name, tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit,
})
// Entries of https://models.dev/api.json, without the fields nothing reads.
const MODELS_DEV = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-opus-4-5': listed('claude-opus-4-5', 'Claude Opus 4.5 (latest)', { context: 200000, output: 64000 }),
      'claude-haiku-4-5': listed('claude-haiku-4-5', 'Claude Haiku 4.5 (latest)', { context: 200000, output: 64000 }),
      // The deployment's catalog has this one.
      'claude-sonnet': listed('claude-sonnet', 'Claude Sonnet', { context: 200000, output: 64000 }),
      'claude-markup': listed('claude-markup', '<img src="x" alt="markup">', { context: 200000, output: 64000 }),
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: { 'gpt-5.2': listed('gpt-5.2', 'GPT-5.2', { context: 400000, output: 128000 }) },
  },
  'cloudflare-workers-ai': {
    id: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    models: {
      '@cf/meta/llama-4-scout-17b-16e-instruct': listed(
        '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B 16E Instruct',
        { context: 131000, output: 16384 }),
    },
  },
  // A provider the gateway doesn't enable.
  google: {
    id: 'google',
    name: 'Google',
    models: { 'gemini-3.6-flash': listed('gemini-3.6-flash', 'Gemini 3.6 Flash', { context: 1048576, output: 65536 }) },
  },
}

const stubModelsDev = (
  respond: typeof fetch = async () => new Response(JSON.stringify(MODELS_DEV)),
) => {
  const stub = vi.fn<typeof fetch>(respond)
  vi.stubGlobal('fetch', stub)
  return stub
}

const deferred = <T = void,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const modeGroup = (modelName: string) => {
  const group = Array.from(document.body.querySelectorAll('fieldset')).find((fieldset) =>
    document.getElementById(fieldset.getAttribute('aria-labelledby') ?? '')?.textContent
      === `How ${modelName} is offered`)
  if (!group) throw new Error(`No mode group for ${modelName}`)
  return group
}

const modeOptions = (modelName: string) =>
  Array.from(modeGroup(modelName).querySelectorAll('label')).map((label) => ({
    label,
    text: label.textContent,
    radio: label.querySelector<HTMLElement>('[role="radio"]')!,
  }))

// The option's label, which is what a pointer lands on. jsdom has no PointerEvent, which the radio
// itself forwards its clicks with.
const modeOption = (modelName: string, mode: string) => {
  const option = modeOptions(modelName).find(({ text }) => text?.startsWith(mode))
  if (!option) throw new Error(`No ${mode} option for ${modelName}`)
  return option.label
}

const selectedMode = (modelName: string) =>
  modeOptions(modelName).filter(({ radio }) => radio.getAttribute('aria-checked') === 'true')
    .map(({ text }) => text)

const modesDisabled = (modelName: string) =>
  modeOptions(modelName).every(({ radio }) => radio.getAttribute('aria-disabled') === 'true')

const row = (modelName: string) => modeGroup(modelName).closest('li')!

const labeledInput = (label: string) => {
  const labelElement = Array.from(document.body.querySelectorAll('label'))
    .find((element) => element.textContent?.startsWith(label))
  if (!labelElement) throw new Error(`No label ${label}`)
  const element = document.getElementById(labelElement.htmlFor)
  if (!(element instanceof HTMLInputElement)) throw new Error(`No input labeled ${label}`)
  return element
}

const button = (name: string, within: ParentNode = document.body) => {
  const element = Array.from(within.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name)
  if (!element) throw new Error(`No button ${name}`)
  return element
}

const confirmation = () => document.body.querySelector<HTMLElement>('[role="dialog"]')

const settingSwitch = (label: string) => {
  const element = button(label)
  if (element.getAttribute('role') !== 'switch') throw new Error('Not a switch')
  return element
}

// The checkbox the switch forwards its clicks to. jsdom has no PointerEvent, which the switch
// forwards them with.
const settingCheckbox = (label: string) => {
  const input = settingSwitch(label).nextElementSibling
  if (!(input instanceof HTMLInputElement)) throw new Error('No checkbox behind the switch')
  return input
}

const userModelsSwitch = () => settingSwitch('Users may add their own models')
const userModelsCheckbox = () => settingCheckbox('Users may add their own models')

const providersSection = () => {
  const heading = Array.from(document.body.querySelectorAll('h3'))
    .find((element) => element.textContent === 'Providers')
  if (!heading) throw new Error('No Providers section')
  return heading.closest('section')!
}

const providerSwitches = () =>
  Array.from(providersSection().querySelectorAll<HTMLButtonElement>('[role="switch"]'))

const providerSwitch = (label: string) => {
  const element = providerSwitches().find((toggle) => toggle.getAttribute('aria-label') === label)
  if (!element) throw new Error(`No provider switch ${label}`)
  return element
}

// As settingCheckbox: the checkbox the switch forwards its clicks to.
const providerCheckbox = (label: string) => {
  const input = providerSwitch(label).nextElementSibling
  if (!(input instanceof HTMLInputElement)) throw new Error('No checkbox behind the switch')
  return input
}

const testButton = (label: string) => button(`Test ${label}`, providersSection())

/** What the status region of the provider's row says. */
const testResult = (label: string) =>
  providerSwitch(label).closest('li')!.querySelector('[role="status"]')!.textContent

// The Test button of a model's row, which names the model while the test is in flight too.
const modelTestButton = (modelName: string) => {
  const element = Array.from(row(modelName).querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => [`Test ${modelName}`, `Testing ${modelName}…`].includes(b.getAttribute('aria-label') ?? ''))
  if (!element) throw new Error(`No Test button for ${modelName}`)
  return element
}

/** What the status region of the model's row says. */
const modelTestResult = (modelName: string) => {
  const regions = row(modelName).querySelectorAll('[role="status"]')
  if (regions.length !== 1) throw new Error(`${regions.length} status regions for ${modelName}`)
  return regions[0].textContent
}

// As typing reports itself: suggestions open for typed text, not for a value filled in some other way.
const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

const click = (element: HTMLElement) => act(async () => { element.click() })

const focus = (element: HTMLElement) => act(async () => { element.focus() })

/** Press `key` in `element`, and report whether the press was consumed there. */
const press = async (element: HTMLElement, key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  await act(async () => { element.dispatchEvent(event) })
  return event.defaultPrevented
}

/** The options of the list that the select named `name` opens, which is left open. */
const openOptions = async (name: string) => {
  const select = button(name)
  if (select.getAttribute('aria-expanded') !== 'true') await click(select)
  const list = document.getElementById(select.getAttribute('aria-controls') ?? '')
  return Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
}

const optionLabels = async (name: string) =>
  (await openOptions(name)).map((option) => option.textContent)

// By keyboard. The option turns Enter into a click it builds as a PointerEvent, which jsdom lacks,
// so the window has a stand-in for as long as the choice takes.
const choose = async (name: string, label: string) => {
  const option = (await openOptions(name)).find((element) => element.textContent === label)
  if (!option) throw new Error(`No ${label} option in ${name}`)
  const view: { PointerEvent?: typeof MouseEvent } = window
  view.PointerEvent = MouseEvent
  try {
    await focus(option)
    await press(option, 'Enter')
  } finally {
    delete view.PointerEvent
  }
}

const chooseProvider = (label: string) => choose('Provider', label)

const describedBy = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '').split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ')

const openSettings = (modelName: string) => click(button(`Settings for ${modelName}`))

const budgetField = (modelName = 'Claude Opus') =>
  labeledInput(`Compaction budget for ${modelName}`)

// What a browser does to a control with focus that a write disables. jsdom leaves focus on such a
// control and won't blur it either, so focus leaves by way of a button that takes it and goes.
const dropFocus = () => act(async () => {
  const elsewhere = document.body.appendChild(document.createElement('button'))
  elsewhere.focus()
  elsewhere.blur()
  elsewhere.remove()
})

// The options of the list the Model ID field says it controls.
const suggestionOptions = () => {
  const list = document.getElementById(labeledInput('Model ID').getAttribute('aria-controls') ?? '')
  return Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
}

const suggested = () => suggestionOptions().map((option) => option.textContent)

/** Pick the first model suggested once `typed` is typed into the Model ID field. */
const pickSuggestion = async (typed: string) => {
  await focus(labeledInput('Model ID'))
  await type(labeledInput('Model ID'), typed)
  await click(suggestionOptions()[0])
}

// The add form's status regions on one side of its buttons. What it says of its suggestions is
// before them and what its test answered is after them. Each provider's row has a status region
// of its own.
const addFormStatus = (side: number) => {
  const add = button('Add model')
  return Array.from(add.closest('form')!.querySelectorAll('[role="status"]'))
    .filter((region) => add.compareDocumentPosition(region) & side)
}

const suggestionNote = () =>
  addFormStatus(Node.DOCUMENT_POSITION_PRECEDING).map((note) => note.textContent)

// The Test button of the add form, which says what it tests while the test is in flight too.
const formTestButton = () => {
  const form = button('Add model').closest('form')!
  const element = Array.from(form.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => ['Test this model', 'Testing this model…'].includes(b.getAttribute('aria-label') ?? ''))
  if (!element) throw new Error('No Test button in the add form')
  return element
}

/** What the status region of the add form's test says, line by line. */
const formTestResult = () => {
  const regions = addFormStatus(Node.DOCUMENT_POSITION_FOLLOWING)
  if (regions.length !== 1) throw new Error(`${regions.length} status regions for the add form’s test`)
  return Array.from(regions[0].querySelectorAll('li, p')).map((line) => line.textContent)
}

const fillAddForm = async (fields: { id: string; name: string; contextWindow: string; outputLimit?: string }) => {
  await type(labeledInput('Model ID'), fields.id)
  await type(labeledInput('Display name'), fields.name)
  await type(labeledInput('Context window'), fields.contextWindow)
  await type(labeledInput('Output limit'), fields.outputLimit ?? '')
}

const addFormValues = () => ['Model ID', 'Display name', 'Context window', 'Output limit']
  .map((label) => labeledInput(label).value)

describe('AdminModelsPanel', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
    addToast.mockReset()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const render = async (
    { gatewayModels }: Pick<AdminSettingsView, 'gatewayModels'> = { gatewayModels: GATEWAY_MODELS },
  ) => {
    const setGatewayModelMode = vi.fn<AdminApi['setGatewayModelMode']>(async () => {})
    const addGatewayModel = vi.fn<AdminApi['addGatewayModel']>(async () => {})
    const removeGatewayModel = vi.fn<AdminApi['removeGatewayModel']>(async () => {})
    const setUserModelsEnabled = vi.fn<AdminApi['setUserModelsEnabled']>(async () => {})
    const setModelsDevSuggestions = vi.fn<AdminApi['setModelsDevSuggestions']>(async () => {})
    const setGatewayModelSettings = vi.fn<AdminApi['setGatewayModelSettings']>(async () => {})
    const setDefaultReasoning = vi.fn<AdminApi['setDefaultReasoning']>(async () => {})
    const setGatewayProviderEnabled = vi.fn<AdminApi['setGatewayProviderEnabled']>(async () => {})
    const testGatewayProvider = vi.fn<AdminApi['testGatewayProvider']>(async () => TEST_PASSED)
    const testGatewayModel = vi.fn<AdminApi['testGatewayModel']>(
      async (modelId) => ({ model: modelId, ok: true }))
    const testNewGatewayModel = vi.fn<AdminApi['testNewGatewayModel']>(
      async (model) => [{ model: model.id, ok: true, reasoning: null }])
    const onChanged = vi.fn<() => Promise<void>>(async () => {})
    const admin = {
      setGatewayModelMode, addGatewayModel, removeGatewayModel, setUserModelsEnabled,
      setModelsDevSuggestions, setGatewayModelSettings, setDefaultReasoning,
      setGatewayProviderEnabled, testGatewayProvider, testGatewayModel, testNewGatewayModel,
    } as unknown as RpcStub<AdminApi>
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // Shows what a re-read of the settings reported.
    const show = (reported: GatewayModels) => act(async () => root!.render(
      <AdminModelsPanel admin={admin} gatewayModels={reported} onChanged={onChanged} />))
    await act(async () => root!.render(
      <AdminModelsPanel admin={admin} gatewayModels={gatewayModels} onChanged={onChanged} />))
    return {
      setGatewayModelMode, addGatewayModel, removeGatewayModel, setUserModelsEnabled,
      setModelsDevSuggestions, setGatewayModelSettings, setDefaultReasoning,
      setGatewayProviderEnabled, testGatewayProvider, testGatewayModel, testNewGatewayModel,
      onChanged, show,
    }
  }

  describe('outside AI Gateway mode', () => {
    it('explains where models are managed instead of offering controls', async () => {
      await render({ gatewayModels: undefined })

      expect(document.body.textContent).toContain('only when the deployment provides them through AI Gateway')
      expect(document.body.textContent).toContain('each user adds their own models')
      expect(document.body.querySelectorAll('button, input, [role="radio"]')).toHaveLength(0)
    })
  })

  describe('whether users may add their own models', () => {
    it.each([true, false])('shows %s as the server reported it, with what it means', async (enabled) => {
      await render({ gatewayModels: { ...GATEWAY_MODELS, userModelsEnabled: enabled } })

      expect(userModelsSwitch().getAttribute('aria-checked')).toBe(String(enabled))
      const meaning = document.getElementById(userModelsSwitch().getAttribute('aria-describedby')!)
      expect(meaning?.textContent).toContain('When off, only the models listed here can be used')
      expect(meaning?.textContent).toContain('Nothing is deleted.')
    })

    it.each([true, false])('sets the opposite of %s, then re-reads the settings', async (enabled) => {
      const { setUserModelsEnabled, onChanged } = await render({
        gatewayModels: { ...GATEWAY_MODELS, userModelsEnabled: enabled },
      })

      await click(userModelsCheckbox())

      expect(setUserModelsEnabled).toHaveBeenCalledExactlyOnceWith(!enabled)
      expect(onChanged).toHaveBeenCalledOnce()
      expect(setUserModelsEnabled.mock.invocationCallOrder[0])
        .toBeLessThan(onChanged.mock.invocationCallOrder[0])
      // The re-read is what moves the switch.
      expect(userModelsSwitch().getAttribute('aria-checked')).toBe(String(enabled))
    })

    it('reports a refused change with the server’s message and keeps showing the server’s value', async () => {
      const { setUserModelsEnabled, onChanged } = await render()
      setUserModelsEnabled.mockRejectedValueOnce(
        new Error('This deployment does not provide models through AI Gateway.'))

      await click(userModelsCheckbox())

      expect(addToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        description: 'This deployment does not provide models through AI Gateway.',
        variant: 'error',
      }))
      expect(onChanged).not.toHaveBeenCalled()
      expect(userModelsSwitch().getAttribute('aria-checked')).toBe('true')
      expect(userModelsSwitch().disabled).toBe(false)
    })

    it('cannot be changed twice while the change is in flight, and locks the other controls', async () => {
      const { setUserModelsEnabled, setGatewayModelMode } = await render()
      const call = deferred()
      setUserModelsEnabled.mockReturnValueOnce(call.promise)

      await click(userModelsCheckbox())

      expect(userModelsSwitch().disabled).toBe(true)
      await click(userModelsCheckbox())
      await click(modeOption('Claude Sonnet', 'Hidden'))
      expect(setUserModelsEnabled).toHaveBeenCalledOnce()
      expect(setGatewayModelMode).not.toHaveBeenCalled()
      expect(button('Add model').disabled).toBe(true)

      await act(async () => call.resolve())

      expect(userModelsSwitch().disabled).toBe(false)
    })

    it('is disabled while another change is in flight', async () => {
      const { setGatewayModelMode, setUserModelsEnabled } = await render()
      const call = deferred()
      setGatewayModelMode.mockReturnValueOnce(call.promise)

      await click(modeOption('Claude Sonnet', 'Hidden'))

      expect(userModelsSwitch().disabled).toBe(true)
      await click(userModelsCheckbox())
      expect(setUserModelsEnabled).not.toHaveBeenCalled()

      await act(async () => call.resolve())

      expect(userModelsSwitch().disabled).toBe(false)
    })

    // A binding made for a removed model runs only as a model of the user's own does.
    it.each([
      [true, 'then run, even if the model was disabled.', 'then run, even if it was disabled,'],
      [false, 'then stay stopped for as long as users may not add their own models.',
        'then stay stopped for as long as users may not add their own models,'],
    ])('when %s, says what removing a model does to its bindings', async (enabled, inList, inDialog) => {
      await render({ gatewayModels: { ...GATEWAY_MODELS, userModelsEnabled: enabled } })

      expect(row('GPT Custom').closest('section')?.textContent)
        .toContain(`gadget model bindings made for it ${inList}`)
      await click(button('Remove GPT Custom'))
      expect(confirmation()?.textContent)
        .toContain(`gpt-custom: gadget model bindings made for the model ${inDialog} and a model`)
    })
  })

  describe('providers', () => {
    it('lists every provider the server reported, as the server reported it', async () => {
      await render()

      expect(providerSwitches().map((toggle) => [
        toggle.getAttribute('aria-label'), toggle.getAttribute('aria-checked'), toggle.disabled,
      ])).toEqual([
        ['Anthropic', 'true', true],
        ['OpenAI', 'true', false],
        ['Google', 'false', false],
        ['Cloudflare Workers AI', 'false', false],
      ])
      expect(describedBy(providerSwitch('Anthropic'))).toBe('Set by CF_AI_GATEWAY_PROVIDERS')
      expect(describedBy(providerSwitch('Google'))).toBe(
        'Needs CF_AI_GATEWAY_API_TOKEN: requests to this provider fail until the deployment sets it.')
      // Above the models.
      expect(providersSection().compareDocumentPosition(row('Claude Sonnet'))
        & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it.each([
      ['on', 'Google', 'google', true],
      ['off', 'OpenAI', 'openai', false],
    ] as const)('turns a provider %s, then re-reads the settings', async (
      _case, label, provider, enabled,
    ) => {
      const { setGatewayProviderEnabled, onChanged, show } = await render()

      await click(providerCheckbox(label))

      expect(setGatewayProviderEnabled).toHaveBeenCalledExactlyOnceWith(provider, enabled)
      expect(onChanged).toHaveBeenCalledOnce()
      expect(setGatewayProviderEnabled.mock.invocationCallOrder[0])
        .toBeLessThan(onChanged.mock.invocationCallOrder[0])
      // The re-read is what moves the switch.
      expect(providerSwitch(label).getAttribute('aria-checked')).toBe(String(!enabled))

      await show(withProvider(provider, enabled))

      expect(providerSwitch(label).getAttribute('aria-checked')).toBe(String(enabled))
    })

    it('reports a refused change with the server’s message and keeps showing the server’s value', async () => {
      const { setGatewayProviderEnabled, onChanged } = await render()
      setGatewayProviderEnabled.mockRejectedValueOnce(
        new Error('Provider "google" is not served through AI Gateway.'))

      await click(providerCheckbox('Google'))

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: 'Couldn’t update Google',
        description: 'Provider "google" is not served through AI Gateway.',
        variant: 'error',
      })
      expect(onChanged).not.toHaveBeenCalled()
      expect(providerSwitch('Google').getAttribute('aria-checked')).toBe('false')
      expect(providerSwitch('Google').disabled).toBe(false)
    })

    it('locks every control but the tests while a change is in flight', async () => {
      const { setGatewayProviderEnabled, setGatewayModelMode, testGatewayProvider } = await render()
      const call = deferred()
      setGatewayProviderEnabled.mockReturnValueOnce(call.promise)

      await click(providerCheckbox('Google'))

      expect(providerSwitches().map((toggle) => toggle.disabled)).toEqual([true, true, true, true])
      expect(userModelsSwitch().disabled).toBe(true)
      expect(button('Add model').disabled).toBe(true)
      await click(providerCheckbox('OpenAI'))
      await click(modeOption('Claude Sonnet', 'Hidden'))
      expect(setGatewayProviderEnabled).toHaveBeenCalledOnce()
      expect(setGatewayModelMode).not.toHaveBeenCalled()

      expect(testButton('Google').disabled).toBe(false)
      await click(testButton('Google'))
      expect(testGatewayProvider).toHaveBeenCalledExactlyOnceWith('google')
      expect(testResult('Google')).toBe(TEST_PASSED_TEXT)

      await act(async () => call.resolve())

      expect(providerSwitches().map((toggle) => toggle.disabled)).toEqual([true, false, false, false])
      expect(userModelsSwitch().disabled).toBe(false)
    })

    it('runs a test without locking a control or re-reading the settings', async () => {
      const { testGatewayProvider, setGatewayModelMode, onChanged } = await render()
      const call = deferred<GatewayModelTest>()
      testGatewayProvider.mockReturnValueOnce(call.promise)

      await click(testButton('OpenAI'))

      expect(testGatewayProvider).toHaveBeenCalledExactlyOnceWith('openai')
      expect(providerSwitches().map((toggle) => toggle.disabled)).toEqual([true, false, false, false])
      expect(userModelsSwitch().disabled).toBe(false)
      expect(button('Add model').disabled).toBe(false)
      expect(modesDisabled('Claude Sonnet')).toBe(false)

      // A write goes through meanwhile.
      await click(modeOption('Claude Sonnet', 'Hidden'))
      expect(setGatewayModelMode).toHaveBeenCalledExactlyOnceWith('claude-sonnet', 'hidden')
      expect(onChanged).toHaveBeenCalledOnce()

      await act(async () => call.resolve(
        { model: 'gpt-main', ok: false, status: 401, message: 'Incorrect API key provided.' }))

      expect(testResult('OpenAI')).toBe(
        'Failed (401): Incorrect API key provided.' +
        'The gateway may hold no key or credits for this provider, or CF_AI_GATEWAY_API_TOKEN ' +
        'may not be allowed to run models.')
      expect(onChanged).toHaveBeenCalledOnce()
      expect(addToast).not.toHaveBeenCalled()
    })

    it('shows a test that could not be run in the provider’s row, and not as a toast', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { testGatewayProvider } = await render()
      testGatewayProvider.mockRejectedValueOnce(
        new Error('This deployment does not provide models through AI Gateway.'))

      await click(testButton('OpenAI'))

      const errors = logged.mock.calls.length
      logged.mockRestore()
      expect(testResult('OpenAI')).toBe(
        'Couldn’t run the test: This deployment does not provide models through AI Gateway.')
      expect(addToast).not.toHaveBeenCalled()
      expect(errors).toBe(1)
    })

    it('keeps a test’s result when the settings are re-read', async () => {
      const { show } = await render()
      await click(testButton('Google'))
      expect(testResult('Google')).toBe(TEST_PASSED_TEXT)

      await click(providerCheckbox('Google'))
      await show(withProvider('google', true))

      expect(providerSwitch('Google').getAttribute('aria-checked')).toBe('true')
      expect(testResult('Google')).toBe(TEST_PASSED_TEXT)
    })
  })

  describe('the default reasoning level', () => {
    const LABEL = 'Default reasoning level'

    it.each([
      [null, 'Built-in'],
      ['xhigh', 'Extra high'],
    ] as const)('shows %s as the server reported it, with what it applies to', async (level, shown) => {
      await render({ gatewayModels: { ...RUNTIME_MODELS, defaultReasoning: level } })

      expect(button(LABEL).textContent).toBe(shown)
      expect(describedBy(button(LABEL))).toBe(
        'The reasoning level of the agent’s turns on every model listed here that has no level ' +
        'of its own. Built-in sets none: each model is then asked the way the Workshop asks it ' +
        'by default, which the model’s Settings name. That is Adaptive, where the model decides ' +
        'how much to reason, a fixed level, or no level sent. A level that a model lacks is ' +
        'fitted to the nearest one it has. One-shot calls (titles, summaries, gadget model ' +
        'bindings) are not affected, and neither are the models users added.')
      expect(await optionLabels(LABEL))
        .toEqual(['Built-in', 'Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'])
    })

    it('tells each model’s row what the default is', async () => {
      const { show } = await render({ gatewayModels: { ...RUNTIME_MODELS, defaultReasoning: 'high' } })
      await openSettings('Claude Opus')

      expect(button('Reasoning level for Claude Opus').textContent).toBe('Deployment default (High)')

      await show(RUNTIME_MODELS)

      expect(button('Reasoning level for Claude Opus').textContent)
        .toBe('Deployment default (built-in: Adaptive)')
    })

    it('names each model’s built-in in its row until the server reports a default', async () => {
      const models = [OPUS, GPT, LEVELLED_ADDED]
      const { show } = await render({ gatewayModels: { ...RUNTIME_MODELS, models } })
      for (const model of models) await openSettings(model.name)
      const shown = () => models.map((model) => button(`Reasoning level for ${model.name}`).textContent)

      expect(shown()).toEqual([
        'Deployment default (built-in: Adaptive)',
        'Deployment default (built-in: Medium)',
        'Deployment default (built-in: no level sent)',
      ])

      await show({ ...RUNTIME_MODELS, models, defaultReasoning: 'xhigh' })

      expect(shown()).toEqual(Array(3).fill('Deployment default (Extra high)'))
    })

    it.each([
      [null, 'High', 'high'],
      ['high', 'Built-in', null],
    ] as const)('from %s, sets the level chosen as %s, then re-reads the settings', async (
      level, chosen, sent,
    ) => {
      const { setDefaultReasoning, onChanged } = await render({
        gatewayModels: { ...RUNTIME_MODELS, defaultReasoning: level },
      })
      const shown = button(LABEL).textContent

      await choose(LABEL, chosen)

      expect(setDefaultReasoning).toHaveBeenCalledExactlyOnceWith(sent)
      expect(onChanged).toHaveBeenCalledOnce()
      expect(setDefaultReasoning.mock.invocationCallOrder[0])
        .toBeLessThan(onChanged.mock.invocationCallOrder[0])
      // The re-read is what changes the select.
      expect(button(LABEL).textContent).toBe(shown)
    })

    it('sets nothing when the level it already shows is chosen', async () => {
      const { setDefaultReasoning } = await render({
        gatewayModels: { ...RUNTIME_MODELS, defaultReasoning: 'low' },
      })

      await choose(LABEL, 'Low')

      expect(setDefaultReasoning).not.toHaveBeenCalled()
    })

    it('sets nothing for a letter typed while the select is closed', async () => {
      const { setDefaultReasoning } = await render()
      // A focused select learns its options a moment later, and matches letters against them.
      await focus(button(LABEL))
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

      await press(button(LABEL), 'm')

      expect(button(LABEL).getAttribute('aria-expanded')).toBe('false')
      expect(setDefaultReasoning).not.toHaveBeenCalled()
    })

    it('reports a refused change with the server’s message and keeps showing the server’s level', async () => {
      const { setDefaultReasoning, onChanged } = await render()
      setDefaultReasoning.mockRejectedValueOnce(
        new Error('This deployment does not provide models through AI Gateway.'))

      await choose(LABEL, 'Max')

      expect(addToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        title: 'Couldn’t update “Default reasoning level”',
        description: 'This deployment does not provide models through AI Gateway.',
        variant: 'error',
      }))
      expect(onChanged).not.toHaveBeenCalled()
      expect(button(LABEL).textContent).toBe('Built-in')
      expect(button(LABEL).disabled).toBe(false)
    })

    it('is locked while a change is in flight, and locks the other controls', async () => {
      const { setDefaultReasoning, setGatewayModelMode } = await render()
      const call = deferred()
      setDefaultReasoning.mockReturnValueOnce(call.promise)

      await choose(LABEL, 'High')

      expect(button(LABEL).disabled).toBe(true)
      expect(userModelsSwitch().disabled).toBe(true)
      await click(modeOption('Claude Sonnet', 'Hidden'))
      expect(setGatewayModelMode).not.toHaveBeenCalled()

      await act(async () => call.resolve())

      expect(button(LABEL).disabled).toBe(false)
    })
  })

  describe('model settings', () => {
    const LEVEL = 'Reasoning level for Claude Opus'

    it('sets the level chosen for a model, then re-reads the settings', async () => {
      const { setGatewayModelSettings, onChanged, show } = await render({ gatewayModels: RUNTIME_MODELS })
      await openSettings('Claude Opus')

      await choose(LEVEL, 'High')

      expect(setGatewayModelSettings).toHaveBeenCalledExactlyOnceWith('claude-opus', { reasoning: 'high' })
      expect(onChanged).toHaveBeenCalledOnce()
      expect(setGatewayModelSettings.mock.invocationCallOrder[0])
        .toBeLessThan(onChanged.mock.invocationCallOrder[0])
      expect(row('Claude Opus').textContent).not.toContain('Changed')

      await show({
        ...RUNTIME_MODELS,
        models: [{ ...OPUS, settings: { reasoning: 'high' } }, HAIKU, SONNET, GPT, ADDED],
      })

      // Still open, on what the re-read reported.
      expect(button(LEVEL).textContent).toBe('High')
      expect(row('Claude Opus').textContent).toContain('Changed')
      expect(row('Claude Haiku').textContent).not.toContain('Changed')
    })

    it('saves a model’s compaction budget beside the level it has', async () => {
      const { setGatewayModelSettings, onChanged } = await render({
        gatewayModels: {
          ...RUNTIME_MODELS,
          models: [{ ...OPUS, settings: { reasoning: 'low' } }, HAIKU, SONNET, GPT, ADDED],
        },
      })
      await openSettings('Claude Opus')
      await type(budgetField(), '150000')

      await click(button('Save the compaction budget of Claude Opus'))

      expect(setGatewayModelSettings).toHaveBeenCalledExactlyOnceWith(
        'claude-opus', { reasoning: 'low', compactionInputBudget: 150000 })
      expect(onChanged).toHaveBeenCalledOnce()
    })

    it('reports a refused change with the server’s message and keeps showing the server’s values', async () => {
      const { setGatewayModelSettings, onChanged } = await render({ gatewayModels: RUNTIME_MODELS })
      setGatewayModelSettings.mockRejectedValue(new Error('No such model: claude-opus'))
      await openSettings('Claude Opus')

      await choose(LEVEL, 'High')

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: 'Couldn’t update Claude Opus',
        description: 'No such model: claude-opus',
        variant: 'error',
      })
      expect(button(LEVEL).textContent).toBe('Deployment default (built-in: Adaptive)')
      expect(button(LEVEL).disabled).toBe(false)

      await type(budgetField(), '150000')
      await click(button('Save the compaction budget of Claude Opus'))

      expect(addToast).toHaveBeenCalledTimes(2)
      expect(budgetField().value).toBe('')
      expect(budgetField().disabled).toBe(false)
      expect(onChanged).not.toHaveBeenCalled()
      expect(row('Claude Opus').textContent).not.toContain('Changed')
    })

    it('locks every control while a change is in flight', async () => {
      const { setGatewayModelSettings, setGatewayModelMode } = await render({ gatewayModels: RUNTIME_MODELS })
      const call = deferred()
      setGatewayModelSettings.mockReturnValueOnce(call.promise)
      await openSettings('Claude Opus')
      await openSettings('GPT Main')

      await choose(LEVEL, 'High')

      expect(button(LEVEL).disabled).toBe(true)
      expect(budgetField().disabled).toBe(true)
      expect(button('Save the compaction budget of Claude Opus').disabled).toBe(true)
      expect(button('Reasoning level for GPT Main').disabled).toBe(true)
      expect(button('Default reasoning level').disabled).toBe(true)
      await click(modeOption('Claude Opus', 'Hidden'))
      expect(setGatewayModelMode).not.toHaveBeenCalled()

      await act(async () => call.resolve())

      expect(button(LEVEL).disabled).toBe(false)
      expect(button('Reasoning level for GPT Main').disabled).toBe(false)
    })

    it('sets an added model’s level and budget under its ID, and tells its row the default', async () => {
      const { setGatewayModelSettings } = await render({
        gatewayModels: { ...RUNTIME_MODELS, models: [OPUS, LEVELLED_ADDED], defaultReasoning: 'medium' },
      })
      await openSettings('GPT Custom')

      expect(button('Reasoning level for GPT Custom').textContent).toBe('Deployment default (Medium)')

      await choose('Reasoning level for GPT Custom', 'High')

      expect(setGatewayModelSettings).toHaveBeenLastCalledWith('gpt-custom', { reasoning: 'high' })

      await type(budgetField('GPT Custom'), '100000')
      await click(button('Save the compaction budget of GPT Custom'))

      expect(setGatewayModelSettings)
        .toHaveBeenLastCalledWith('gpt-custom', { compactionInputBudget: 100000 })
      expect(setGatewayModelSettings).toHaveBeenCalledTimes(2)
    })

    it('names the catalog model that an added model behaves like, or else gives its ID', async () => {
      const { show } = await render({
        gatewayModels: {
          ...RUNTIME_MODELS,
          models: [OPUS, GPT, { ...ADDED, provider: 'anthropic', behavesLike: 'claude-opus', behavesLikeKnown: true }],
        },
      })

      expect(row('GPT Custom').textContent).toContain('Behaves like Claude Opus')

      await show({
        ...RUNTIME_MODELS,
        models: [GPT, { ...ADDED, provider: 'anthropic', behavesLike: 'claude-opus', behavesLikeKnown: true }],
      })

      expect(row('GPT Custom').textContent).toContain('Behaves like claude-opus')
    })
  })

  describe('model tests', () => {
    const NOTE =
      'Test sends a model one request the way a chat turn would, with the reasoning level in ' +
      'effect for it, and shows what came back. A test can use up to 2,048 output tokens.'
    const FAILED: GatewayModelTest =
      { model: 'claude-opus', ok: false, status: 500, message: 'The server had an error.' }

    const TESTED = ['Claude Opus', 'GPT Main', 'GPT Custom']
    // What the rows of the tested models say, then what the tested provider's row says.
    const results = () => [...TESTED.map(modelTestResult), testResult('OpenAI')]
    const ALL_PASSED = [...TESTED.map(() => MODEL_TEST_PASSED_TEXT), TEST_PASSED_TEXT]

    // A model with settings, another of the catalog, an added one and a provider, each tested.
    const renderTested = async () => {
      const rendered = await render({ gatewayModels: RUNTIME_MODELS })
      for (const name of TESTED) await click(modelTestButton(name))
      await click(testButton('OpenAI'))
      expect(results()).toEqual(ALL_PASSED)
      return rendered
    }

    // The writes to one model: what each is, its method, which of the tested models it is made
    // to, and the presses that make it.
    const MODEL_WRITES = [
      ['a change of its mode', 'setGatewayModelMode', 'Claude Opus',
        () => click(modeOption('Claude Opus', 'Hidden'))],
      ['a change of its reasoning level', 'setGatewayModelSettings', 'Claude Opus', async () => {
        await openSettings('Claude Opus')
        await choose('Reasoning level for Claude Opus', 'High')
      }],
      ['a compaction budget saved for it', 'setGatewayModelSettings', 'Claude Opus', async () => {
        await openSettings('Claude Opus')
        await type(budgetField(), '150000')
        await click(button('Save the compaction budget of Claude Opus'))
      }],
      ['its removal', 'removeGatewayModel', 'GPT Custom', async () => {
        await click(button('Remove GPT Custom'))
        await click(button('Remove', confirmation()!))
      }],
    ] as const

    it('says what a test sends and can use, between the modes’ meanings and the models', async () => {
      await render()

      const note = Array.from(document.body.querySelectorAll('p'))
        .find((p) => p.textContent === NOTE)
      expect(note).toBeDefined()
      // Read in the page's flow, and not spoken as a result is.
      expect(note!.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull()
      expect(document.body.querySelector('dl')!.compareDocumentPosition(note!)
        & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(note!.compareDocumentPosition(row('Claude Sonnet'))
        & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('tests the model whose Test is pressed, in any mode, and shows the answer in its row only', async () => {
      const { testGatewayModel, testGatewayProvider, onChanged } = await render()
      for (const name of ['Claude Sonnet', 'Claude Legacy', 'GPT Custom']) {
        expect(modelTestButton(name).getAttribute('aria-label')).toBe(`Test ${name}`)
        expect(modelTestResult(name)).toBe('')
      }
      expect(selectedMode('Claude Legacy')).toEqual(['Disabled'])

      await click(modelTestButton('Claude Legacy'))

      expect(testGatewayModel).toHaveBeenCalledExactlyOnceWith('claude-legacy')
      expect(modelTestResult('Claude Legacy')).toBe(MODEL_TEST_PASSED_TEXT)
      expect(modelTestResult('Claude Sonnet')).toBe('')
      expect(modelTestResult('GPT Custom')).toBe('')
      expect(providersSection().querySelectorAll('[role="status"]:not(:empty)')).toHaveLength(0)
      expect(testGatewayProvider).not.toHaveBeenCalled()
      expect(onChanged).not.toHaveBeenCalled()
      expect(addToast).not.toHaveBeenCalled()
    })

    it('tests two models at once, and keeps each one’s result in its own row', async () => {
      const { testGatewayModel } = await render()
      const sonnet = deferred<GatewayModelTest>()
      const custom = deferred<GatewayModelTest>()
      testGatewayModel.mockReturnValueOnce(sonnet.promise).mockReturnValueOnce(custom.promise)

      await click(modelTestButton('Claude Sonnet'))
      await click(modelTestButton('GPT Custom'))

      expect(testGatewayModel.mock.calls).toEqual([['claude-sonnet'], ['gpt-custom']])
      expect(modelTestButton('Claude Sonnet').textContent).toBe('Testing…')
      expect(modelTestButton('GPT Custom').getAttribute('aria-label')).toBe('Testing GPT Custom…')
      expect(modelTestButton('Claude Legacy').textContent).toBe('Test')
      // A second press of a test in flight asks for nothing.
      await click(modelTestButton('Claude Sonnet'))
      expect(testGatewayModel).toHaveBeenCalledTimes(2)

      await act(async () => custom.resolve(
        { model: 'gpt-custom', ok: false, status: 429, message: 'Rate limit reached.' }))

      expect(modelTestResult('GPT Custom')).toBe('Failed (429): Rate limit reached.')
      expect(modelTestButton('GPT Custom').textContent).toBe('Test')
      expect(modelTestResult('Claude Sonnet')).toBe('')
      expect(modelTestButton('Claude Sonnet').textContent).toBe('Testing…')

      await act(async () => sonnet.resolve({ model: 'claude-sonnet', ok: true }))

      expect(modelTestResult('Claude Sonnet')).toBe(MODEL_TEST_PASSED_TEXT)
      expect(modelTestResult('GPT Custom')).toBe('Failed (429): Rate limit reached.')
      expect(modelTestResult('Claude Legacy')).toBe('')
    })

    it('runs a test without locking a control or re-reading the settings', async () => {
      const { testGatewayModel, setUserModelsEnabled, onChanged } = await render()
      const call = deferred<GatewayModelTest>()
      testGatewayModel.mockReturnValueOnce(call.promise)

      await click(modelTestButton('Claude Sonnet'))

      expect(userModelsSwitch().disabled).toBe(false)
      expect(button('Add model').disabled).toBe(false)
      expect(button('Remove GPT Custom').disabled).toBe(false)
      expect(modesDisabled('Claude Sonnet')).toBe(false)
      expect(providerSwitches().map((toggle) => toggle.disabled)).toEqual([true, false, false, false])
      expect(onChanged).not.toHaveBeenCalled()

      // A write goes through meanwhile.
      await click(userModelsCheckbox())
      expect(setUserModelsEnabled).toHaveBeenCalledExactlyOnceWith(false)
      expect(onChanged).toHaveBeenCalledOnce()

      await act(async () => call.resolve({
        model: 'claude-sonnet', ok: false, status: 401, message: 'invalid x-api-key',
      }))

      expect(modelTestResult('Claude Sonnet')).toBe(
        'Failed (401): invalid x-api-key' +
        'The gateway may hold no key or credits for this provider, or CF_AI_GATEWAY_API_TOKEN ' +
        'may not be allowed to run models.')
      expect(onChanged).toHaveBeenCalledOnce()
      expect(addToast).not.toHaveBeenCalled()
    })

    it('can be run while a write is in flight', async () => {
      const { setUserModelsEnabled, testGatewayModel } = await render()
      const call = deferred()
      setUserModelsEnabled.mockReturnValueOnce(call.promise)
      await click(userModelsCheckbox())
      expect(modesDisabled('GPT Custom')).toBe(true)
      expect(button('Remove GPT Custom').disabled).toBe(true)

      expect(modelTestButton('GPT Custom').disabled).toBe(false)
      expect(modelTestButton('GPT Custom').getAttribute('aria-disabled')).toBe('false')
      await click(modelTestButton('GPT Custom'))

      expect(testGatewayModel).toHaveBeenCalledExactlyOnceWith('gpt-custom')
      expect(modelTestResult('GPT Custom')).toBe(MODEL_TEST_PASSED_TEXT)
      // The test did not end the write's lock either.
      expect(modesDisabled('GPT Custom')).toBe(true)

      await act(async () => call.resolve())

      expect(modesDisabled('GPT Custom')).toBe(false)
      expect(modelTestResult('GPT Custom')).toBe(MODEL_TEST_PASSED_TEXT)
    })

    it('shows a test that could not be run in the model’s row, and not as a toast', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { testGatewayModel } = await render()
      const failure = new Error('No such model: claude-sonnet')
      testGatewayModel.mockRejectedValueOnce(failure)

      await click(modelTestButton('Claude Sonnet'))

      expect(modelTestResult('Claude Sonnet'))
        .toBe('Couldn’t run the test: No such model: claude-sonnet')
      expect(modelTestButton('Claude Sonnet').textContent).toBe('Test')
      expect(modelTestResult('Claude Legacy')).toBe('')
      expect(addToast).not.toHaveBeenCalled()
      expect(logged).toHaveBeenCalledExactlyOnceWith(expect.any(String), failure)
    })

    // The row of a removed model stays until a re-read reports the model gone.
    it.each(MODEL_WRITES)('forgets a model’s result after %s, and no other result', async (
      _case, method, written, change,
    ) => {
      const rendered = await renderTested()

      await change()

      expect(rendered[method]).toHaveBeenCalledOnce()
      expect(rendered.onChanged).toHaveBeenCalledOnce()
      expect(addToast).not.toHaveBeenCalled()
      expect(results()).toEqual(
        ALL_PASSED.map((result, index) => (TESTED[index] === written ? '' : result)))
    })

    it.each(MODEL_WRITES)('keeps a model’s result after %s that the server refused', async (
      _case, method, _written, change,
    ) => {
      const rendered = await renderTested()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      rendered[method].mockRejectedValueOnce(
        new Error('This deployment does not provide models through AI Gateway.'))

      await change()

      expect(rendered[method]).toHaveBeenCalledOnce()
      expect(addToast).toHaveBeenCalledOnce()
      expect(rendered.onChanged).not.toHaveBeenCalled()
      expect(results()).toEqual(ALL_PASSED)
    })

    it('forgets every model’s result after a change of the default reasoning level, and no provider’s', async () => {
      const { setDefaultReasoning, onChanged } = await renderTested()

      await choose('Default reasoning level', 'High')

      expect(setDefaultReasoning).toHaveBeenCalledExactlyOnceWith('high')
      expect(onChanged).toHaveBeenCalledOnce()
      expect(results()).toEqual([...TESTED.map(() => ''), TEST_PASSED_TEXT])
    })

    it('keeps every result after a change of the default reasoning level that the server refused', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { setDefaultReasoning } = await renderTested()
      setDefaultReasoning.mockRejectedValueOnce(
        new Error('This deployment does not provide models through AI Gateway.'))

      await choose('Default reasoning level', 'High')

      expect(setDefaultReasoning).toHaveBeenCalledOnce()
      expect(addToast).toHaveBeenCalledOnce()
      expect(results()).toEqual(ALL_PASSED)
    })

    it.each([
      ['a change of another model’s mode', 'setGatewayModelMode',
        () => click(modeOption('Claude Haiku', 'Hidden'))],
      ['a change of another model’s settings', 'setGatewayModelSettings', async () => {
        await openSettings('Claude Haiku')
        await choose('Reasoning level for Claude Haiku', 'High')
      }],
      ['a provider turned on', 'setGatewayProviderEnabled', () => click(providerCheckbox('Google'))],
      ['users’ own models turned off', 'setUserModelsEnabled', () => click(userModelsCheckbox())],
      ['models.dev suggestions turned on', 'setModelsDevSuggestions',
        () => click(settingCheckbox(SUGGESTIONS_LABEL))],
      ['a model added', 'addGatewayModel', async () => {
        await fillAddForm({ id: 'gpt-next', name: 'GPT Next', contextWindow: '128000' })
        await click(button('Add model'))
      }],
    ] as const)('keeps every result after %s', async (_case, method, change) => {
      const rendered = await renderTested()

      await change()

      expect(rendered[method]).toHaveBeenCalledOnce()
      expect(rendered.onChanged).toHaveBeenCalledOnce()
      expect(addToast).not.toHaveBeenCalled()
      expect(results()).toEqual(ALL_PASSED)
    })

    it('keeps every result when the settings are re-read', async () => {
      const { show } = await renderTested()

      await show({
        ...RUNTIME_MODELS,
        defaultReasoning: 'high',
        models: RUNTIME_MODELS.models.map((model) => ({ ...model, mode: 'hidden' })),
      })

      expect(selectedMode('Claude Opus')).toEqual(['Hidden'])
      expect(results()).toEqual(ALL_PASSED)
    })

    it('forgets a result once the write has gone through, without waiting for the re-read', async () => {
      const { onChanged, testGatewayModel } = await render({ gatewayModels: RUNTIME_MODELS })
      const reread = deferred()
      onChanged.mockReturnValueOnce(reread.promise)
      testGatewayModel.mockResolvedValueOnce(FAILED)
      await click(modelTestButton('Claude Opus'))
      expect(modelTestResult('Claude Opus')).toBe('Failed (500): The server had an error.')

      await click(modeOption('Claude Opus', 'Hidden'))

      expect(onChanged).toHaveBeenCalledOnce()
      expect(modesDisabled('Claude Opus')).toBe(true)
      expect(modelTestResult('Claude Opus')).toBe('')

      // A test asked from here on is of the model as the write left it, so its result stays.
      await click(modelTestButton('Claude Opus'))
      await act(async () => reread.resolve())

      expect(modesDisabled('Claude Opus')).toBe(false)
      expect(testGatewayModel).toHaveBeenCalledTimes(2)
      expect(modelTestResult('Claude Opus')).toBe(MODEL_TEST_PASSED_TEXT)
    })

    it('forgets a result although the re-read after the write failed', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { onChanged, setGatewayModelMode } = await render({ gatewayModels: RUNTIME_MODELS })
      onChanged.mockRejectedValueOnce(new Error('Peer closed WebSocket: 1006 '))
      await click(modelTestButton('Claude Opus'))
      await click(modelTestButton('GPT Main'))

      await click(modeOption('Claude Opus', 'Hidden'))

      expect(setGatewayModelMode).toHaveBeenCalledExactlyOnceWith('claude-opus', 'hidden')
      expect(addToast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ title: 'Saved, but couldn’t reload the models' }))
      expect(modelTestResult('Claude Opus')).toBe('')
      expect(modelTestResult('GPT Main')).toBe(MODEL_TEST_PASSED_TEXT)
    })

    it.each([
      ['a write to the model', () => click(modeOption('Claude Opus', 'Hidden'))],
      ['a change of the default reasoning level', () => choose('Default reasoning level', 'High')],
    ])('shows nothing of an answer that arrives after %s, and tests the model again at once', async (
      _case, change,
    ) => {
      const { testGatewayModel } = await render({ gatewayModels: RUNTIME_MODELS })
      const earlier = deferred<GatewayModelTest>()
      const later = deferred<GatewayModelTest>()
      testGatewayModel.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise)
      await click(modelTestButton('Claude Opus'))
      expect(modelTestButton('Claude Opus').textContent).toBe('Testing…')

      await change()

      expect(modelTestButton('Claude Opus').textContent).toBe('Test')
      expect(modelTestResult('Claude Opus')).toBe('')

      await click(modelTestButton('Claude Opus'))
      expect(testGatewayModel.mock.calls).toEqual([['claude-opus'], ['claude-opus']])
      await act(async () => earlier.resolve(FAILED))

      // The earlier answer neither shows nor ends the later test.
      expect(modelTestButton('Claude Opus').textContent).toBe('Testing…')
      expect(modelTestResult('Claude Opus')).toBe('')

      await act(async () => later.resolve({ model: 'claude-opus', ok: true }))

      expect(modelTestButton('Claude Opus').textContent).toBe('Test')
      expect(modelTestResult('Claude Opus')).toBe(MODEL_TEST_PASSED_TEXT)
    })
  })

  // Every control is disabled for as long as a write takes, and a disabled control loses focus.
  describe('focus across a write', () => {
    const BUDGETED: GatewayModels = {
      ...RUNTIME_MODELS,
      models: [{ ...OPUS, settings: { compactionInputBudget: 150000 } }, HAIKU, SONNET, GPT, ADDED],
    }

    it.each([
      ['a model’s reasoning level', 'Reasoning level for Claude Opus', 'setGatewayModelSettings'],
      ['the default reasoning level', 'Default reasoning level', 'setDefaultReasoning'],
    ] as const)('returns to the select that %s was picked in', async (_case, select, method) => {
      const rendered = await render({ gatewayModels: RUNTIME_MODELS })
      const call = deferred()
      rendered[method].mockReturnValueOnce(call.promise)
      await openSettings('Claude Opus')

      await choose(select, 'High')
      await dropFocus()
      expect(button(select).disabled).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => call.resolve())

      expect(document.activeElement).toBe(button(select))
    })

    it('returns to the button that saved a budget', async () => {
      const { setGatewayModelSettings } = await render({ gatewayModels: RUNTIME_MODELS })
      const call = deferred()
      setGatewayModelSettings.mockReturnValueOnce(call.promise)
      await openSettings('Claude Opus')
      await type(budgetField(), '150000')
      const save = button('Save the compaction budget of Claude Opus')

      await focus(save)
      await click(save)
      await dropFocus()
      expect(save.disabled).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => call.resolve())

      expect(document.activeElement).toBe(save)
    })

    it('returns to the budget field after a reset, whose button is gone by then', async () => {
      const { setGatewayModelSettings, show } = await render({ gatewayModels: BUDGETED })
      const call = deferred()
      setGatewayModelSettings.mockReturnValueOnce(call.promise)
      await openSettings('Claude Opus')
      const reset = button('Reset the compaction budget of Claude Opus')

      await focus(reset)
      await click(reset)
      await dropFocus()
      expect(document.activeElement).toBe(document.body)
      // The re-read arrives before the controls are enabled.
      await show(RUNTIME_MODELS)
      await act(async () => call.resolve())

      expect(reset.isConnected).toBe(false)
      expect(document.activeElement).toBe(budgetField())
    })

    it('returns to the mode that was chosen', async () => {
      const { setGatewayModelMode } = await render({ gatewayModels: RUNTIME_MODELS })
      const call = deferred()
      setGatewayModelMode.mockReturnValueOnce(call.promise)
      const hidden = modeOptions('Claude Opus').find(({ text }) => text === 'Hidden')!.radio

      await focus(hidden)
      await click(modeOption('Claude Opus', 'Hidden'))
      await dropFocus()
      expect(modesDisabled('Claude Opus')).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => call.resolve())

      expect(document.activeElement).toBe(hidden)
    })

    it('leaves a confirmed removal’s focus to the dialog that is closing', async () => {
      const { removeGatewayModel } = await render({ gatewayModels: RUNTIME_MODELS })
      const call = deferred()
      removeGatewayModel.mockReturnValueOnce(call.promise)
      await click(button('Remove GPT Custom'))
      const confirm = button('Remove', confirmation()!)
      const focused = vi.spyOn(confirm, 'focus')

      await focus(confirm)
      focused.mockClear()
      await click(confirm)
      await dropFocus()
      await act(async () => call.resolve())

      expect(removeGatewayModel).toHaveBeenCalledWith('gpt-custom')
      expect(focused).not.toHaveBeenCalled()
    })

    it('returns to the provider switch that was turned', async () => {
      const { setGatewayProviderEnabled } = await render()
      const call = deferred()
      setGatewayProviderEnabled.mockReturnValueOnce(call.promise)
      const toggle = providerSwitch('Google')

      await focus(toggle)
      await click(providerCheckbox('Google'))
      await dropFocus()
      expect(toggle.disabled).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => call.resolve())

      expect(document.activeElement).toBe(providerSwitch('Google'))
    })

    it('leaves focus on a Test button that was pressed while the write was in flight', async () => {
      const { setGatewayProviderEnabled, testGatewayProvider } = await render()
      const call = deferred()
      setGatewayProviderEnabled.mockReturnValueOnce(call.promise)
      const answer = deferred<GatewayModelTest>()
      testGatewayProvider.mockReturnValueOnce(answer.promise)
      await focus(providerSwitch('Google'))
      await click(providerCheckbox('Google'))
      await dropFocus()

      await focus(testButton('OpenAI'))
      await click(testButton('OpenAI'))
      const pressed = document.activeElement
      await act(async () => call.resolve())

      expect(pressed?.textContent).toBe('Testing…')
      expect(document.activeElement).toBe(pressed)

      await act(async () => answer.resolve(TEST_PASSED))

      expect(document.activeElement).toBe(pressed)
      expect(pressed?.textContent).toBe('Test')
    })

    it('leaves focus on a model’s Test button that was pressed while the write was in flight', async () => {
      const { setGatewayModelMode, testGatewayModel } = await render({ gatewayModels: RUNTIME_MODELS })
      const call = deferred()
      setGatewayModelMode.mockReturnValueOnce(call.promise)
      const answer = deferred<GatewayModelTest>()
      testGatewayModel.mockReturnValueOnce(answer.promise)
      await focus(modeOptions('Claude Haiku').find(({ text }) => text === 'Hidden')!.radio)
      await click(modeOption('Claude Haiku', 'Hidden'))
      await dropFocus()

      await focus(modelTestButton('Claude Opus'))
      await click(modelTestButton('Claude Opus'))
      const pressed = document.activeElement
      await act(async () => call.resolve())

      expect(pressed?.textContent).toBe('Testing…')
      expect(document.activeElement).toBe(pressed)

      await act(async () => answer.resolve({ model: 'claude-opus', ok: true }))

      expect(document.activeElement).toBe(pressed)
      expect(pressed?.textContent).toBe('Test')
    })

    it('returns to the control a write was made from although a model’s test answered meanwhile', async () => {
      const { setGatewayModelMode } = await render({ gatewayModels: RUNTIME_MODELS })
      const call = deferred()
      setGatewayModelMode.mockReturnValueOnce(call.promise)
      const hidden = modeOptions('Claude Haiku').find(({ text }) => text === 'Hidden')!.radio
      await focus(hidden)
      await click(modeOption('Claude Haiku', 'Hidden'))
      await dropFocus()

      // Pressed without taking focus, as a pointer does in some browsers.
      await click(modelTestButton('Claude Opus'))

      expect(modelTestResult('Claude Opus')).toBe(MODEL_TEST_PASSED_TEXT)
      expect(modesDisabled('Claude Haiku')).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => call.resolve())

      expect(document.activeElement).toBe(hidden)
    })

    it('leaves focus where it was moved to while the write was in flight', async () => {
      const { setGatewayModelSettings } = await render({ gatewayModels: RUNTIME_MODELS })
      const call = deferred()
      setGatewayModelSettings.mockReturnValueOnce(call.promise)
      await openSettings('Claude Opus')
      await type(budgetField(), '150000')
      const save = button('Save the compaction budget of Claude Opus')
      await focus(save)
      await click(save)
      await dropFocus()

      // A disclosure stays enabled throughout.
      await focus(button('Settings for GPT Main'))
      await act(async () => call.resolve())

      expect(save.disabled).toBe(false)
      expect(document.activeElement).toBe(button('Settings for GPT Main'))
    })
  })

  describe('model modes', () => {
    it('names each control after its model and exposes the mode the server reported', async () => {
      await render()

      expect(selectedMode('Claude Sonnet')).toEqual(['Enabled (default)'])
      expect(selectedMode('Claude Legacy')).toEqual(['Disabled'])
    })

    it('marks the default mode, and marks a model as changed only when it is off its default', async () => {
      await render()

      expect(modeOptions('Claude Sonnet').map(({ text }) => text))
        .toEqual(['Enabled (default)', 'Hidden', 'Disabled'])
      expect(modeOptions('Claude Legacy').map(({ text }) => text))
        .toEqual(['Enabled', 'Hidden (default)', 'Disabled'])
      expect(row('Claude Sonnet').textContent).not.toContain('Changed')
      expect(row('Claude Legacy').textContent).toContain('Changed')
    })

    it('sets the chosen mode, then re-reads the settings', async () => {
      const { setGatewayModelMode, onChanged } = await render()

      await click(modeOption('Claude Sonnet', 'Hidden'))

      expect(setGatewayModelMode).toHaveBeenCalledExactlyOnceWith('claude-sonnet', 'hidden')
      expect(onChanged).toHaveBeenCalledOnce()
      expect(setGatewayModelMode.mock.invocationCallOrder[0])
        .toBeLessThan(onChanged.mock.invocationCallOrder[0])
    })

    it('resets an override by choosing the default mode', async () => {
      const { setGatewayModelMode } = await render()

      await click(modeOption('Claude Legacy', 'Hidden'))

      expect(setGatewayModelMode).toHaveBeenCalledExactlyOnceWith('claude-legacy', 'hidden')
    })

    it('disables a model only once that is confirmed', async () => {
      const { setGatewayModelMode, onChanged } = await render()

      await click(modeOption('Claude Sonnet', 'Disabled'))
      expect(setGatewayModelMode).not.toHaveBeenCalled()
      expect(confirmation()?.textContent).toContain('Claude Sonnet')
      expect(confirmation()?.textContent).toContain('scheduled tasks')
      expect(confirmation()?.textContent).toContain('hide it instead.')

      await click(button('Disable', confirmation()!))
      expect(setGatewayModelMode).toHaveBeenCalledExactlyOnceWith('claude-sonnet', 'disabled')
      expect(onChanged).toHaveBeenCalledOnce()
      expect(confirmation()).toBeNull()
    })

    it('leaves the model’s mode alone when disabling is cancelled', async () => {
      const { setGatewayModelMode } = await render()

      await click(modeOption('Claude Sonnet', 'Disabled'))
      await click(button('Cancel', confirmation()!))

      expect(setGatewayModelMode).not.toHaveBeenCalled()
      expect(confirmation()).toBeNull()
      expect(selectedMode('Claude Sonnet')).toEqual(['Enabled (default)'])
    })

    it.each([
      ['Claude Sonnet', 'Hidden', 'claude-sonnet', 'hidden'],
      ['Claude Legacy', 'Enabled', 'claude-legacy', 'enabled'],
    ])('sets %s to %s without asking', async (name, label, id, mode) => {
      const { setGatewayModelMode } = await render()

      await click(modeOption(name, label))

      expect(confirmation()).toBeNull()
      expect(setGatewayModelMode).toHaveBeenCalledExactlyOnceWith(id, mode)
    })

    it('reports a refused change with the server’s message and keeps showing the server’s mode', async () => {
      const { setGatewayModelMode, onChanged } = await render()
      setGatewayModelMode.mockRejectedValueOnce(new Error('No such model: claude-sonnet'))

      await click(modeOption('Claude Sonnet', 'Disabled'))
      await click(button('Disable', confirmation()!))

      expect(confirmation()).toBeNull()
      expect(addToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        description: 'No such model: claude-sonnet',
        variant: 'error',
      }))
      expect(onChanged).not.toHaveBeenCalled()
      expect(selectedMode('Claude Sonnet')).toEqual(['Enabled (default)'])
      expect(modesDisabled('Claude Sonnet')).toBe(false)
    })

    it('disables every control while a change is in flight', async () => {
      const { setGatewayModelMode } = await render()
      const call = deferred()
      setGatewayModelMode.mockReturnValueOnce(call.promise)

      await click(modeOption('Claude Sonnet', 'Hidden'))

      await click(modeOption('Claude Sonnet', 'Disabled'))
      await click(modeOption('Claude Legacy', 'Enabled'))
      expect(setGatewayModelMode).toHaveBeenCalledOnce()
      expect(confirmation()).toBeNull()
      expect(button('Remove GPT Custom').disabled).toBe(true)
      expect(button('Add model').disabled).toBe(true)

      await act(async () => call.resolve())

      expect(button('Remove GPT Custom').disabled).toBe(false)
      expect(button('Add model').disabled).toBe(false)
      await click(modeOption('Claude Legacy', 'Enabled'))
      expect(setGatewayModelMode).toHaveBeenLastCalledWith('claude-legacy', 'enabled')
    })
  })

  describe('added models', () => {
    it('lists them apart from the catalog, with their provider', async () => {
      await render()

      expect(row('GPT Custom').closest('section')?.querySelector('h3')?.textContent)
        .toBe('Added by this deployment')
      expect(row('GPT Custom').textContent).toContain('OpenAI')
      expect(row('Claude Sonnet').closest('section')?.querySelector('h3')?.textContent)
        .toBe('Anthropic')
    })

    it('removes a model only once the removal is confirmed', async () => {
      const { removeGatewayModel, onChanged } = await render()

      await click(button('Remove GPT Custom'))
      expect(removeGatewayModel).not.toHaveBeenCalled()
      expect(confirmation()?.textContent).toContain('GPT Custom')
      expect(confirmation()?.textContent).toContain('To shut a model off, disable it instead.')

      await click(button('Remove', confirmation()!))
      expect(removeGatewayModel).toHaveBeenCalledExactlyOnceWith('gpt-custom')
      expect(onChanged).toHaveBeenCalledOnce()
      expect(confirmation()).toBeNull()
    })

    it('leaves the model alone when the removal is cancelled', async () => {
      const { removeGatewayModel } = await render()

      await click(button('Remove GPT Custom'))
      await click(button('Cancel', confirmation()!))

      expect(removeGatewayModel).not.toHaveBeenCalled()
      expect(confirmation()).toBeNull()
    })

    it('reports a refused removal with the server’s message', async () => {
      const { removeGatewayModel } = await render()
      removeGatewayModel.mockRejectedValueOnce(new Error('No such added model: gpt-custom'))

      await click(button('Remove GPT Custom'))
      await click(button('Remove', confirmation()!))

      expect(addToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        description: 'No such added model: gpt-custom',
        variant: 'error',
      }))
    })
  })

  describe('adding a model', () => {
    const VALID = { id: 'gpt-next', name: 'GPT Next', contextWindow: '128000' }

    it.each([
      ['an empty ID', { ...VALID, id: '   ' }, 'Model ID'],
      ['an empty name', { ...VALID, name: '   ' }, 'Display name'],
      ['no context window', { ...VALID, contextWindow: '' }, 'Context window'],
      ['a fractional context window', { ...VALID, contextWindow: '1280.5' }, 'Context window'],
      ['a zero context window', { ...VALID, contextWindow: '0' }, 'Context window'],
      ['a negative context window', { ...VALID, contextWindow: '-128000' }, 'Context window'],
      ['a fractional output limit', { ...VALID, outputLimit: '40.96' }, 'Output limit'],
      ['a zero output limit', { ...VALID, outputLimit: '0' }, 'Output limit'],
    ])('refuses %s and points at the field', async (_case, fields, invalidField) => {
      const { addGatewayModel } = await render()
      await fillAddForm(fields)

      await click(button('Add model'))

      expect(addGatewayModel).not.toHaveBeenCalled()
      const field = labeledInput(invalidField)
      expect(field.getAttribute('aria-invalid')).toBe('true')
      expect(document.activeElement).toBe(field)
      const described = field.getAttribute('aria-describedby')!.split(' ')
        .map((id) => document.getElementById(id)?.textContent).join(' ')
      expect(described).toMatch(/^Enter /)
    })

    // Focus can't announce an error on the field it is already in.
    it('says the error aloud when the invalid field already has focus', async () => {
      const { addGatewayModel } = await render()
      await fillAddForm({ ...VALID, contextWindow: '128k' })
      const field = labeledInput('Context window')
      act(() => field.focus())

      await click(button('Add model'))

      expect(addGatewayModel).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(field)
      expect(document.body.querySelector('[role="alert"]')?.textContent)
        .toBe('Enter a positive whole number of tokens')

      await type(field, '128000')
      expect(document.body.querySelector('[role="alert"]')).toBeNull()
    })

    it('adds a model with trimmed text and numeric limits, then clears the form and re-reads', async () => {
      const { addGatewayModel, onChanged } = await render()
      await fillAddForm({ id: '  gpt-next ', name: ' GPT Next  ', contextWindow: ' 128000 ', outputLimit: '4096' })

      await click(button('Add model'))

      expect(addGatewayModel).toHaveBeenCalledExactlyOnceWith({
        provider: 'anthropic', id: 'gpt-next', name: 'GPT Next', contextWindow: 128000, outputLimit: 4096,
      })
      expect(onChanged).toHaveBeenCalledOnce()
      expect(addFormValues()).toEqual(['', '', '', ''])
    })

    it('leaves out the output limit when it is blank', async () => {
      const { addGatewayModel } = await render()
      await fillAddForm(VALID)

      await click(button('Add model'))

      expect(addGatewayModel).toHaveBeenCalledExactlyOnceWith({
        provider: 'anthropic', id: 'gpt-next', name: 'GPT Next', contextWindow: 128000,
      })
    })

    it('shows the server’s refusal and keeps what was entered', async () => {
      const { addGatewayModel, onChanged } = await render()
      addGatewayModel.mockRejectedValueOnce(new Error('"gpt-custom" is already an added model.'))
      await fillAddForm({ id: 'gpt-custom', name: 'GPT Custom', contextWindow: '128000', outputLimit: '4096' })

      await click(button('Add model'))

      expect(document.body.querySelector('[role="alert"]')?.textContent)
        .toBe('"gpt-custom" is already an added model.')
      expect(addFormValues()).toEqual(['gpt-custom', 'GPT Custom', '128000', '4096'])
      expect(onChanged).not.toHaveBeenCalled()
      expect(button('Add model').disabled).toBe(false)
    })

    it('cannot be submitted twice while the add is in flight', async () => {
      const { addGatewayModel } = await render()
      const call = deferred()
      addGatewayModel.mockReturnValueOnce(call.promise)
      await fillAddForm(VALID)

      await click(button('Add model'))
      expect(button('Add model').disabled).toBe(true)
      expect(modesDisabled('Claude Sonnet')).toBe(true)
      // Locked too, so nothing typed meanwhile is cleared with the model that was added.
      expect(labeledInput('Model ID').disabled).toBe(true)
      await act(async () => {
        document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(addGatewayModel).toHaveBeenCalledOnce()

      await act(async () => call.resolve())
      expect(button('Add model').disabled).toBe(false)
    })

    describe('behaving like another model', () => {
      const LABEL = 'Behaves like'
      const TOOLTIP =
        'The model chosen here lends the new one its thinking format and, where they are not ' +
        'stated here, its reasoning levels and its image input, until this version knows the new ' +
        'model itself. From then on the choice is not used. The name, the limits and the cost ' +
        'are never borrowed.'

      it('offers none, then the chosen provider’s catalog models that the runtime knows', async () => {
        await render({
          gatewayModels: { ...RUNTIME_MODELS, models: [...RUNTIME_MODELS.models, KNOWN_ADDED] },
        })

        expect(button(LABEL).textContent).toBe('None')
        // Neither Claude Sonnet, which the runtime has no entry for, nor Claude Added, which it
        // knows but the catalog doesn't list.
        expect(await optionLabels(LABEL)).toEqual(['None', 'Claude Opus', 'Claude Haiku'])

        await chooseProvider('OpenAI')

        expect(await optionLabels(LABEL)).toEqual(['None', 'GPT Main'])
      })

      it('is not offered under a provider with no such model', async () => {
        await render()

        expect(() => button(LABEL)).toThrow('No button')
      })

      it('adds the model with the one chosen, and has none chosen for the next', async () => {
        const { addGatewayModel } = await render({ gatewayModels: RUNTIME_MODELS })
        await fillAddForm(VALID)

        await choose(LABEL, 'Claude Haiku')
        expect(button(LABEL).textContent).toBe('Claude Haiku')
        await click(button('Add model'))

        expect(addGatewayModel).toHaveBeenCalledExactlyOnceWith({
          provider: 'anthropic', id: 'gpt-next', name: 'GPT Next', contextWindow: 128000,
          behavesLike: 'claude-haiku',
        })
        expect(button(LABEL).textContent).toBe('None')
      })

      it('adds the model with none once the choice is taken back', async () => {
        const { addGatewayModel } = await render({ gatewayModels: RUNTIME_MODELS })
        await fillAddForm(VALID)
        await choose(LABEL, 'Claude Haiku')

        await choose(LABEL, 'None')
        await click(button('Add model'))

        expect(addGatewayModel).toHaveBeenCalledOnce()
        expect(addGatewayModel.mock.calls[0][0]).not.toHaveProperty('behavesLike')
      })

      it('has none chosen after the provider changes, also once it changes back', async () => {
        const { addGatewayModel } = await render({ gatewayModels: RUNTIME_MODELS })
        await fillAddForm(VALID)
        await choose(LABEL, 'Claude Haiku')

        await chooseProvider('OpenAI')
        expect(button(LABEL).textContent).toBe('None')
        await chooseProvider('Anthropic')
        expect(button(LABEL).textContent).toBe('None')
        await click(button('Add model'))

        // What was typed by hand is kept, and the choice alone is dropped.
        expect(addGatewayModel).toHaveBeenCalledOnce()
        expect(addGatewayModel.mock.calls[0][0]).toEqual({
          provider: 'anthropic', id: 'gpt-next', name: 'GPT Next', contextWindow: 128000,
        })
        expect(addGatewayModel.mock.calls[0][0]).not.toHaveProperty('behavesLike')
      })

      // With no select to say so, the choice is dropped by the provider change alone.
      it('has none chosen after a change to a provider with no model to behave like, and back', async () => {
        const { addGatewayModel } = await render({
          gatewayModels: { ...RUNTIME_MODELS, models: [OPUS, HAIKU, ADDED] },
        })
        await fillAddForm(VALID)
        await choose(LABEL, 'Claude Haiku')

        await chooseProvider('OpenAI')
        expect(() => button(LABEL)).toThrow('No button')
        await chooseProvider('Anthropic')

        expect(button(LABEL).textContent).toBe('None')
        await click(button('Add model'))
        expect(addGatewayModel).toHaveBeenCalledOnce()
        expect(addGatewayModel.mock.calls[0][0]).toStrictEqual({
          provider: 'anthropic', id: 'gpt-next', name: 'GPT Next', contextWindow: 128000,
        })
      })

      it('is left as it is by a picked suggestion', async () => {
        stubModelsDev()
        const { addGatewayModel } = await render({
          gatewayModels: { ...RUNTIME_MODELS, modelsDevSuggestions: true },
        })
        await focus(labeledInput('Model ID'))
        await type(labeledInput('Model ID'), 'opus-4')

        await click(suggestionOptions()[0])
        expect(button(LABEL).textContent).toBe('None')

        await choose(LABEL, 'Claude Opus')
        await type(labeledInput('Model ID'), 'haiku-4')
        await click(suggestionOptions()[0])
        expect(button(LABEL).textContent).toBe('Claude Opus')
        await click(button('Add model'))

        expect(addGatewayModel).toHaveBeenCalledExactlyOnceWith({
          provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (latest)',
          contextWindow: 200000, outputLimit: 64000, behavesLike: 'claude-opus',
          capabilities: { imageInput: false },
        })
      })

      it('explains itself from an information button in its label', async () => {
        await render({ gatewayModels: RUNTIME_MODELS })
        const information = button('More information')

        expect(information.parentElement?.textContent).toContain(LABEL)
        expect(document.body.textContent).not.toContain(TOOLTIP)

        await focus(information)

        expect(document.body.textContent).toContain(TOOLTIP)
      })

      it('is locked while a write is in flight', async () => {
        const { addGatewayModel } = await render({ gatewayModels: RUNTIME_MODELS })
        const call = deferred()
        addGatewayModel.mockReturnValueOnce(call.promise)
        await fillAddForm(VALID)

        await click(button('Add model'))
        expect(button(LABEL).disabled).toBe(true)

        await act(async () => call.resolve())
        expect(button(LABEL).disabled).toBe(false)
      })
    })

    describe('stating what a model can do', () => {
      const IMAGES = 'Image input'
      const LEVELS = 'Reasoning levels'
      const NOT_STATED = 'Not stated'
      const ADDED_MODEL = {
        provider: 'anthropic', id: 'gpt-next', name: 'GPT Next', contextWindow: 128000,
      }

      // The list of levels stays open over a pick, for the next one. Escape puts it away, pressed
      // where a pick leaves focus.
      const pickLevels = async (...labels: string[]) => {
        for (const label of labels) await choose(LEVELS, label)
        await press(document.activeElement as HTMLElement, 'Escape')
        expect(button(LEVELS).getAttribute('aria-expanded')).toBe('false')
      }

      const stated = () => [button(IMAGES).textContent, button(LEVELS).textContent]

      it('states nothing of a model that is added as the form starts out', async () => {
        const { addGatewayModel } = await render()
        await fillAddForm(VALID)

        expect(stated()).toEqual([NOT_STATED, NOT_STATED])
        await click(button('Add model'))

        expect(addGatewayModel).toHaveBeenCalledOnce()
        expect(addGatewayModel.mock.calls[0][0]).toStrictEqual(ADDED_MODEL)
      })

      it('offers a yes or a no on images, and every reasoning level by its name', async () => {
        await render()

        expect(await optionLabels(IMAGES)).toEqual([NOT_STATED, 'Yes', 'No'])
        await press(document.activeElement as HTMLElement, 'Escape')
        expect(await optionLabels(LEVELS))
          .toEqual(['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'])
        expect(describedBy(button(LEVELS)))
          .toContain('Pick only Off for a model that does no reasoning.')
      })

      it.each([
        ['takes images', 'Yes', true],
        ['takes none', 'No', false],
      ])('adds a model stated as one that %s, with no levels stated', async (_case, label, imageInput) => {
        const { addGatewayModel } = await render()
        await fillAddForm(VALID)

        await choose(IMAGES, label)
        expect(stated()).toEqual([label, NOT_STATED])
        await click(button('Add model'))

        expect(addGatewayModel).toHaveBeenCalledOnce()
        expect(addGatewayModel.mock.calls[0][0])
          .toStrictEqual({ ...ADDED_MODEL, capabilities: { imageInput } })
      })

      it('adds a model with the levels picked, least to most whatever order they were picked in', async () => {
        const { addGatewayModel } = await render()
        await fillAddForm(VALID)

        await pickLevels('Max', 'Off', 'High')
        expect(stated()).toEqual([NOT_STATED, 'Off, High, Max'])
        await click(button('Add model'))

        expect(addGatewayModel).toHaveBeenCalledOnce()
        expect(addGatewayModel.mock.calls[0][0])
          .toStrictEqual({ ...ADDED_MODEL, capabilities: { reasoningLevels: ['off', 'high', 'max'] } })
      })

      it('adds a model that does no reasoning with Off alone, beside what is stated of images', async () => {
        const { addGatewayModel } = await render()
        await fillAddForm(VALID)

        await choose(IMAGES, 'Yes')
        await pickLevels('Off')
        expect(stated()).toEqual(['Yes', 'Off'])
        await click(button('Add model'))

        expect(addGatewayModel).toHaveBeenCalledOnce()
        expect(addGatewayModel.mock.calls[0][0]).toStrictEqual({
          ...ADDED_MODEL, capabilities: { imageInput: true, reasoningLevels: ['off'] },
        })
      })

      it('states only what is left once a statement is taken back', async () => {
        const { addGatewayModel } = await render()
        await fillAddForm(VALID)
        await choose(IMAGES, 'No')
        await pickLevels('Low', 'High')

        await pickLevels('Low')
        expect(stated()).toEqual(['No', 'High'])
        await choose(IMAGES, NOT_STATED)
        expect(stated()).toEqual([NOT_STATED, 'High'])
        await pickLevels('High')
        expect(stated()).toEqual([NOT_STATED, NOT_STATED])
        await click(button('Add model'))

        expect(addGatewayModel).toHaveBeenCalledOnce()
        expect(addGatewayModel.mock.calls[0][0]).toStrictEqual(ADDED_MODEL)
      })

      it('has nothing stated for the next model after an add', async () => {
        const { addGatewayModel } = await render()
        await fillAddForm(VALID)
        await choose(IMAGES, 'Yes')
        await pickLevels('Low', 'High')

        await click(button('Add model'))
        expect(stated()).toEqual([NOT_STATED, NOT_STATED])
        await fillAddForm({ ...VALID, id: 'gpt-after' })
        await click(button('Add model'))

        expect(addGatewayModel).toHaveBeenCalledTimes(2)
        expect(addGatewayModel.mock.calls[0][0]).toStrictEqual({
          ...ADDED_MODEL, capabilities: { imageInput: true, reasoningLevels: ['low', 'high'] },
        })
        expect(addGatewayModel.mock.calls[1][0]).toStrictEqual({ ...ADDED_MODEL, id: 'gpt-after' })
      })

      it('keeps what was stated when the server refuses the model', async () => {
        const { addGatewayModel } = await render()
        addGatewayModel.mockRejectedValueOnce(new Error('"gpt-next" is already an added model.'))
        await fillAddForm(VALID)
        await choose(IMAGES, 'No')
        await pickLevels('Off')

        await click(button('Add model'))

        expect(document.body.querySelector('[role="alert"]')?.textContent)
          .toBe('"gpt-next" is already an added model.')
        expect(stated()).toEqual(['No', 'Off'])
      })

      it('is prefilled by a picked suggestion with what models.dev states, and with no more', async () => {
        const limit = { context: 200000, output: 64000 }
        stubModelsDev(async () => new Response(JSON.stringify({
          anthropic: {
            models: {
              sees: {
                ...listed('claude-sees', 'Claude Sees', limit),
                modalities: { input: ['text', 'image'], output: ['text'] },
                reasoning: true,
              },
              plain: { ...listed('claude-plain', 'Claude Plain', limit), reasoning: false },
              thinks: {
                ...listed('claude-thinks', 'Claude Thinks', limit),
                reasoning: true,
                reasoning_options: [{ type: 'effort', values: ['none', 'high'] }],
              },
              silent: {
                ...listed('claude-silent', 'Claude Silent', limit), modalities: { output: ['text'] },
              },
            },
          },
        })))
        const { addGatewayModel } = await render({ gatewayModels: SUGGESTING })

        // Its entry names no efforts, so no levels are stated for it.
        await pickSuggestion('sees')
        expect(stated()).toEqual(['Yes', NOT_STATED])

        await pickSuggestion('thinks')
        expect(stated()).toEqual(['No', 'Off, High'])

        await pickSuggestion('plain')
        expect(stated()).toEqual(['No', 'Off'])

        // A pick states what its entry does and nothing else, so it also takes a statement away.
        await pickSuggestion('silent')
        expect(stated()).toEqual([NOT_STATED, NOT_STATED])

        await pickSuggestion('plain')
        await choose(IMAGES, 'Yes')
        await click(button('Add model'))

        // What is added is what the form then holds.
        expect(addGatewayModel).toHaveBeenCalledOnce()
        expect(addGatewayModel.mock.calls[0][0]).toStrictEqual({
          provider: 'anthropic', id: 'claude-plain', name: 'Claude Plain', contextWindow: 200000,
          outputLimit: 64000, capabilities: { imageInput: true, reasoningLevels: ['off'] },
        })
      })

      it('follows a model typed by hand to another provider, and not a suggested one', async () => {
        stubModelsDev()
        await render({ gatewayModels: SUGGESTING })
        await fillAddForm(VALID)
        await choose(IMAGES, 'Yes')
        await pickLevels('High')

        await chooseProvider('OpenAI')
        expect(stated()).toEqual(['Yes', 'High'])

        await pickSuggestion('5.2')
        expect(stated()).toEqual(['No', NOT_STATED])
        await pickLevels('Off')
        await chooseProvider('Anthropic')

        expect(addFormValues()).toEqual(['', '', '', ''])
        expect(stated()).toEqual([NOT_STATED, NOT_STATED])
      })

      it('is locked while a write is in flight', async () => {
        const { addGatewayModel } = await render()
        const call = deferred()
        addGatewayModel.mockReturnValueOnce(call.promise)
        await fillAddForm(VALID)

        await click(button('Add model'))
        expect(button(IMAGES).disabled).toBe(true)
        expect(button(LEVELS).disabled).toBe(true)

        await act(async () => call.resolve())
        expect(button(IMAGES).disabled).toBe(false)
        expect(button(LEVELS).disabled).toBe(false)
      })
    })

    describe('testing a model before adding it', () => {
      const HELP =
        'Test sends the model described here one request with no reasoning level set and one at ' +
        'each reasoning level it would list once added. Each request can use up to 2,048 output ' +
        'tokens, and nothing is added.'
      const HINT =
        'The gateway may hold no key or credits for this provider, or CF_AI_GATEWAY_API_TOKEN ' +
        'may not be allowed to run models.'
      // The one line of the test that the fake admin answers with.
      const NO_LEVEL_PASSED = `No level set: ${MODEL_TEST_PASSED_TEXT}`
      const ALREADY_ADDED = '"gpt-next" is already an added model.'

      // A valid form whose model was tested, with the answer shown.
      const renderTested = async (gatewayModels = GATEWAY_MODELS) => {
        const rendered = await render({ gatewayModels })
        await fillAddForm(VALID)
        await click(formTestButton())
        expect(formTestResult()).toEqual([NO_LEVEL_PASSED])
        return rendered
      }

      it('says by its buttons what Test sends and can use, and that nothing is added', async () => {
        await render()

        const form = button('Add model').closest('form')!
        const help = Array.from(form.querySelectorAll('p')).find((p) => p.textContent === HELP)
        expect(help).toBeDefined()
        // Read in the page's flow, and not spoken as a result is.
        expect(help!.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull()
        expect(button('Add model').compareDocumentPosition(formTestButton())
          & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(formTestButton().type).toBe('button')
        expect(formTestButton().textContent).toBe('Test')
        // The region is there for the first answer to be announced in.
        expect(formTestResult()).toEqual([])
      })

      it('tests the model as the form describes it, once, and adds nothing', async () => {
        const { testNewGatewayModel, addGatewayModel, onChanged } =
          await render({ gatewayModels: RUNTIME_MODELS })
        const typed = { id: '  gpt-next ', name: ' GPT Next  ', contextWindow: ' 128000 ', outputLimit: '4096' }
        await fillAddForm(typed)
        await choose('Behaves like', 'Claude Haiku')
        await choose('Image input', 'No')
        await choose('Reasoning levels', 'High')
        await choose('Reasoning levels', 'Off')
        await press(document.activeElement as HTMLElement, 'Escape')

        await click(formTestButton())

        expect(testNewGatewayModel).toHaveBeenCalledOnce()
        expect(testNewGatewayModel.mock.calls[0]).toStrictEqual([{
          provider: 'anthropic', id: 'gpt-next', name: 'GPT Next', contextWindow: 128000,
          outputLimit: 4096, behavesLike: 'claude-haiku',
          capabilities: { imageInput: false, reasoningLevels: ['off', 'high'] },
        }])
        expect(formTestResult()).toEqual([NO_LEVEL_PASSED])
        expect(addGatewayModel).not.toHaveBeenCalled()
        expect(onChanged).not.toHaveBeenCalled()
        expect(addToast).not.toHaveBeenCalled()
        expect(addFormValues()).toEqual(Object.values(typed))
        expect(button('Behaves like').textContent).toBe('Claude Haiku')
      })

      it('shows a line for each request under the level it asked for, in the order they came in', async () => {
        const { testNewGatewayModel } = await render()
        testNewGatewayModel.mockResolvedValueOnce([
          levelPassed(null),
          levelFailed('off', 'Unsupported value: reasoning_effort does not support none.', 400),
          levelFailed('xhigh', 'The request timed out.'),
          levelPassed('max'),
        ])
        await fillAddForm(VALID)

        await click(formTestButton())

        expect(formTestResult()).toEqual([
          NO_LEVEL_PASSED,
          'Off: Failed (400): Unsupported value: reasoning_effort does not support none.',
          'Extra high: Failed: The request timed out.',
          `Max: ${MODEL_TEST_PASSED_TEXT}`,
        ])
        expect(addToast).not.toHaveBeenCalled()
      })

      it('says once, after the lines, what requests refused as unauthorized may mean', async () => {
        const { testNewGatewayModel } = await render()
        testNewGatewayModel.mockResolvedValueOnce([
          levelFailed(null, 'invalid x-api-key', 401),
          levelFailed('low', 'Your credit balance is too low.', 403),
          levelPassed('high'),
        ])
        await fillAddForm(VALID)

        await click(formTestButton())

        expect(formTestResult()).toEqual([
          'No level set: Failed (401): invalid x-api-key',
          'Low: Failed (403): Your credit balance is too low.',
          `High: ${MODEL_TEST_PASSED_TEXT}`,
          HINT,
        ])
      })

      it.each([
        ['an empty ID', { ...VALID, id: '   ' }, 'Model ID'],
        ['an empty name', { ...VALID, name: '   ' }, 'Display name'],
        ['a fractional context window', { ...VALID, contextWindow: '1280.5' }, 'Context window'],
        ['a zero output limit', { ...VALID, outputLimit: '0' }, 'Output limit'],
      ])('asks for nothing with %s, and points at the field as an add does', async (
        _case, fields, invalidField,
      ) => {
        const { testNewGatewayModel, addGatewayModel } = await render()
        await fillAddForm(fields)

        await click(formTestButton())

        expect(testNewGatewayModel).not.toHaveBeenCalled()
        expect(addGatewayModel).not.toHaveBeenCalled()
        const field = labeledInput(invalidField)
        expect(field.getAttribute('aria-invalid')).toBe('true')
        expect(document.activeElement).toBe(field)
        expect(describedBy(field)).toMatch(/^Enter /)
        expect(formTestButton().textContent).toBe('Test')
        expect(formTestResult()).toEqual([])
      })

      // Focus can't announce an error on the field it is already in.
      it('says the error aloud when the invalid field already has focus', async () => {
        const { testNewGatewayModel } = await render()
        await fillAddForm({ ...VALID, contextWindow: '128k' })
        const field = labeledInput('Context window')
        await focus(field)

        await click(formTestButton())

        expect(testNewGatewayModel).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(field)
        expect(document.body.querySelector('[role="alert"]')?.textContent)
          .toBe('Enter a positive whole number of tokens')
      })

      it('says that a test is in flight, keeps focus, and asks for nothing on a second press', async () => {
        const { testNewGatewayModel, addGatewayModel } = await render()
        const call = deferred<GatewayModelLevelTest[]>()
        testNewGatewayModel.mockReturnValueOnce(call.promise)
        await fillAddForm(VALID)
        const pressed = formTestButton()
        expect(pressed.getAttribute('aria-label')).toBe('Test this model')
        await focus(pressed)

        await click(pressed)

        expect(formTestButton()).toBe(pressed)
        expect(pressed.textContent).toBe('Testing…')
        expect(pressed.getAttribute('aria-label')).toBe('Testing this model…')
        expect(pressed.getAttribute('aria-disabled')).toBe('true')
        expect(pressed.disabled).toBe(false)
        expect(document.activeElement).toBe(pressed)
        expect(formTestResult()).toEqual([])
        // A test is not a write, so it locks nothing.
        expect(button('Add model').disabled).toBe(false)
        expect(labeledInput('Model ID').disabled).toBe(false)
        expect(modesDisabled('Claude Sonnet')).toBe(false)
        await click(pressed)
        expect(testNewGatewayModel).toHaveBeenCalledOnce()

        await act(async () => call.resolve([levelPassed(null), levelPassed('high')]))

        expect(pressed.textContent).toBe('Test')
        expect(pressed.getAttribute('aria-label')).toBe('Test this model')
        expect(pressed.getAttribute('aria-disabled')).toBe('false')
        expect(document.activeElement).toBe(pressed)
        expect(formTestResult()).toEqual([NO_LEVEL_PASSED, `High: ${MODEL_TEST_PASSED_TEXT}`])
        expect(addGatewayModel).not.toHaveBeenCalled()

        // Once a test has answered, the next press runs another.
        await click(pressed)
        expect(testNewGatewayModel).toHaveBeenCalledTimes(2)
      })

      it('shows why a test could not be run, in the form and not as a toast', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { testNewGatewayModel } = await render()
        const failure = new Error(ALREADY_ADDED)
        testNewGatewayModel.mockRejectedValueOnce(failure)
        await fillAddForm(VALID)

        await click(formTestButton())

        expect(formTestResult()).toEqual([`Couldn’t run the test: ${ALREADY_ADDED}`])
        expect(formTestButton().textContent).toBe('Test')
        // Said in the test's own region, and not as the refusal of an add is.
        expect(document.body.querySelector('[role="alert"]')).toBeNull()
        expect(addToast).not.toHaveBeenCalled()
        expect(logged).toHaveBeenCalledExactlyOnceWith(expect.any(String), failure)
        expect(addFormValues()).toEqual(['gpt-next', 'GPT Next', '128000', ''])
      })

      // Every way the form comes to describe another model: what each is, and what makes it.
      const EDITS = [
        ['the model ID is edited', () => type(labeledInput('Model ID'), 'gpt-after')],
        ['the display name is edited', () => type(labeledInput('Display name'), 'GPT After')],
        ['the context window is edited', () => type(labeledInput('Context window'), '64000')],
        ['the output limit is edited', () => type(labeledInput('Output limit'), '4096')],
        ['a model to behave like is chosen', () => choose('Behaves like', 'Claude Haiku')],
        ['image input is stated', () => choose('Image input', 'Yes')],
        ['a reasoning level is stated', () => choose('Reasoning levels', 'High')],
        ['the provider is changed', () => chooseProvider('OpenAI')],
      ] as const

      it.each(EDITS)('forgets the results once %s', async (_case, edit) => {
        const { testNewGatewayModel } = await renderTested(RUNTIME_MODELS)

        await edit()

        expect(formTestResult()).toEqual([])
        expect(testNewGatewayModel).toHaveBeenCalledOnce()
      })

      // The provider is the first one offered until another is chosen, so the form follows the
      // list it is given without an edit.
      it('shows nothing of a test once the form describes the model under another provider', async () => {
        const { show, testNewGatewayModel } = await renderTested()
        expect(testNewGatewayModel.mock.calls[0][0].provider).toBe('anthropic')

        await show({ ...GATEWAY_MODELS, providers: ['openai'] })

        expect(formTestResult()).toEqual([])
        await click(formTestButton())
        expect(testNewGatewayModel.mock.calls.map(([model]) => model.provider))
          .toEqual(['anthropic', 'openai'])
      })

      it('forgets the results once a suggestion is picked', async () => {
        stubModelsDev()
        await render({ gatewayModels: SUGGESTING })
        await type(labeledInput('Display name'), 'Opus')
        await type(labeledInput('Context window'), '200000')
        await focus(labeledInput('Model ID'))
        await type(labeledInput('Model ID'), 'opus')
        await click(formTestButton())
        expect(formTestResult()).toEqual([NO_LEVEL_PASSED])

        await click(suggestionOptions()[0])

        expect(addFormValues()).toEqual(['claude-opus-4-5', 'Claude Opus 4.5 (latest)', '200000', '64000'])
        expect(formTestResult()).toEqual([])
      })

      it('shows nothing of an answer that arrives after an edit, and tests the edited model at once', async () => {
        const { testNewGatewayModel } = await render()
        const earlier = deferred<GatewayModelLevelTest[]>()
        const later = deferred<GatewayModelLevelTest[]>()
        testNewGatewayModel.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise)
        await fillAddForm(VALID)
        await click(formTestButton())
        expect(formTestButton().textContent).toBe('Testing…')

        await type(labeledInput('Display name'), 'GPT After')

        expect(formTestButton().textContent).toBe('Test')
        expect(formTestResult()).toEqual([])

        await click(formTestButton())
        expect(testNewGatewayModel.mock.calls.map(([model]) => model.name))
          .toEqual(['GPT Next', 'GPT After'])
        await act(async () => earlier.resolve([levelFailed(null, 'The server had an error.', 500)]))

        // The earlier answer neither shows nor ends the later test.
        expect(formTestButton().textContent).toBe('Testing…')
        expect(formTestResult()).toEqual([])

        await act(async () => later.resolve([levelPassed(null)]))

        expect(formTestButton().textContent).toBe('Test')
        expect(formTestResult()).toEqual([NO_LEVEL_PASSED])
      })

      it('forgets the results once the model is added, and tests nothing by adding it', async () => {
        const { addGatewayModel, testNewGatewayModel } = await renderTested()

        await click(button('Add model'))

        expect(addGatewayModel).toHaveBeenCalledOnce()
        expect(addFormValues()).toEqual(['', '', '', ''])
        expect(formTestResult()).toEqual([])
        expect(testNewGatewayModel).toHaveBeenCalledOnce()
      })

      it('shows nothing of an answer that arrives after the model is added', async () => {
        const { testNewGatewayModel } = await render()
        const call = deferred<GatewayModelLevelTest[]>()
        testNewGatewayModel.mockReturnValueOnce(call.promise)
        await fillAddForm(VALID)
        await click(formTestButton())

        await click(button('Add model'))

        expect(addFormValues()).toEqual(['', '', '', ''])
        expect(formTestButton().textContent).toBe('Test')

        await act(async () => call.resolve([levelPassed(null)]))

        expect(formTestResult()).toEqual([])
      })

      it('keeps the results of a model that the server refused to add, and the refusal over a test', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const { addGatewayModel, testNewGatewayModel } = await renderTested()
        addGatewayModel.mockRejectedValueOnce(new Error(ALREADY_ADDED))

        await click(button('Add model'))

        expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(ALREADY_ADDED)
        expect(formTestResult()).toEqual([NO_LEVEL_PASSED])

        // Pressing Test describes no other model, so it is no edit either.
        testNewGatewayModel.mockResolvedValueOnce([levelPassed(null), levelPassed('low')])
        await click(formTestButton())

        expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(ALREADY_ADDED)
        expect(formTestResult()).toEqual([NO_LEVEL_PASSED, `Low: ${MODEL_TEST_PASSED_TEXT}`])
        expect(addGatewayModel).toHaveBeenCalledOnce()
      })

      it('can be run while a write is in flight', async () => {
        const { setUserModelsEnabled, testNewGatewayModel } = await render()
        const call = deferred()
        setUserModelsEnabled.mockReturnValueOnce(call.promise)
        await fillAddForm(VALID)
        await click(userModelsCheckbox())
        expect(button('Add model').disabled).toBe(true)
        expect(labeledInput('Model ID').disabled).toBe(true)

        expect(formTestButton().disabled).toBe(false)
        expect(formTestButton().getAttribute('aria-disabled')).toBe('false')
        await click(formTestButton())

        expect(testNewGatewayModel).toHaveBeenCalledOnce()
        expect(testNewGatewayModel.mock.calls[0]).toStrictEqual([{
          provider: 'anthropic', id: 'gpt-next', name: 'GPT Next', contextWindow: 128000,
        }])
        expect(formTestResult()).toEqual([NO_LEVEL_PASSED])
        // The test did not end the write's lock either.
        expect(button('Add model').disabled).toBe(true)

        await act(async () => call.resolve())

        expect(button('Add model').disabled).toBe(false)
        expect(formTestResult()).toEqual([NO_LEVEL_PASSED])
      })
    })

    it('offers no form while no provider that a model can be added under is on', async () => {
      await render({ gatewayModels: { ...GATEWAY_MODELS, providers: [], models: [SONNET] } })

      expect(document.body.querySelector('form')).toBeNull()
      expect(document.body.textContent)
        .toContain('No model can be added, because no provider is on. Turn one on under Providers.')
    })
  })

  describe('suggestions from models.dev', () => {
    const modelId = () => labeledInput('Model ID')

    describe('the setting', () => {
      it.each([true, false])('shows %s as the server reported it, with what it does', async (enabled) => {
        await render({ gatewayModels: { ...GATEWAY_MODELS, modelsDevSuggestions: enabled } })

        const toggle = settingSwitch(SUGGESTIONS_LABEL)
        expect(toggle.getAttribute('aria-checked')).toBe(String(enabled))
        const meaning = document.getElementById(toggle.getAttribute('aria-describedby')!)
        expect(meaning?.textContent).toContain('your browser downloads models.dev’s public model list')
        expect(meaning?.textContent).toContain('nothing is added until you select “Add model”')
      })

      it.each([true, false])('sets the opposite of %s, then re-reads the settings', async (enabled) => {
        const { setModelsDevSuggestions, setUserModelsEnabled, onChanged } = await render({
          gatewayModels: { ...GATEWAY_MODELS, modelsDevSuggestions: enabled },
        })

        await click(settingCheckbox(SUGGESTIONS_LABEL))

        expect(setModelsDevSuggestions).toHaveBeenCalledExactlyOnceWith(!enabled)
        expect(setUserModelsEnabled).not.toHaveBeenCalled()
        expect(onChanged).toHaveBeenCalledOnce()
        expect(setModelsDevSuggestions.mock.invocationCallOrder[0])
          .toBeLessThan(onChanged.mock.invocationCallOrder[0])
        // The re-read is what moves the switch.
        expect(settingSwitch(SUGGESTIONS_LABEL).getAttribute('aria-checked')).toBe(String(enabled))
      })

      it('reports a refused change with the server’s message and keeps showing the server’s value', async () => {
        const { setModelsDevSuggestions, onChanged } = await render()
        setModelsDevSuggestions.mockRejectedValueOnce(
          new Error('This deployment does not provide models through AI Gateway.'))

        await click(settingCheckbox(SUGGESTIONS_LABEL))

        expect(addToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          title: 'Couldn’t update “Suggest models from models.dev”',
          description: 'This deployment does not provide models through AI Gateway.',
          variant: 'error',
        }))
        expect(onChanged).not.toHaveBeenCalled()
        expect(settingSwitch(SUGGESTIONS_LABEL).getAttribute('aria-checked')).toBe('false')
      })

      it('is locked while a change is in flight, and locks the other controls', async () => {
        const { setModelsDevSuggestions, setGatewayModelMode } = await render()
        const call = deferred()
        setModelsDevSuggestions.mockReturnValueOnce(call.promise)

        await click(settingCheckbox(SUGGESTIONS_LABEL))

        expect(settingSwitch(SUGGESTIONS_LABEL).disabled).toBe(true)
        await click(settingCheckbox(SUGGESTIONS_LABEL))
        await click(modeOption('Claude Sonnet', 'Hidden'))
        expect(setModelsDevSuggestions).toHaveBeenCalledOnce()
        expect(setGatewayModelMode).not.toHaveBeenCalled()

        await act(async () => call.resolve())

        expect(settingSwitch(SUGGESTIONS_LABEL).disabled).toBe(false)
      })

      it('is not offered where no model can be added', async () => {
        await render({ gatewayModels: { ...SUGGESTING, providers: [] } })

        expect(() => settingSwitch(SUGGESTIONS_LABEL)).toThrow('No button')
      })
    })

    it('asks models.dev for nothing while the setting is off, and leaves the field plain text', async () => {
      const fetch = stubModelsDev()
      await render()

      await focus(modelId())
      await type(modelId(), 'claude')

      expect(fetch).not.toHaveBeenCalled()
      expect(modelId().getAttribute('role')).toBeNull()
      expect(suggested()).toEqual([])
      expect(suggestionNote()).toEqual([])
    })

    it.each([
      ['focused', () => focus(modelId())],
      ['typed into', () => type(modelId(), 'c')],
    ])('asks for the list only once the Model ID field is %s', async (_how, engage) => {
      const fetch = stubModelsDev()
      await render({ gatewayModels: SUGGESTING })

      await focus(labeledInput('Display name'))
      await type(labeledInput('Display name'), 'Claude')
      expect(fetch).not.toHaveBeenCalled()

      await engage()

      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0][0]).toBe(MODELS_DEV_URL)
    })

    it('asks once, whatever is typed, re-read or switched afterwards', async () => {
      const fetch = stubModelsDev()
      const { show } = await render({ gatewayModels: SUGGESTING })

      await focus(modelId())
      await type(modelId(), 'cl')
      await type(modelId(), 'claude')
      await focus(labeledInput('Display name'))
      await focus(modelId())
      await show({ ...SUGGESTING, userModelsEnabled: false })
      await show(GATEWAY_MODELS)
      await show(SUGGESTING)
      await focus(labeledInput('Display name'))
      await focus(modelId())
      await type(modelId(), 'claude-')

      expect(fetch).toHaveBeenCalledOnce()
      expect(suggested()).not.toEqual([])
    })

    it('does not ask again after a failure', async () => {
      const fetch = stubModelsDev(async () => { throw new TypeError('Failed to fetch') })
      await render({ gatewayModels: SUGGESTING })

      await focus(modelId())
      await focus(labeledInput('Display name'))
      await focus(modelId())
      await type(modelId(), 'claude')

      expect(fetch).toHaveBeenCalledOnce()
    })

    it('works as plain text while the list loads, and gives the request up when the panel goes away', async () => {
      const fetch = stubModelsDev(() => new Promise<Response>(() => {}))
      await render({ gatewayModels: SUGGESTING })

      await focus(modelId())
      await type(modelId(), 'claude-next')

      expect(modelId().value).toBe('claude-next')
      expect(suggested()).toEqual([])
      expect(suggestionNote()).toEqual([])
      expect(modelId().getAttribute('aria-expanded')).toBe('false')
      const signal = fetch.mock.calls[0][1]?.signal
      expect(signal?.aborted).toBe(false)

      act(() => root!.unmount())
      root = undefined

      expect(signal?.aborted).toBe(true)
    })

    it('says nothing about a request the panel gave up by going away', async () => {
      stubModelsDev((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      await render({ gatewayModels: SUGGESTING })
      await focus(modelId())

      await act(async () => root!.unmount())
      root = undefined

      const errors = logged.mock.calls.length
      logged.mockRestore()
      expect(errors).toBe(0)
    })

    it('suggests, as text, the chosen provider’s models that the deployment lacks', async () => {
      stubModelsDev()
      await render({ gatewayModels: SUGGESTING })

      await focus(modelId())
      await type(modelId(), '-')

      // Neither claude-sonnet, which the deployment has, nor gpt-5.2, which is another provider's.
      expect(suggested()).toEqual([
        'claude-opus-4-5Claude Opus 4.5 (latest)',
        'claude-haiku-4-5Claude Haiku 4.5 (latest)',
        'claude-markup<img src="x" alt="markup">',
      ])
      expect(document.body.querySelector('[role="option"] img')).toBeNull()

      expect(modelId().getAttribute('role')).toBe('combobox')
      expect(modelId().getAttribute('aria-expanded')).toBe('true')
      expect(suggestionOptions()[0].closest('[role="listbox"]')?.id)
        .toBe(modelId().getAttribute('aria-controls'))

      await type(modelId(), 'opus')
      expect(suggested()).toEqual(['claude-opus-4-5Claude Opus 4.5 (latest)'])

      // An ID that matches nothing is plain text, over no open list.
      await type(modelId(), 'claude-next')
      expect(suggested()).toEqual([])
      expect(modelId().value).toBe('claude-next')
      expect(modelId().getAttribute('aria-expanded')).toBe('false')
    })

    it('fills nothing in for an ID typed out by hand, even a suggested one', async () => {
      stubModelsDev()
      await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await type(labeledInput('Display name'), 'My Opus')
      await type(labeledInput('Context window'), '150000')
      await type(labeledInput('Output limit'), '8000')

      await type(modelId(), 'claude-opus-4-5')

      expect(addFormValues()).toEqual(['claude-opus-4-5', 'My Opus', '150000', '8000'])
    })

    it('fills the form in from a picked suggestion, and adds what the form then holds', async () => {
      stubModelsDev()
      const { addGatewayModel } = await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await type(modelId(), 'opus')

      await click(suggestionOptions()[0])

      expect(addFormValues()).toEqual(['claude-opus-4-5', 'Claude Opus 4.5 (latest)', '200000', '64000'])
      expect(addGatewayModel).not.toHaveBeenCalled()

      await type(labeledInput('Display name'), 'Claude Opus 4.5')
      await type(labeledInput('Output limit'), '32000')
      await click(button('Add model'))

      expect(addGatewayModel).toHaveBeenCalledExactlyOnceWith({
        provider: 'anthropic', id: 'claude-opus-4-5', name: 'Claude Opus 4.5',
        contextWindow: 200000, outputLimit: 32000, capabilities: { imageInput: false },
      })
    })

    it('adds a picked suggestion as it was filled in', async () => {
      stubModelsDev()
      const { addGatewayModel } = await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await type(modelId(), 'haiku')

      await click(suggestionOptions()[0])
      await click(button('Add model'))

      expect(addGatewayModel).toHaveBeenCalledExactlyOnceWith({
        provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (latest)',
        contextWindow: 200000, outputLimit: 64000, capabilities: { imageInput: false },
      })
    })

    // The server's Workers AI default applies to a model added without an output limit.
    it('empties the output limit for a Workers AI suggestion', async () => {
      stubModelsDev()
      await render({ gatewayModels: { ...SUGGESTING, providers: ['cloudflare'] } })
      await type(labeledInput('Output limit'), '4096')
      await focus(modelId())
      await type(modelId(), 'llama')

      await click(suggestionOptions()[0])

      expect(addFormValues()).toEqual([
        '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B 16E Instruct', '131000', '',
      ])
    })

    it('picks with the keyboard, without submitting the form', async () => {
      stubModelsDev()
      const { addGatewayModel } = await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await type(modelId(), 'claude')

      await press(modelId(), 'ArrowDown')
      await press(modelId(), 'ArrowDown')
      expect(modelId().getAttribute('aria-activedescendant')).toBe(suggestionOptions()[1].id)

      expect(await press(modelId(), 'Enter')).toBe(true)

      expect(addFormValues()).toEqual(['claude-haiku-4-5', 'Claude Haiku 4.5 (latest)', '200000', '64000'])
      expect(document.activeElement).toBe(modelId())
      expect(addGatewayModel).not.toHaveBeenCalled()
    })

    it('leaves Enter to the form while no suggestion is active', async () => {
      stubModelsDev()
      await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await type(modelId(), 'claude')
      expect(suggested()).toHaveLength(3)

      expect(await press(modelId(), 'Enter')).toBe(false)

      expect(addFormValues()).toEqual(['claude', '', '', ''])
    })

    it('dismisses the suggestions on Escape and keeps what was typed', async () => {
      stubModelsDev()
      await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await type(modelId(), 'claude')
      expect(modelId().getAttribute('aria-expanded')).toBe('true')

      await press(modelId(), 'Escape')
      expect(modelId().getAttribute('aria-expanded')).toBe('false')
      expect(modelId().value).toBe('claude')

      await press(modelId(), 'Escape')
      expect(modelId().value).toBe('claude')
    })

    it('suggests the other provider’s models once the provider changes, and clears a suggested model', async () => {
      stubModelsDev()
      await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await type(modelId(), 'opus')
      await click(suggestionOptions()[0])
      await type(labeledInput('Display name'), 'Claude Opus 4.5')

      await chooseProvider('OpenAI')

      // The model was Anthropic's, so none of it is carried over to OpenAI.
      expect(addFormValues()).toEqual(['', '', '', ''])
      await type(modelId(), 'p')
      expect(suggested()).toEqual(['gpt-5.2GPT-5.2'])
    })

    it('clears a picked suggestion on a provider change after the setting is turned off', async () => {
      stubModelsDev()
      const { show } = await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await type(modelId(), 'opus')
      await click(suggestionOptions()[0])
      await show(GATEWAY_MODELS)

      await chooseProvider('OpenAI')

      expect(addFormValues()).toEqual(['', '', '', ''])
    })

    it('keeps a suggested ID that was typed by hand when the provider changes', async () => {
      stubModelsDev()
      await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await fillAddForm({ id: 'claude-opus-4-5', name: 'My Opus', contextWindow: '150000' })

      await chooseProvider('OpenAI')

      expect(addFormValues()).toEqual(['claude-opus-4-5', 'My Opus', '150000', ''])
    })

    it('keeps a model typed by hand when the provider changes', async () => {
      stubModelsDev()
      const { addGatewayModel } = await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await fillAddForm({ id: 'claude-next', name: 'Claude Next', contextWindow: '200000', outputLimit: '4096' })

      await chooseProvider('OpenAI')

      expect(addFormValues()).toEqual(['claude-next', 'Claude Next', '200000', '4096'])
      await click(button('Add model'))
      expect(addGatewayModel).toHaveBeenCalledExactlyOnceWith({
        provider: 'openai', id: 'claude-next', name: 'Claude Next', contextWindow: 200000, outputLimit: 4096,
      })
    })

    it('stops suggesting a model once the deployment has it', async () => {
      stubModelsDev()
      const { show } = await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await type(modelId(), 'opus')
      expect(suggested()).toEqual(['claude-opus-4-5Claude Opus 4.5 (latest)'])

      await show({
        ...SUGGESTING,
        models: [...SUGGESTING.models, { ...ADDED, provider: 'anthropic', id: 'claude-opus-4-5' }],
      })

      expect(suggested()).toEqual([])
    })

    it('drops the suggestions when the setting is turned off', async () => {
      stubModelsDev()
      const { show } = await render({ gatewayModels: SUGGESTING })
      await focus(modelId())
      await type(modelId(), 'opus')
      expect(suggested()).toHaveLength(1)

      await show(GATEWAY_MODELS)
      await focus(modelId())
      await type(modelId(), 'opu')

      expect(modelId().getAttribute('role')).toBeNull()
      expect(suggested()).toEqual([])
    })

    it.each([
      ['the request fails', async () => { throw new TypeError('Failed to fetch') }],
      ['models.dev answers with an error', async () => new Response('{}', { status: 503 })],
      ['the answer is not JSON', async () => new Response('<!doctype html><title>models.dev</title>')],
      ['the answer is not the list', async () => new Response(JSON.stringify({ models: [MODELS_DEV] }))],
    ] satisfies [string, typeof fetch][])('says so once when %s, and still adds a model typed by hand', async (_case, respond) => {
      stubModelsDev(respond)
      const { addGatewayModel } = await render({ gatewayModels: SUGGESTING })

      await focus(modelId())

      expect(suggestionNote()).toEqual([
        'Suggestions from models.dev couldn’t be loaded. Enter the model’s details by hand.',
      ])
      await fillAddForm({ id: 'claude-opus-4-5', name: 'Claude Opus 4.5', contextWindow: '200000' })
      expect(suggested()).toEqual([])
      await click(button('Add model'))

      expect(addGatewayModel).toHaveBeenCalledExactlyOnceWith({
        provider: 'anthropic', id: 'claude-opus-4-5', name: 'Claude Opus 4.5', contextWindow: 200000,
      })
    })

    it.each([
      ['with models to suggest', MODELS_DEV],
      ['with only models the deployment has', {
        anthropic: { models: { 'claude-sonnet': MODELS_DEV.anthropic.models['claude-sonnet'] } },
      }],
    ])('has no note for a list %s', async (_case, list) => {
      stubModelsDev(async () => new Response(JSON.stringify(list)))
      await render({ gatewayModels: SUGGESTING })

      await focus(modelId())

      expect(suggestionNote()).toEqual([])
    })

    it('points at an empty Model ID and says its error, as the plain field does', async () => {
      stubModelsDev()
      const { addGatewayModel } = await render({ gatewayModels: SUGGESTING })
      await fillAddForm({ id: '  ', name: 'Claude Next', contextWindow: '200000' })
      await focus(labeledInput('Display name'))

      await click(button('Add model'))

      expect(addGatewayModel).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(modelId())
      expect(modelId().getAttribute('aria-invalid')).toBe('true')
      const described = modelId().getAttribute('aria-describedby')!.split(' ')
        .map((id) => document.getElementById(id)?.textContent).join(' ')
      expect(described).toBe('Enter the model ID')

      // Focus can't announce an error on the field it is already in.
      await click(button('Add model'))
      expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('Enter the model ID')

      await type(modelId(), 'claude-next')
      expect(modelId().getAttribute('aria-invalid')).toBe('false')
      expect(document.body.querySelector('[role="alert"]')).toBeNull()
    })

    it('locks the field while a write is in flight', async () => {
      stubModelsDev()
      const { addGatewayModel } = await render({ gatewayModels: SUGGESTING })
      const call = deferred()
      addGatewayModel.mockReturnValueOnce(call.promise)
      await fillAddForm({ id: 'claude-next', name: 'Claude Next', contextWindow: '200000' })

      await click(button('Add model'))
      expect(modelId().disabled).toBe(true)

      await act(async () => call.resolve())
      expect(modelId().disabled).toBe(false)
      expect(addFormValues()).toEqual(['', '', '', ''])
    })
  })

  it('renders with no models at all', async () => {
    await render({ gatewayModels: { ...GATEWAY_MODELS, providers: ['anthropic'], models: [] } })

    expect(document.body.querySelectorAll('[role="radio"]')).toHaveLength(0)
    expect(document.body.textContent).toContain('No models added.')
    expect(button('Add model').disabled).toBe(false)
  })
})
