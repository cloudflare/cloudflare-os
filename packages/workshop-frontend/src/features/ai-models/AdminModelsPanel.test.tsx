// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminModelView, AdminSettingsView } from '@gadgets/workshop-shared/api'

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

// What the server reports of a model's settings, which this panel does not show.
const NO_SETTINGS = { reasoningLevels: [], runtimeKnown: false }

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
  models: [SONNET, LEGACY, ADDED],
  defaultReasoning: null,
  userModelsEnabled: true,
  modelsDevSuggestions: false,
}

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

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
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

// By keyboard. The option turns Enter into a click it builds as a PointerEvent, which jsdom lacks,
// so the window has a stand-in for as long as the choice takes.
const chooseProvider = async (label: string) => {
  await click(button('Provider'))
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
    .find((element) => element.textContent === label)
  if (!option) throw new Error(`No provider ${label}`)
  const view: { PointerEvent?: typeof MouseEvent } = window
  view.PointerEvent = MouseEvent
  try {
    await focus(option)
    await press(option, 'Enter')
  } finally {
    delete view.PointerEvent
  }
}

// The options of the list the Model ID field says it controls.
const suggestionOptions = () => {
  const list = document.getElementById(labeledInput('Model ID').getAttribute('aria-controls') ?? '')
  return Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
}

const suggested = () => suggestionOptions().map((option) => option.textContent)

const suggestionNote = () =>
  Array.from(document.body.querySelectorAll('[role="status"]')).map((note) => note.textContent)

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
  })

  const render = async (
    { gatewayModels }: Pick<AdminSettingsView, 'gatewayModels'> = { gatewayModels: GATEWAY_MODELS },
  ) => {
    const setGatewayModelMode = vi.fn<AdminApi['setGatewayModelMode']>(async () => {})
    const addGatewayModel = vi.fn<AdminApi['addGatewayModel']>(async () => {})
    const removeGatewayModel = vi.fn<AdminApi['removeGatewayModel']>(async () => {})
    const setUserModelsEnabled = vi.fn<AdminApi['setUserModelsEnabled']>(async () => {})
    const setModelsDevSuggestions = vi.fn<AdminApi['setModelsDevSuggestions']>(async () => {})
    const onChanged = vi.fn<() => Promise<void>>(async () => {})
    const admin = {
      setGatewayModelMode, addGatewayModel, removeGatewayModel, setUserModelsEnabled,
      setModelsDevSuggestions,
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
      setModelsDevSuggestions, onChanged, show,
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

    it('reports a refused change with the server’s message and keeps showing the server’s mode', async () => {
      const { setGatewayModelMode, onChanged } = await render()
      setGatewayModelMode.mockRejectedValueOnce(new Error('No such model: claude-sonnet'))

      await click(modeOption('Claude Sonnet', 'Disabled'))

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

    it('offers no form when the gateway enables no provider a model can be added under', async () => {
      await render({ gatewayModels: { ...GATEWAY_MODELS, providers: [], models: [SONNET] } })

      expect(document.body.querySelector('form')).toBeNull()
      expect(document.body.textContent).toContain('No model can be added')
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
        contextWindow: 200000, outputLimit: 32000,
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
        contextWindow: 200000, outputLimit: 64000,
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
