// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { SeatCompleteResult, SeatProvider, SeatStartResult } from '@gadgets/workshop-shared/seat-types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
  Button: (
    { children, onClick, loading, disabled }:
      { children: ReactNode, onClick?: () => void, loading?: boolean, disabled?: boolean },
  ) => (
    <button type="button" onClick={onClick} disabled={disabled} data-loading={loading ? 'true' : undefined}>
      {children}
    </button>
  ),
  Input: (
    { label, description, value, onChange, placeholder }: {
      label: string, description?: string, value: string,
      onChange: (e: { target: { value: string } }) => void, placeholder?: string,
    },
  ) => (
    <label>
      {label}
      <input aria-label={label} placeholder={placeholder} value={value} onChange={onChange} />
      {description && <span>{description}</span>}
    </label>
  ),
  Banner: ({ title }: { title: ReactNode }) => <div role="alert">{title}</div>,
}))

import SeatSignInButtons from './SeatSignInButtons'

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

async function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function fakeApi(overrides: {
  startSeatAuth?: (provider: SeatProvider) => Promise<SeatStartResult>
  completeSeatAuth?: (provider: SeatProvider, enrollId: string, code?: string) => Promise<SeatCompleteResult>
} = {}): RpcStub<AuthenticatedApi> {
  return {
    startSeatAuth: overrides.startSeatAuth ?? (async () => {
      throw new Error('startSeatAuth not stubbed')
    }),
    completeSeatAuth: overrides.completeSeatAuth ?? (async () => {
      throw new Error('completeSeatAuth not stubbed')
    }),
  } as unknown as RpcStub<AuthenticatedApi>
}

describe('SeatSignInButtons', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    vi.useRealTimers()
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  async function render(api: RpcStub<AuthenticatedApi>, onEnrolled = vi.fn()) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<SeatSignInButtons authenticatedApi={api} onEnrolled={onEnrolled} />)
    })
    return { rendered: container, onEnrolled }
  }

  it('renders both provider buttons', async () => {
    const { rendered } = await render(fakeApi())

    expect(rendered.textContent).toContain('Sign in with Claude subscription')
    expect(rendered.textContent).toContain('Sign in with ChatGPT subscription')
  })

  it('starts the Anthropic flow and shows the authorize URL plus a code input', async () => {
    const startSeatAuth = vi.fn<(provider: SeatProvider) => Promise<SeatStartResult>>(async () => ({
      enrollId: 'enroll-1',
      kind: 'authorize_url',
      url: 'https://console.anthropic.com/authorize?x=1',
    }))
    const { rendered } = await render(fakeApi({ startSeatAuth }))

    await click(button(rendered, 'Sign in with Claude subscription'))

    expect(startSeatAuth).toHaveBeenCalledWith('anthropic')
    const link = rendered.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://console.anthropic.com/authorize?x=1')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(rendered.querySelector('input')).not.toBeNull()
  })

  it('completes Anthropic enrollment from a pasted code and never renders the handle', async () => {
    const startSeatAuth = vi.fn<(provider: SeatProvider) => Promise<SeatStartResult>>(async () => ({
      enrollId: 'enroll-1',
      kind: 'authorize_url',
      url: 'https://console.anthropic.com/authorize?x=1',
    }))
    const completeSeatAuth = vi.fn<
      (provider: SeatProvider, enrollId: string, code?: string) => Promise<SeatCompleteResult>
    >(async () => ({
      status: 'complete',
      handle: 'seat-handle-super-secret',
      models: ['claude-opus'],
      apiUrl: 'https://seat-proxy.example/anthropic',
    }))
    const { rendered, onEnrolled } = await render(fakeApi({ startSeatAuth, completeSeatAuth }))

    await click(button(rendered, 'Sign in with Claude subscription'))
    await typeInto(rendered.querySelector('input')!, 'the-code#the-state')
    await click(button(rendered, 'Complete sign-in'))

    expect(completeSeatAuth).toHaveBeenCalledWith('anthropic', 'enroll-1', 'the-code#the-state')
    expect(onEnrolled).toHaveBeenCalledWith(
      'anthropic', 'seat-handle-super-secret', ['claude-opus'], 'https://seat-proxy.example/anthropic',
    )
    // The test that matters most: the handle must never appear in rendered text.
    expect(rendered.textContent).not.toContain('seat-handle-super-secret')
  })

  it('shows the label telling the user to paste the whole code including the "#" suffix', async () => {
    const startSeatAuth = vi.fn<(provider: SeatProvider) => Promise<SeatStartResult>>(async () => ({
      enrollId: 'enroll-1',
      kind: 'authorize_url',
      url: 'https://console.anthropic.com/authorize',
    }))
    const { rendered } = await render(fakeApi({ startSeatAuth }))

    await click(button(rendered, 'Sign in with Claude subscription'))

    expect(rendered.textContent).toMatch(/#/)
    expect(rendered.textContent?.toLowerCase()).toContain('everything after it')
  })

  it('shows an error on a rejected code and lets the user try again', async () => {
    const startSeatAuth = vi.fn<(provider: SeatProvider) => Promise<SeatStartResult>>(async () => ({
      enrollId: 'enroll-1',
      kind: 'authorize_url',
      url: 'https://console.anthropic.com/authorize',
    }))
    const completeSeatAuth = vi.fn<
      (provider: SeatProvider, enrollId: string, code?: string) => Promise<SeatCompleteResult>
    >()
      .mockRejectedValueOnce(new Error('invalid code'))
      .mockResolvedValueOnce({
        status: 'complete', handle: 'h', models: ['m'], apiUrl: 'https://x',
      })
    const { rendered, onEnrolled } = await render(fakeApi({ startSeatAuth, completeSeatAuth }))

    await click(button(rendered, 'Sign in with Claude subscription'))
    await typeInto(rendered.querySelector('input')!, 'bad-code')
    await click(button(rendered, 'Complete sign-in'))

    expect(rendered.querySelector('[role="alert"]')).not.toBeNull()
    expect(onEnrolled).not.toHaveBeenCalled()

    // The user can still retry: the input and submit button are still there.
    await typeInto(rendered.querySelector('input')!, 'good-code')
    await click(button(rendered, 'Complete sign-in'))

    expect(completeSeatAuth).toHaveBeenCalledTimes(2)
    expect(onEnrolled).toHaveBeenCalledWith('anthropic', 'h', ['m'], 'https://x')
  })

  it('starts the OpenAI device-code flow and shows the user code and verification URI', async () => {
    const startSeatAuth = vi.fn<(provider: SeatProvider) => Promise<SeatStartResult>>(async () => ({
      enrollId: 'enroll-2',
      kind: 'device_code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://platform.openai.com/activate',
      interval: 5,
    }))
    const completeSeatAuth = vi.fn<
      (provider: SeatProvider, enrollId: string, code?: string) => Promise<SeatCompleteResult>
    >(async () => ({ status: 'pending' }))
    const { rendered } = await render(fakeApi({ startSeatAuth, completeSeatAuth }))

    await click(button(rendered, 'Sign in with ChatGPT subscription'))

    expect(startSeatAuth).toHaveBeenCalledWith('openai')
    expect(rendered.textContent).toContain('ABCD-1234')
    expect(rendered.textContent).toContain('https://platform.openai.com/activate')
  })

  it('polls completeSeatAuth on the given interval until it stops returning pending', async () => {
    vi.useFakeTimers()
    const startSeatAuth = vi.fn<(provider: SeatProvider) => Promise<SeatStartResult>>(async () => ({
      enrollId: 'enroll-2',
      kind: 'device_code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://platform.openai.com/activate',
      interval: 5,
    }))
    const completeSeatAuth = vi.fn<
      (provider: SeatProvider, enrollId: string, code?: string) => Promise<SeatCompleteResult>
    >()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({
        status: 'complete', handle: 'seat-handle-super-secret', models: ['gpt-5'],
        apiUrl: 'https://seat-proxy.example/openai',
      })
    const { rendered, onEnrolled } = await render(fakeApi({ startSeatAuth, completeSeatAuth }))

    await click(button(rendered, 'Sign in with ChatGPT subscription'))
    expect(completeSeatAuth).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(completeSeatAuth).toHaveBeenCalledTimes(1)
    expect(completeSeatAuth).toHaveBeenCalledWith('openai', 'enroll-2')
    expect(onEnrolled).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(completeSeatAuth).toHaveBeenCalledTimes(2)
    expect(onEnrolled).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(completeSeatAuth).toHaveBeenCalledTimes(3)
    expect(onEnrolled).toHaveBeenCalledWith(
      'openai', 'seat-handle-super-secret', ['gpt-5'], 'https://seat-proxy.example/openai',
    )
    expect(rendered.textContent).not.toContain('seat-handle-super-secret')

    // Polling stopped: advancing further makes no additional calls.
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(completeSeatAuth).toHaveBeenCalledTimes(3)
  })

  it('stops polling once unmounted, so no RPC fires after the component is gone', async () => {
    vi.useFakeTimers()
    const startSeatAuth = vi.fn<(provider: SeatProvider) => Promise<SeatStartResult>>(async () => ({
      enrollId: 'enroll-2',
      kind: 'device_code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://platform.openai.com/activate',
      interval: 5,
    }))
    const completeSeatAuth = vi.fn<
      (provider: SeatProvider, enrollId: string, code?: string) => Promise<SeatCompleteResult>
    >(async () => ({ status: 'pending' }))
    const { rendered } = await render(fakeApi({ startSeatAuth, completeSeatAuth }))

    await click(button(rendered, 'Sign in with ChatGPT subscription'))
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(completeSeatAuth).toHaveBeenCalledTimes(1)

    await act(async () => root!.unmount())

    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(completeSeatAuth).toHaveBeenCalledTimes(1)
  })
})
