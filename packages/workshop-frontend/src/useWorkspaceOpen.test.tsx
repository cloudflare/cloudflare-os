// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
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
import { useWorkspaceOpen } from './useWorkspaceOpen'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  return <p>{state.metadata?.title}</p>
}

describe('useWorkspaceOpen', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.title = ''
    vi.restoreAllMocks()
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
