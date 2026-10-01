// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminModel, AdminSettingsView } from '@gadgets/workshop-shared/api'

const { addToast } = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; description?: string; variant: string }) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))

import { AdminModelsPanel } from './AdminModelsPanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type GatewayModels = NonNullable<AdminSettingsView['gatewayModels']>

const SONNET: AdminModel = {
  provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', contextWindow: 200000,
  mode: 'enabled', defaultMode: 'enabled', added: false,
}
// A catalog model the admin took off its default.
const LEGACY: AdminModel = {
  provider: 'anthropic', id: 'claude-legacy', name: 'Claude Legacy', contextWindow: 100000,
  mode: 'disabled', defaultMode: 'hidden', added: false,
}
const ADDED: AdminModel = {
  provider: 'openai', id: 'gpt-custom', name: 'GPT Custom', contextWindow: 128000, outputLimit: 4096,
  mode: 'enabled', defaultMode: 'enabled', added: true,
}
const GATEWAY_MODELS: GatewayModels = {
  providers: ['anthropic', 'openai'],
  models: [SONNET, LEGACY, ADDED],
  userModelsEnabled: true,
  modelsDevSuggestions: false,
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

const userModelsSwitch = () => {
  const element = button('Users may add their own models')
  if (element.getAttribute('role') !== 'switch') throw new Error('Not a switch')
  return element
}

// The checkbox the switch forwards its clicks to. jsdom has no PointerEvent, which the switch
// forwards them with.
const userModelsCheckbox = () => {
  const input = userModelsSwitch().nextElementSibling
  if (!(input instanceof HTMLInputElement)) throw new Error('No checkbox behind the switch')
  return input
}

const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
})

const click = (element: HTMLElement) => act(async () => { element.click() })

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
  })

  const render = async (
    { gatewayModels }: Pick<AdminSettingsView, 'gatewayModels'> = { gatewayModels: GATEWAY_MODELS },
  ) => {
    const setGatewayModelMode = vi.fn<AdminApi['setGatewayModelMode']>(async () => {})
    const addGatewayModel = vi.fn<AdminApi['addGatewayModel']>(async () => {})
    const removeGatewayModel = vi.fn<AdminApi['removeGatewayModel']>(async () => {})
    const setUserModelsEnabled = vi.fn<AdminApi['setUserModelsEnabled']>(async () => {})
    const onChanged = vi.fn<() => Promise<void>>(async () => {})
    const admin = {
      setGatewayModelMode, addGatewayModel, removeGatewayModel, setUserModelsEnabled,
    } as unknown as RpcStub<AdminApi>
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <AdminModelsPanel admin={admin} gatewayModels={gatewayModels} onChanged={onChanged} />))
    return { setGatewayModelMode, addGatewayModel, removeGatewayModel, setUserModelsEnabled, onChanged }
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

  it('renders with no models at all', async () => {
    await render({ gatewayModels: { ...GATEWAY_MODELS, providers: ['anthropic'], models: [] } })

    expect(document.body.querySelectorAll('[role="radio"]')).toHaveLength(0)
    expect(document.body.textContent).toContain('No models added.')
    expect(button('Add model').disabled).toBe(false)
  })
})
