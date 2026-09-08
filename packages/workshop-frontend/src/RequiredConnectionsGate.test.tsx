// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect } from 'react'
import type React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectedAccountsSubscriber, RequiredConnectionStatus } from '@gadgets/workshop-shared/api'
import { RequiredConnectionsGate } from './RequiredConnectionsGate'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type FakeApi = {
  getRequiredConnectionStatuses: ReturnType<typeof vi.fn<() => Promise<RequiredConnectionStatus[]>>>
  connectAccount: ReturnType<typeof vi.fn<(vendorId: string) => Promise<{ url: string }>>>
  reconnectAccount: ReturnType<typeof vi.fn<(accountId: number) => Promise<{ url: string }>>>
  subscribeConnectedAccounts: ReturnType<typeof vi.fn<(subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>>>
}

function createApi(statuses: RequiredConnectionStatus[]): FakeApi & { subscriber?: ConnectedAccountsSubscriber; dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn<() => void>()
  const api: FakeApi & { subscriber?: ConnectedAccountsSubscriber; dispose: ReturnType<typeof vi.fn> } = {
    dispose,
    getRequiredConnectionStatuses: vi.fn<() => Promise<RequiredConnectionStatus[]>>(async () => statuses),
    connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(async () => ({ url: 'https://connect.example.test' })),
    reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(async () => ({ url: 'https://reconnect.example.test' })),
    subscribeConnectedAccounts: vi.fn<(subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>>(async (subscriber) => {
      api.subscriber = subscriber
      return { [Symbol.dispose]: dispose }
    }),
  }
  return api
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('RequiredConnectionsGate', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.restoreAllMocks()
  })

  async function renderGate(api: FakeApi, pathname = '/') {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RequiredConnectionsGate authenticatedApi={api as never} pathname={pathname}>
          <div>Unlocked app</div>
        </RequiredConnectionsGate>,
      )
    })
    return container
  }

  it('blocks gated routes until all required connections are healthy', async () => {
    const api = createApi([{ vendorId: 'github', displayName: 'GitHub', state: 'missing' }])

    const rendered = await renderGate(api, '/')

    expect(rendered.textContent).toContain('Connect required services to continue')
    expect(rendered.textContent).toContain('GitHub')
    expect(rendered.textContent).not.toContain('Unlocked app')
  })

  it('starts a missing connection and shows a popup-blocked fallback', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const api = createApi([{ vendorId: 'github', displayName: 'GitHub', state: 'missing' }])
    const rendered = await renderGate(api, '/workspace/abc')
    const button = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Connect GitHub'))

    await act(async () => button!.click())

    expect(api.connectAccount).toHaveBeenCalledWith('github')
    expect(api.reconnectAccount).not.toHaveBeenCalled()
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(rendered.textContent).toContain('Your browser blocked the popup')
    expect(rendered.querySelector('a[href="https://connect.example.test"]')).toBeTruthy()
  })

  it('starts an expired connection reconnect by account id', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const api = createApi([{ vendorId: 'github', displayName: 'GitHub', state: 'expired', accountId: 42 }])
    const rendered = await renderGate(api, '/sessions')
    const button = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect GitHub'))

    await act(async () => button!.click())

    expect(api.reconnectAccount).toHaveBeenCalledWith(42)
    expect(api.connectAccount).not.toHaveBeenCalled()
    expect(rendered.querySelector('a[href="https://reconnect.example.test"]')).toBeTruthy()
  })

  it('leaves admin and other recovery routes available even when a required vendor is unavailable', async () => {
    const api = createApi([{ vendorId: 'required', displayName: 'Required App', state: 'unavailable', message: 'Disabled by admin.' }])

    const admin = await renderGate(api, '/admin')

    expect(admin.textContent).toContain('Unlocked app')
    expect(admin.textContent).not.toContain('Connect required services')
    expect(api.getRequiredConnectionStatuses).not.toHaveBeenCalled()
    expect(api.subscribeConnectedAccounts).not.toHaveBeenCalled()
  })

  it('fails closed on gated routes when required status cannot be checked', async () => {
    const api = createApi([])
    api.getRequiredConnectionStatuses.mockRejectedValueOnce(new Error('offline'))

    const rendered = await renderGate(api, '/')

    expect(rendered.textContent).toContain('We could not check required connections')
    expect(rendered.textContent).not.toContain('Unlocked app')
  })

  it('locks a previously healthy route when a live recheck fails', async () => {
    const api = createApi([{ vendorId: 'jira', displayName: 'Jira', state: 'healthy' }])
    const rendered = await renderGate(api, '/')
    expect(rendered.textContent).toContain('Unlocked app')
    api.getRequiredConnectionStatuses.mockRejectedValueOnce(new Error('offline'))

    await act(async () => api.subscriber!.ready())

    expect(rendered.textContent).toContain('We could not check required connections')
    expect(rendered.textContent).not.toContain('Unlocked app')
  })

  it('ignores an older health response that finishes after a newer recheck', async () => {
    const api = createApi([{ vendorId: 'jira', displayName: 'Jira', state: 'missing' }])
    const rendered = await renderGate(api, '/')
    const slow = deferred<RequiredConnectionStatus[]>()
    api.getRequiredConnectionStatuses
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce([{ vendorId: 'jira', displayName: 'Jira', state: 'healthy' }])

    await act(async () => {
      api.subscriber!.add(1, { displayName: 'Jira' } as never, { displayName: 'Jira' } as never, [], true, 'jira')
    })
    await act(async () => {
      api.subscriber!.ready()
    })
    expect(rendered.textContent).toContain('Unlocked app')

    await act(async () => slow.resolve([{ vendorId: 'jira', displayName: 'Jira', state: 'missing' }]))
    expect(rendered.textContent).toContain('Unlocked app')
  })

  it('refreshes required connection status from the connected-accounts subscription', async () => {
    const api = createApi([{ vendorId: 'github', displayName: 'GitHub', state: 'missing' }])
    api.getRequiredConnectionStatuses
      .mockResolvedValueOnce([{ vendorId: 'github', displayName: 'GitHub', state: 'missing' }])
      .mockResolvedValueOnce([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }])
    const rendered = await renderGate(api, '/')

    expect(rendered.textContent).toContain('Connect required services')
    expect(api.subscriber).toBeTruthy()

    await act(async () => {
      api.subscriber!.add(1, { displayName: 'GitHub' } as never, { displayName: 'GitHub' } as never, [], true, 'github')
    })

    expect(api.getRequiredConnectionStatuses).toHaveBeenCalledTimes(2)
    expect(rendered.textContent).toContain('Unlocked app')
  })

  it('coalesces connected-account add and ready bursts into one required-status refresh', async () => {
    const api = createApi([{ vendorId: 'github', displayName: 'GitHub', state: 'missing' }])
    api.getRequiredConnectionStatuses
      .mockResolvedValueOnce([{ vendorId: 'github', displayName: 'GitHub', state: 'missing' }])
      .mockResolvedValueOnce([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }])
    const rendered = await renderGate(api, '/')

    await act(async () => {
      api.subscriber!.add(1, { displayName: 'GitHub' } as never, { displayName: 'GitHub' } as never, [], true, 'github')
      api.subscriber!.ready()
    })

    expect(api.getRequiredConnectionStatuses).toHaveBeenCalledTimes(2)
    expect(rendered.textContent).toContain('Unlocked app')
  })

  it('keeps focused app content visible while a healthy route refreshes in the background', async () => {
    const api = createApi([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }])
    const pending = deferred<RequiredConnectionStatus[]>()
    api.getRequiredConnectionStatuses
      .mockResolvedValueOnce([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }])
      .mockReturnValueOnce(pending.promise)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RequiredConnectionsGate authenticatedApi={api as never} pathname="/">
          <label>
            Prompt
            <textarea defaultValue="Investigate renewals" />
          </label>
        </RequiredConnectionsGate>,
      )
    })
    const prompt = container.querySelector('textarea')!
    prompt.focus()
    prompt.setSelectionRange(4, 11)

    await act(async () => api.subscriber!.ready())

    expect(container.textContent).not.toContain('Checking required connections')
    expect(document.activeElement).toBe(prompt)
    expect(prompt.selectionStart).toBe(4)
    expect(prompt.selectionEnd).toBe(11)

    await act(async () => pending.resolve([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }]))
    expect(container.querySelector('textarea')).toBe(prompt)
  })

  it('keeps an already-unlocked workspace mounted across benign healthy account updates', async () => {
    const api = createApi([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }])
    const firstBenignUpdate = deferred<RequiredConnectionStatus[]>()
    const secondBenignUpdate = deferred<RequiredConnectionStatus[]>()
    api.getRequiredConnectionStatuses
      .mockResolvedValueOnce([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }])
      .mockReturnValueOnce(firstBenignUpdate.promise)
      .mockReturnValueOnce(secondBenignUpdate.promise)

    let mounts = 0
    let cleanups = 0
    function WorkspaceThatRefreshesAccounts() {
      useEffect(() => {
        mounts += 1
        api.subscriber!.add(1, { displayName: 'GitHub' } as never, { displayName: 'GitHub' } as never, [], true, 'github')
        return () => { cleanups += 1 }
      }, [])
      return <div>Workspace content</div>
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RequiredConnectionsGate authenticatedApi={api as never} pathname="/workspace/abc">
          <WorkspaceThatRefreshesAccounts />
        </RequiredConnectionsGate>,
      )
    })

    expect(container.textContent).toContain('Workspace content')
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)
    expect(api.getRequiredConnectionStatuses).toHaveBeenCalledTimes(2)

    await act(async () => {
      api.subscriber!.add(1, { displayName: 'GitHub' } as never, { displayName: 'GitHub' } as never, [], true, 'github')
    })

    expect(api.getRequiredConnectionStatuses).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('Workspace content')
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)

    await act(async () => firstBenignUpdate.resolve([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }]))
    await act(async () => secondBenignUpdate.resolve([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }]))

    expect(container.textContent).toContain('Workspace content')
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)
  })

  it('hides the Home composer on account removal until required connections are verified healthy', async () => {
    const api = createApi([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }])
    const benign = deferred<RequiredConnectionStatus[]>()
    const afterRemove = deferred<RequiredConnectionStatus[]>()
    api.getRequiredConnectionStatuses
      .mockResolvedValueOnce([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }])
      .mockReturnValueOnce(benign.promise)
      .mockReturnValueOnce(afterRemove.promise)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RequiredConnectionsGate authenticatedApi={api as never} pathname="/">
          <label>
            Prompt
            <textarea defaultValue="Keep me safe" />
          </label>
        </RequiredConnectionsGate>,
      )
    })

    await act(async () => api.subscriber!.ready())
    expect(container.textContent).not.toContain('Checking required connections')

    await act(async () => api.subscriber!.remove(1))
    expect(container.textContent).toContain('Checking required connections')
    expect(container.querySelector('label')?.style.display).toBe('none')

    await act(async () => benign.resolve([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }]))
    expect(container.textContent).toContain('Checking required connections')
    expect(container.querySelector('label')?.style.display).toBe('none')

    await act(async () => afterRemove.resolve([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }]))
    expect(container.querySelector('textarea')?.value).toBe('Keep me safe')
    expect(container.querySelector('label')?.style.display).not.toBe('none')
    expect(container.textContent).not.toContain('Checking required connections')
  })

  it('hides the Home composer on expired account updates until required connections are verified healthy', async () => {
    const api = createApi([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }])
    const pending = deferred<RequiredConnectionStatus[]>()
    api.getRequiredConnectionStatuses
      .mockResolvedValueOnce([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }])
      .mockReturnValueOnce(pending.promise)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RequiredConnectionsGate authenticatedApi={api as never} pathname="/">
          <label>
            Prompt
            <textarea defaultValue="Reconnect first" />
          </label>
        </RequiredConnectionsGate>,
      )
    })

    await act(async () => {
      api.subscriber!.add(1, { displayName: 'GitHub' } as never, { displayName: 'GitHub' } as never, [], false, 'github')
    })

    expect(container.textContent).toContain('Checking required connections')
    expect(container.querySelector('label')?.style.display).toBe('none')
    await act(async () => pending.resolve([{ vendorId: 'github', displayName: 'GitHub', state: 'healthy' }]))
    expect(container.querySelector('textarea')?.value).toBe('Reconnect first')
    expect(container.querySelector('label')?.style.display).not.toBe('none')
  })

  it('checks a replacement API synchronously and ignores its predecessor’s late result', async () => {
    const first = createApi([])
    const rendered = await renderGate(first, '/sessions')
    const stale = deferred<RequiredConnectionStatus[]>()
    first.getRequiredConnectionStatuses.mockReturnValue(stale.promise)
    await act(async () => first.subscriber!.ready())
    const next = createApi([])
    const pending = deferred<RequiredConnectionStatus[]>()
    next.getRequiredConnectionStatuses.mockReturnValue(pending.promise)
    await act(async () => root!.render(
      <RequiredConnectionsGate authenticatedApi={next as never} pathname="/sessions">
        <div>Unlocked app</div>
      </RequiredConnectionsGate>,
    ))
    expect(rendered.textContent).toContain('Checking required connections')
    await act(async () => stale.resolve([]))
    expect(rendered.textContent).toContain('Checking required connections')
    await act(async () => pending.resolve([{ vendorId: 'github', displayName: 'GitHub', state: 'missing' }]))
    expect(rendered.textContent).toContain('Connect required services')
    expect(rendered.textContent).not.toContain('Unlocked app')
  })
})
