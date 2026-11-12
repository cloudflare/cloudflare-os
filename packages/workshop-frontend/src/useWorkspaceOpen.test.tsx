// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  AUTH_ERROR_CODES,
  createAuthError,
  createOpenWorkspaceError,
  OPEN_WORKSPACE_ERROR_CODES,
  type AuthenticatedApi,
  type WorkspaceMetadata,
  type ObserverAccountChoice,
  type ObserverBindingNeed,
  type ObserverConfigCallback,
  type Overseer,
} from '@gadgets/workshop-shared/api'
import WorkspaceOpenErrorPage from './components/WorkspaceOpenErrorPage'
import { reportIssue } from './errorReporting'
import { useWorkspaceOpen } from './useWorkspaceOpen'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./errorReporting', async importOriginal => ({
  ...await importOriginal<typeof import('./errorReporting')>(),
  reportIssue: vi.fn<typeof reportIssue>(),
}))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function disposableStub<T extends object>(value: T, dispose = vi.fn<() => void>()) {
  return Object.assign(value, { [Symbol.dispose]: dispose }) as T & Disposable
}

function api(overseer: RpcStub<Overseer>): RpcStub<AuthenticatedApi> {
  return { openWorkspace: () => overseer } as unknown as RpcStub<AuthenticatedApi>
}

const openOverseer = () => disposableStub({
  subscribeToMetadata: vi.fn<
    (callback: (metadata: WorkspaceMetadata) => void) => Promise<RpcStub<{}>>
  >(async callback => {
      callback(METADATA)
      return disposableStub({}) as RpcStub<{}>
    }),
}) as unknown as RpcStub<Overseer>

const failingOverseer = (error: Error, dispose = vi.fn<() => void>()) => disposableStub({
  subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => { throw error }),
}, dispose) as unknown as RpcStub<Overseer>

const METADATA = {
  id: 'workspace-1',
  title: 'Quarterly planning',
  provisional: false,
} as WorkspaceMetadata

const need = (gatekeeperId: number): ObserverBindingNeed =>
  ({ gatekeeperId, vendorId: 'google', resourceTitle: `Doc ${gatekeeperId}` })

function WorkspaceProbe({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) {
  const state = useWorkspaceOpen({
    id: 'workspace-1',
    authenticatedApi,
    onInvalidShareKey: () => {},
    onMetadata: () => {},
    onShareKeyConsumed: () => {},
  })
  if (state.error?.kind === 'open') {
    return (
      <WorkspaceOpenErrorPage
        kind={state.error.failure}
        onGoToWorkspaces={() => {}}
        onRetry={state.retry}
      />
    )
  }
  if (state.error?.kind === 'message') return <p>{state.error.message}</p>
  return <p>{state.connectionLost ? 'Reconnecting' : state.metadata?.title}</p>
}

describe('useWorkspaceOpen', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.title = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('disposes a metadata subscription that resolves after its load attempt is cleaned up', async () => {
    const pendingSubscription = deferred<RpcStub<{}>>()
    const overseerDispose = vi.fn<() => void>()
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(() => pendingSubscription.promise),
    }, overseerDispose) as unknown as RpcStub<Overseer>
    const subscriptionDispose = vi.fn<() => void>()
    const subscription = disposableStub({}, subscriptionDispose) as RpcStub<{}>
    const authenticatedApi = api(overseer)

    function Probe() {
      useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
      })
      return null
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))

    act(() => root!.unmount())
    root = undefined
    await act(async () => { pendingSubscription.resolve(subscription); await Promise.resolve() })

    expect(overseerDispose).toHaveBeenCalledOnce()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
  })

  it('clears loaded metadata and title and disposes the failed stub after access is denied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    document.title = 'outside'
    const firstSubscriptionDispose = vi.fn<() => void>()
    const firstOverseer = disposableStub({
      subscribeToMetadata: vi.fn<
        (callback: (metadata: WorkspaceMetadata) => void) => Promise<RpcStub<{}>>
      >(async callback => {
          callback(METADATA)
          return disposableStub({}, firstSubscriptionDispose) as RpcStub<{}>
        }),
    }) as unknown as RpcStub<Overseer>
    const deniedOverseerDispose = vi.fn<() => void>()
    const deniedOverseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenWorkspaceError(OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied)
      }),
    }, deniedOverseerDispose) as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(firstOverseer)} />))
    expect(container.textContent).toContain('Quarterly planning')
    expect(document.title).toBe('Quarterly planning - Cloudflare OS')

    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(deniedOverseer)} />))
    expect(container.textContent).toContain("You don't have access to this workspace")
    expect(container.textContent).not.toContain('Quarterly planning')
    expect(document.title).toBe('Cloudflare OS')
    expect(firstSubscriptionDispose).toHaveBeenCalledOnce()
    expect(deniedOverseerDispose).toHaveBeenCalledOnce()
  })

  it('shows the share-links-disabled page when a new redeemer is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenWorkspaceError(OPEN_WORKSPACE_ERROR_CODES.shareLinksDisabled)
      }),
    }) as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(overseer)} />))

    expect(container.textContent).toContain('Share links are turned off for this workspace')
    expect(container.textContent)
      .toContain('Ask the workspace owner to add you directly, then try again.')
  })

  it('retries a reopen that fails on a live connection until it succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failedDispose = vi.fn<() => void>()
    const failed = failingOverseer(
      new Error('Durable Object reset because its code was updated.'), failedDispose)
    const openWorkspace = vi.fn<() => RpcStub<Overseer>>()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(failed)
      .mockReturnValue(openOverseer())
    const reconnected = { openWorkspace } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(openOverseer())} />))
    expect(container.textContent).toBe('Quarterly planning')

    vi.useFakeTimers()
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={reconnected} />))
    expect(container.textContent).toBe('Reconnecting')
    expect(openWorkspace).toHaveBeenCalledOnce()

    // Each wait is the longest its jittered backoff can be.
    await act(async () => vi.advanceTimersByTimeAsync(1_150))
    expect(container.textContent).toBe('Reconnecting')
    expect(openWorkspace).toHaveBeenCalledTimes(2)

    await act(async () => vi.advanceTimersByTimeAsync(2_300))
    expect(container.textContent).toBe('Quarterly planning')
    expect(failedDispose).toHaveBeenCalledTimes(2)

    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(openWorkspace).toHaveBeenCalledTimes(3)
    expect(reportIssue).not.toHaveBeenCalled()
  })

  // Reopens a workspace on a connection where every open fails with `error`, through the
  // longest jittered waits before the second, third and fourth attempts.
  async function failReopens(error: Error) {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(openOverseer())} />))

    vi.useFakeTimers()
    const failing = api(failingOverseer(error))
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={failing} />))
    for (const wait of [1_150, 2_300, 4_600]) {
      await act(async () => vi.advanceTimersByTimeAsync(wait))
    }
    expect(container!.textContent).toBe('Reconnecting')
  }

  it('reports a reopen once, when two retries have not cured it', async () => {
    await failReopens(new Error('Durable Object reset because its code was updated.'))
    expect(reportIssue).toHaveBeenCalledExactlyOnceWith(
      'gadget.reopen', expect.any(Error), { severity: 'warning', gadgetId: 'workspace-1' })
  })

  it.each([
    ['a dropped socket', new Error('Peer closed WebSocket')],
    ['an expired session', createAuthError(AUTH_ERROR_CODES.invalidSessionToken)],
  ])('does not report a reopen that fails with %s', async (_, error) => {
    await failReopens(error)
    expect(reportIssue).not.toHaveBeenCalled()
  })

  describe('account prompts for opening gadgets', () => {
    let observerConfig: { needs: ObserverBindingNeed[]; resolve: (choices: ObserverAccountChoice[]) => void } | null
    let createObserverConfigCallback: (signal: AbortSignal) => RpcStub<ObserverConfigCallback>

    async function renderHook() {
      const overseer = disposableStub({
        subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => disposableStub({}) as RpcStub<{}>),
      }) as unknown as RpcStub<Overseer>
      const authenticatedApi = api(overseer)
      function Probe() {
        const workspace = useWorkspaceOpen({
          id: 'workspace-1',
          authenticatedApi,
          onInvalidShareKey: () => {},
          onMetadata: () => {},
          onShareKeyConsumed: () => {},
        })
        observerConfig = workspace.observerConfig
        createObserverConfigCallback = workspace.createObserverConfigCallback
        return null
      }
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () => root!.render(<Probe />))
    }

    // Wrapped, since an async function returning the pending answer would wait for it.
    async function prompt(signal: AbortSignal, needs: ObserverBindingNeed[]) {
      const callback = createObserverConfigCallback(signal)
      let answer!: Promise<unknown>
      await act(async () => { answer = Promise.resolve(callback.configure(needs)) })
      answer.catch(() => {})
      return { answer }
    }

    it('answers a gadget prompt with the accounts the user chose', async () => {
      await renderHook()
      const { answer } = await prompt(new AbortController().signal, [need(1)])
      expect(observerConfig?.needs).toEqual([need(1)])

      await act(async () => observerConfig!.resolve([{ gatekeeperId: 1, accountId: 4 }]))

      await expect(answer).resolves.toEqual([{ gatekeeperId: 1, accountId: 4 }])
      expect(observerConfig).toBeNull()
    })

    it('lets a newer gadget prompt supersede an unanswered one, and fails a prompt whose gadget is left', async () => {
      await renderHook()
      const left = new AbortController()
      const first = await prompt(new AbortController().signal, [need(1)])
      const second = await prompt(left.signal, [need(2)])

      await expect(first.answer).rejects.toThrow('Cancelled')
      expect(observerConfig?.needs).toEqual([need(2)])

      await act(async () => left.abort())

      await expect(second.answer).rejects.toThrow('Cancelled')
      expect(observerConfig).toBeNull()
    })
  })
})
