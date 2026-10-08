// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, RedactedAiModelConfig } from '@gadgets/workshop-shared/api'

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

import AddModelModal, { type ModelModalMode } from './AddModelModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROFILE = { type: 'agent' as const, id: 'gemma', name: 'Gemma' }
const CONFIG: RedactedAiModelConfig = {
  provider: 'ollama',
  model: 'gemma',
  apiToken: null,
  apiUrl: 'https://ollama.example',
  extraHeaders: { 'X-Key': null },
}

const input = (selector: string) => {
  const element = document.body.querySelector<HTMLInputElement>(selector)
  if (!element) throw new Error(`No input matching ${selector}`)
  return element
}

const labeledInput = (label: string) => {
  const labelElement = Array.from(document.body.querySelectorAll('label'))
    .find(element => element.textContent?.startsWith(label))
  if (!labelElement) throw new Error(`No label ${label}`)
  const element = document.getElementById(labelElement.htmlFor)
  if (!(element instanceof HTMLInputElement)) throw new Error(`No input labeled ${label}`)
  return element
}

const button = (name: string) => {
  const element = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find(b => b.textContent === name || b.getAttribute('aria-label') === name)
  if (!element) throw new Error(`No button ${name}`)
  return element
}

const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
})

const click = (element: HTMLElement) => act(() => { element.click() })

// By keyboard. The option turns Enter into a click it builds as a PointerEvent, which jsdom lacks,
// so the window has a stand-in for as long as the choice takes.
const choose = async (label: string) => {
  await click(document.body.querySelector<HTMLElement>('[role="combobox"]')!)
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
    .find(element => element.textContent === label)
  if (!option) throw new Error(`No option ${label}`)
  const view: { PointerEvent?: typeof MouseEvent } = window
  view.PointerEvent = MouseEvent
  try {
    await act(async () => { option.focus() })
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  } finally {
    delete view.PointerEvent
  }
}

describe('AddModelModal', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  const render = async (mode: ModelModalMode, chatModelsOnly = false) => {
    const updateModel = vi.fn<AuthenticatedApi['updateModel']>(async () => {})
    const addModel = vi.fn<AuthenticatedApi['addModel']>(async () => {})
    const api = { updateModel, addModel } as unknown as RpcStub<AuthenticatedApi>
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<AddModelModal
      visible
      mode={mode}
      chatModelsOnly={chatModelsOnly}
      onCancel={() => {}}
      onSuccess={() => {}}
      authenticatedApi={api}
      aiConfig={{ enabled: false }}
    />))
    return { updateModel, addModel }
  }

  // Onboarding picks the user's chat model, which a classifier can't be; the Providers page adds both.
  it.each([false, true])('offers classifier models only without chatModelsOnly (chatModelsOnly: %s)', async (chatModelsOnly) => {
    await render({ type: 'add' }, chatModelsOnly)
    await click(document.body.querySelector<HTMLElement>('[role="combobox"]')!)

    const options = Array.from(document.body.querySelectorAll('[role="option"]'), option => option.textContent)
    expect(options).toContain('GLM 5.2 (Workers AI)')
    expect(options.includes('Clef (Workers AI)')).toBe(!chatModelsOnly)
  })

  it.each([false, true])('adds a classifier typed as a custom model only without chatModelsOnly (chatModelsOnly: %s)', async (chatModelsOnly) => {
    const { addModel } = await render({ type: 'add' }, chatModelsOnly)
    await choose('Other Cloudflare Workers AI...')
    await type(labeledInput('Model ID'), '@cf/cloudflare/clef')
    await type(labeledInput('Display Name'), 'Clef')
    await type(labeledInput('Cloudflare Account ID'), 'account-id')
    await type(labeledInput('API Token'), 'token')
    await click(button('Add Model'))

    expect(addModel).toHaveBeenCalledTimes(chatModelsOnly ? 0 : 1)
  })

  it('sends withheld secrets back as null when they are left untouched', async () => {
    const { updateModel } = await render({ type: 'edit', source: { profile: PROFILE, config: CONFIG } })
    expect(labeledInput('API Token').value).toBe('')
    expect(labeledInput('API Token').placeholder).toBe('********')

    await type(labeledInput('Display Name'), 'Gemma 4')
    await click(button('Save Changes'))

    expect(updateModel).toHaveBeenCalledWith(
      { ...PROFILE, name: 'Gemma 4' },
      { ...CONFIG, apiToken: null, extraHeaders: { 'X-Key': null } },
    )
  })

  it('sends a secret only once the user replaces it', async () => {
    const { updateModel } = await render({ type: 'edit', source: { profile: PROFILE, config: CONFIG } })

    const token = labeledInput('API Token')
    act(() => token.focus())
    await type(token, 'new-token')
    // The first keystroke must not swap in a different element, taking focus with it.
    expect(document.activeElement).toBe(labeledInput('API Token'))
    await click(button('Advanced Settings'))
    await type(input('input[aria-label="Header value"]'), 'new-key')
    await click(button('Save Changes'))

    expect(updateModel).toHaveBeenCalledWith(PROFILE, { ...CONFIG, apiToken: 'new-token', extraHeaders: { 'X-Key': 'new-key' } })
  })

  it('returns to keeping a stored value after starting to replace it', async () => {
    const { updateModel } = await render({ type: 'edit', source: { profile: PROFILE, config: CONFIG } })

    await type(labeledInput('API Token'), 'oops')
    await click(button('Keep stored value'))
    expect(labeledInput('API Token').placeholder).toBe('********')
    await click(button('Save Changes'))

    expect(updateModel).toHaveBeenCalledWith(PROFILE, CONFIG)
  })

  it('requires withheld header values to be re-entered once the API URL changes', async () => {
    const { updateModel } = await render({ type: 'edit', source: { profile: PROFILE, config: CONFIG } })

    await type(labeledInput('API URL'), 'https://elsewhere.example')
    expect(labeledInput('API Token').value).toBe('')
    await click(button('Save Changes'))
    expect(updateModel).not.toHaveBeenCalled()

    await type(input('input[aria-label="Header value"]'), 'key')
    await click(button('Save Changes'))
    expect(updateModel).toHaveBeenCalledWith(PROFILE, {
      ...CONFIG, apiUrl: 'https://elsewhere.example', apiToken: '', extraHeaders: { 'X-Key': 'key' },
    })
  })

  it('clones with the source as the origin of withheld secrets', async () => {
    const { addModel } = await render({ type: 'clone', source: { profile: PROFILE, config: CONFIG } })

    await type(labeledInput('Model ID'), 'qwen')
    await type(labeledInput('Display Name'), 'Qwen')
    await click(button('Add Model'))

    expect(addModel).toHaveBeenCalledWith(
      { type: 'agent', id: 'qwen', name: 'Qwen' },
      { ...CONFIG, model: 'qwen' },
      PROFILE.id,
    )
  })
})
