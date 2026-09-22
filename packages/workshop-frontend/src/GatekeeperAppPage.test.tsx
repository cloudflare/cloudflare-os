// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'

const testState = vi.hoisted(() => ({
  authenticatedApi: {
    getGatekeeperApp: vi.fn(),
  },
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))
vi.mock('./errorReporting', () => ({ reportIssue: vi.fn() }))
vi.mock('./SandboxedGatekeeperApp', () => ({
  default: ({ frame }: { frame: GatekeeperUiFrame }) => (
    <div data-testid="gatekeeper-frame">{frame.iframeHtml}</div>
  ),
}))

import GatekeeperAppPage from './GatekeeperAppPage'

type FrameWithDisposer = GatekeeperUiFrame & { [Symbol.dispose]?: () => void }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function frame(html: string, dispose?: () => void): FrameWithDisposer {
  const value = { iframeHtml: html, ui: { [Symbol.dispose]: vi.fn() } } as FrameWithDisposer
  if (dispose) value[Symbol.dispose] = dispose
  return value
}

describe('GatekeeperAppPage frame lifecycle', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    testState.authenticatedApi.getGatekeeperApp.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('clears stale content and ignores late results and errors after appId changes', async () => {
    const first = deferred<FrameWithDisposer>()
    const second = deferred<FrameWithDisposer>()
    testState.authenticatedApi.getGatekeeperApp
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    await act(async () => root.render(<GatekeeperAppPage appId="first" />))
    expect(container.textContent).toContain('Loading')
    await act(async () => root.render(<GatekeeperAppPage appId="second" />))
    expect(container.textContent).toContain('Loading')
    expect(container.querySelector('[data-testid="gatekeeper-frame"]')).toBeNull()

    await act(async () => first.reject(new Error('stale error')))
    expect(container.textContent).not.toContain('stale error')

    await act(async () => second.resolve(frame('current')))
    expect(container.textContent).toContain('current')
  })

  it('disposes a pending RPC request and releases a late native-Promise frame', async () => {
    const first = deferred<FrameWithDisposer>()
    const disposeRequest = vi.fn()
    Object.assign(first.promise, { [Symbol.dispose]: disposeRequest })
    const second = deferred<FrameWithDisposer>()
    testState.authenticatedApi.getGatekeeperApp
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    await act(async () => root.render(<GatekeeperAppPage appId="first" />))
    await act(async () => root.render(<GatekeeperAppPage appId="second" />))
    expect(disposeRequest).toHaveBeenCalledOnce()

    const lateDispose = vi.fn()
    await act(async () => first.resolve(frame('late', lateDispose)))
    expect(lateDispose).not.toHaveBeenCalled()
  })

  it('disposes a late frame from a native Promise when no request disposer exists', async () => {
    const first = deferred<FrameWithDisposer>()
    const second = deferred<FrameWithDisposer>()
    testState.authenticatedApi.getGatekeeperApp
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    await act(async () => root.render(<GatekeeperAppPage appId="first" />))
    await act(async () => root.render(<GatekeeperAppPage appId="second" />))
    const lateDispose = vi.fn()
    await act(async () => first.resolve(frame('late', lateDispose)))
    expect(lateDispose).toHaveBeenCalledOnce()
  })

  it('disposes the accepted outer frame once, with ui fallback only when needed', async () => {
    const pending = deferred<FrameWithDisposer>()
    testState.authenticatedApi.getGatekeeperApp.mockReturnValue(pending.promise)
    const outerDispose = vi.fn()
    const current = frame('current', outerDispose)

    await act(async () => root.render(<GatekeeperAppPage appId="current" />))
    await act(async () => pending.resolve(current))
    const uiDispose = (current.ui as unknown as { [Symbol.dispose]: ReturnType<typeof vi.fn> })[Symbol.dispose]
    await act(async () => root.unmount())
    expect(outerDispose).toHaveBeenCalledOnce()
    expect(uiDispose).not.toHaveBeenCalled()
    root = createRoot(container)
  })
})
