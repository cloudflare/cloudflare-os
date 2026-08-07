// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AiModelConfig, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { AiModelProvider } from '@gadgets/workshop-shared/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Lets tests drive what the mocked SeatSignInButtons hands back to onEnrolled without going
// through the real OAuth walkthrough — that flow is covered by SeatSignInButtons.test.tsx.
// Declared with vi.hoisted so the vi.mock factory below (which is hoisted above imports) can see it.
const seatSignIn = vi.hoisted(() => ({
  provider: 'anthropic' as AiModelProvider,
  handle: 'seat-handle-super-secret',
  models: ['claude-opus-5', 'claude-sonnet-5'] as string[],
  apiUrl: 'https://seat-proxy.example/anthropic',
}))

const toastAdd = vi.fn<(toast: { title: string, variant?: string }) => void>()

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Close: ({ render }: { render: (props: object) => ReactElement }) =>
        render({ 'aria-label': 'Close' }),
    },
  )
  // Select/Option are mocked interactive enough to pick an option (via a data-option-value marker
  // and click delegation) so tests can drive the modal into the "custom model" state, where the
  // Model ID / Display Name / API Token fields render.
  const Select = Object.assign(
    (
      { children, label, disabled, description, onValueChange }: {
        children: ReactNode, label?: ReactNode, disabled?: boolean, description?: ReactNode,
        onValueChange?: (value: unknown) => void,
      },
    ) => (
      <div
        data-select
        aria-disabled={disabled ? 'true' : undefined}
        onClick={(e) => {
          if (disabled) return
          const target = (e.target as HTMLElement).closest('[data-option-value]') as HTMLElement | null
          if (target) onValueChange?.(target.dataset.optionValue)
        }}
      >
        {label}
        {description && <span>{description}</span>}
        {children}
      </div>
    ),
    {
      Option: ({ children, value }: { children: ReactNode, value: unknown }) => (
        <div data-option-value={String(value)}>{children}</div>
      ),
    },
  )
  const Collapsible = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      DefaultTrigger: ({ children, className }: { children: ReactNode, className?: string }) => (
        <div className={className}>{children}</div>
      ),
      DefaultPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    },
  )
  return {
    Dialog,
    Select,
    Collapsible,
    Button: (
      { children, onClick, loading, disabled }:
        { children: ReactNode, onClick?: () => void, loading?: boolean, disabled?: boolean },
    ) => (
      <button type="button" onClick={onClick} disabled={disabled} data-loading={loading ? 'true' : undefined}>
        {children}
      </button>
    ),
    Input: (
      { label, value, onChange, disabled }: {
        label: string, value: string, onChange: (e: { target: { value: string } }) => void, disabled?: boolean,
      },
    ) => (
      <label>
        {label}
        <input aria-label={label} value={value} onChange={onChange} disabled={disabled} />
      </label>
    ),
    SensitiveInput: (
      { label, value, onValueChange, disabled }: {
        label: string, value: string, onValueChange: (v: string) => void, disabled?: boolean,
      },
    ) => (
      <label>
        {label}
        <input aria-label={label} value={value} onChange={(e) => onValueChange(e.target.value)} disabled={disabled} />
      </label>
    ),
    useKumoToastManager: () => ({ add: toastAdd }),
  }
})

// The two extra buttons let tests drive onActiveChange directly, standing in for a real sign-in
// walkthrough leaving/returning to its idle step -- that transition logic is already covered by
// SeatSignInButtons.test.tsx, so here we only need to simulate it.
vi.mock('./SeatSignInButtons', () => ({
  default: (
    { onEnrolled, onActiveChange, disabled }: {
      onEnrolled: (provider: AiModelProvider, handle: string, models: string[], apiUrl: string) => void,
      onActiveChange?: (active: boolean) => void,
      disabled?: boolean,
    },
  ) => (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onEnrolled(seatSignIn.provider, seatSignIn.handle, seatSignIn.models, seatSignIn.apiUrl)}
      >
        Sign in with Claude subscription
      </button>
      <button type="button" onClick={() => onActiveChange?.(true)}>Simulate sign-in start</button>
      <button type="button" onClick={() => onActiveChange?.(false)}>Simulate sign-in reset</button>
    </div>
  ),
}))

import AddModelModal from './AddModelModal'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function fakeApi(addModel: RpcStub<AuthenticatedApi>['addModel']): RpcStub<AuthenticatedApi> {
  return { addModel } as unknown as RpcStub<AuthenticatedApi>
}

function click(element: Element) {
  return act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function button(rendered: HTMLElement, label: string): HTMLButtonElement {
  const found = [...rendered.querySelectorAll('button')].find(candidate =>
    candidate.textContent?.trim() === label)
  if (!found) throw new Error(`No button labelled "${label}"`)
  return found
}

function selectOption(rendered: HTMLElement, label: string) {
  const found = [...rendered.querySelectorAll('[data-option-value]')].find(candidate =>
    candidate.textContent?.trim() === label)
  if (!found) throw new Error(`No option labelled "${label}"`)
  return click(found)
}

function input(rendered: HTMLElement, label: string): HTMLInputElement {
  const found = [...rendered.querySelectorAll('input')].find(candidate =>
    candidate.getAttribute('aria-label') === label)
  if (!found) throw new Error(`No input labelled "${label}"`)
  return found
}

// React tracks controlled-input values through the native setter, so a plain `el.value = ...`
// gets silently reverted -- go through the prototype setter directly, as SeatSignInButtons.test.tsx
// does for the same reason.
async function typeInto(el: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('AddModelModal seat enrollment', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    toastAdd.mockClear()
    seatSignIn.models = ['claude-opus-5', 'claude-sonnet-5']
  })

  async function render(addModel: RpcStub<AuthenticatedApi>['addModel'], onSuccess = vi.fn()) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const api = fakeApi(addModel)
    await act(async () => {
      root!.render(
        <AddModelModal
          visible
          onCancel={vi.fn()}
          onSuccess={onSuccess}
          authenticatedApi={api}
          aiConfig={{ enabled: false }}
        />,
      )
    })
    return { rendered: container, onSuccess }
  }

  it('adds every model the seat returned and closes the dialog', async () => {
    const calls: [AiChatAuthorInfo, AiModelConfig][] = []
    const addModel = vi.fn(async (profile: AiChatAuthorInfo, config: AiModelConfig) => {
      calls.push([profile, config])
    })
    const { rendered, onSuccess } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    await click(button(rendered, 'Sign in with Claude subscription'))

    expect(addModel).toHaveBeenCalledTimes(2)
    expect(calls[0]).toEqual([
      { type: 'agent', id: 'claude-opus-5', name: 'Claude Opus 5' },
      { provider: 'anthropic', model: 'claude-opus-5', apiToken: 'seat-handle-super-secret', apiUrl: 'https://seat-proxy.example/anthropic' },
    ])
    expect(calls[1]).toEqual([
      { type: 'agent', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { provider: 'anthropic', model: 'claude-sonnet-5', apiToken: 'seat-handle-super-secret', apiUrl: 'https://seat-proxy.example/anthropic' },
    ])

    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: '2 AI models added successfully', variant: 'success' }),
    )
    expect(onSuccess).toHaveBeenCalledTimes(1)

    // The handle is a bearer credential and must never reach the DOM.
    expect(rendered.textContent).not.toContain('seat-handle-super-secret')
    expect(rendered.innerHTML).not.toContain('seat-handle-super-secret')
  })

  it('falls back to the raw model id when there is no SUGGESTED_MODELS entry', async () => {
    seatSignIn.models = ['claude-fable-5']
    const addModel = vi.fn(async () => {})
    const { rendered } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    await click(button(rendered, 'Sign in with Claude subscription'))

    expect(addModel).toHaveBeenCalledWith(
      { type: 'agent', id: 'claude-fable-5', name: 'claude-fable-5' },
      { provider: 'anthropic', model: 'claude-fable-5', apiToken: 'seat-handle-super-secret', apiUrl: 'https://seat-proxy.example/anthropic' },
    )
  })

  it('reports a partial failure instead of a false success, but still closes since some models were added', async () => {
    seatSignIn.models = ['claude-opus-5', 'claude-sonnet-5']
    const addModel = vi.fn(async (_profile: AiChatAuthorInfo, config: AiModelConfig) => {
      if (config.model === 'claude-sonnet-5') throw new Error('upstream rejected')
    })
    const { rendered, onSuccess } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    await click(button(rendered, 'Sign in with Claude subscription'))

    expect(addModel).toHaveBeenCalledTimes(2)
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Added 1 of 2 models from your subscription — some failed.',
        variant: 'error',
      }),
    )
    // Never claims outright success on a partial failure.
    expect(toastAdd).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'success' }),
    )
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('reports total failure and does not close the dialog', async () => {
    const addModel = vi.fn(async () => { throw new Error('upstream rejected') })
    const { rendered, onSuccess } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    await click(button(rendered, 'Sign in with Claude subscription'))

    expect(addModel).toHaveBeenCalledTimes(2)
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to add models from subscription sign-in', variant: 'error' }),
    )
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('shows an error and adds nothing when the seat has no models', async () => {
    seatSignIn.models = []
    const addModel = vi.fn(async () => {})
    const { rendered, onSuccess } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    await click(button(rendered, 'Sign in with Claude subscription'))

    expect(addModel).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Signed in, but no models were found for this subscription. Add one manually below.',
        variant: 'error',
      }),
    )
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('shows a busy state while adding and guards against double-submission', async () => {
    const first = deferred<void>()
    const addModel = vi.fn(() => first.promise)
    const { rendered } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    await click(button(rendered, 'Sign in with Claude subscription'))

    // Busy state: the sign-in button is replaced by a spinner, so a second click can't re-enter
    // the flow while models are still being added (models are added one at a time).
    expect(rendered.textContent).toContain('Adding your models')
    expect(() => button(rendered, 'Sign in with Claude subscription')).toThrow()
    expect(addModel).toHaveBeenCalledTimes(1)

    // Let the pending calls resolve so afterEach can unmount cleanly.
    await act(async () => { first.resolve() })
  })

  it('disables the manual controls once a sign-in becomes active, and re-enables them if it fails and resets', async () => {
    const addModel = vi.fn(async () => {})
    const { rendered } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    // Pick the custom-model option so the Model ID / Display Name / API Token fields are all on
    // screen, alongside the Select and the Advanced Settings trigger.
    await selectOption(rendered, 'Other Anthropic...')

    const select = rendered.querySelector('[data-select]')!
    expect(select.getAttribute('aria-disabled')).toBeNull()
    expect(input(rendered, 'Model ID').disabled).toBe(false)
    expect(input(rendered, 'Display Name').disabled).toBe(false)
    expect(input(rendered, 'API Token').disabled).toBe(false)
    expect(button(rendered, 'Cancel').disabled).toBe(false)
    expect(rendered.textContent).not.toContain('Manual setup is unavailable')

    await click(button(rendered, 'Simulate sign-in start'))

    expect(select.getAttribute('aria-disabled')).toBe('true')
    expect(input(rendered, 'Model ID').disabled).toBe(true)
    expect(input(rendered, 'Display Name').disabled).toBe(true)
    expect(input(rendered, 'API Token').disabled).toBe(true)
    expect(rendered.textContent).toContain('Manual setup is unavailable')
    // Cancel must stay usable throughout -- a user abandoning a sign-in still has to be able to
    // close the dialog.
    expect(button(rendered, 'Cancel').disabled).toBe(false)

    // A failed sign-in resets SeatSignInButtons back to idle, which reports inactive again.
    await click(button(rendered, 'Simulate sign-in reset'))

    expect(select.getAttribute('aria-disabled')).toBeNull()
    expect(input(rendered, 'Model ID').disabled).toBe(false)
    expect(input(rendered, 'Display Name').disabled).toBe(false)
    expect(input(rendered, 'API Token').disabled).toBe(false)
    expect(button(rendered, 'Cancel').disabled).toBe(false)
    expect(rendered.textContent).not.toContain('Manual setup is unavailable')
    expect(addModel).not.toHaveBeenCalled()
  })

  it('disables Add Model once a sign-in becomes active even with a stale manual selection, and re-enables it on reset', async () => {
    const addModel = vi.fn(async () => {})
    const { rendered } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    // A selection made before the sign-in starts is still enough to pass validate() once the
    // fields are frozen -- submit must not stay armed on a stale selection the user can no longer
    // change.
    await selectOption(rendered, 'Other Anthropic...')
    await typeInto(input(rendered, 'Model ID'), 'my-model')
    await typeInto(input(rendered, 'Display Name'), 'My Model')
    await typeInto(input(rendered, 'API Token'), 'sk-ant-test')

    expect(button(rendered, 'Add Model').disabled).toBe(false)

    await click(button(rendered, 'Simulate sign-in start'))
    expect(button(rendered, 'Add Model').disabled).toBe(true)

    await click(button(rendered, 'Simulate sign-in reset'))
    expect(button(rendered, 'Add Model').disabled).toBe(false)

    expect(addModel).not.toHaveBeenCalled()
  })

  it('disables the seat sign-in buttons while a manual submission is in flight', async () => {
    const first = deferred<void>()
    const addModel = vi.fn(() => first.promise)
    const { rendered } = await render(addModel as unknown as RpcStub<AuthenticatedApi>['addModel'])

    await selectOption(rendered, 'Other Anthropic...')
    await typeInto(input(rendered, 'Model ID'), 'my-model')
    await typeInto(input(rendered, 'Display Name'), 'My Model')
    await typeInto(input(rendered, 'API Token'), 'sk-ant-test')

    expect(button(rendered, 'Sign in with Claude subscription').disabled).toBe(false)

    await click(button(rendered, 'Add Model'))

    expect(button(rendered, 'Sign in with Claude subscription').disabled).toBe(true)

    await act(async () => { first.resolve() })
  })
})
