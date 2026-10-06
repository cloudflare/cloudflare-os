// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { testUpdateStatus } from './updateStatusFixture'

const auth = vi.hoisted(() => ({
  value: { authenticatedApi: {} as unknown, isAdmin: false },
  logRpcFailure: vi.fn<(message: string, err: unknown) => boolean>(),
}))

vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => auth.value }))
vi.mock('../../rpcErrors', () => ({ logRpcFailure: auth.logRpcFailure }))

import { useUpdateStatus } from './useUpdateStatus'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const fakeAdmin = (getUpdateStatus: () => Promise<DeploymentUpdateStatus | null>) => ({
  getUpdateStatus: vi.fn<() => Promise<DeploymentUpdateStatus | null>>(getUpdateStatus),
  [Symbol.dispose]: vi.fn<() => void>(),
})

const fakeAuthenticatedApi = (getAdminApi: () => Promise<unknown>) => ({
  getAdminApi: vi.fn<() => Promise<unknown>>(getAdminApi),
})

describe('useUpdateStatus', () => {
  let container: HTMLDivElement
  let root: Root
  let seen: Array<DeploymentUpdateStatus | null>

  const Probe = () => {
    seen.push(useUpdateStatus())
    return null
  }
  const latest = () => seen[seen.length - 1]

  const render = async (authenticatedApi: unknown, isAdmin: boolean) => {
    auth.value = { authenticatedApi, isAdmin }
    await act(async () => { root.render(<Probe />) })
  }

  beforeEach(() => {
    seen = []
    auth.logRpcFailure.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('makes no call for a user who is not an admin', async () => {
    const api = fakeAuthenticatedApi(async () => null)

    await render(api, false)

    expect(api.getAdminApi).not.toHaveBeenCalled()
    expect(latest()).toBeNull()
  })

  it('reads the status once for an admin and disposes the admin stub', async () => {
    const status = testUpdateStatus()
    const admin = fakeAdmin(async () => status)
    const api = fakeAuthenticatedApi(async () => admin)

    await render(api, true)

    expect(api.getAdminApi).toHaveBeenCalledTimes(1)
    expect(admin.getUpdateStatus).toHaveBeenCalledTimes(1)
    expect(admin[Symbol.dispose]).toHaveBeenCalledTimes(1)
    expect(latest()).toEqual(status)
  })

  it('reads null for a deployment the deploy flow did not install', async () => {
    const admin = fakeAdmin(async () => null)

    await render(fakeAuthenticatedApi(async () => admin), true)

    expect(latest()).toBeNull()
    expect(admin[Symbol.dispose]).toHaveBeenCalledTimes(1)
  })

  it('disposes the admin stub at once when unmounted mid-call, and keeps no late answer', async () => {
    const pending = deferred<DeploymentUpdateStatus | null>()
    const admin = fakeAdmin(() => pending.promise)
    await render(fakeAuthenticatedApi(async () => admin), true)
    expect(admin.getUpdateStatus).toHaveBeenCalledTimes(1)
    const rendersBeforeUnmount = seen.length

    act(() => root.unmount())
    expect(admin[Symbol.dispose]).toHaveBeenCalledTimes(1)

    await act(async () => { pending.resolve(testUpdateStatus()) })
    expect(admin[Symbol.dispose]).toHaveBeenCalledTimes(1)
    expect(seen.length).toBe(rendersBeforeUnmount)
    root = createRoot(container) // for afterEach, which unmounts it
  })

  it('disposes a stub minted after the run was cancelled without calling it', async () => {
    const minting = deferred<unknown>()
    const admin = fakeAdmin(async () => testUpdateStatus())
    await render(fakeAuthenticatedApi(() => minting.promise), true)

    act(() => root.unmount())
    await act(async () => { minting.resolve(admin) })

    expect(admin.getUpdateStatus).not.toHaveBeenCalled()
    expect(admin[Symbol.dispose]).toHaveBeenCalledTimes(1)
    root = createRoot(container) // for afterEach, which unmounts it
  })

  it('logs a failed read and reports null', async () => {
    const failure = new Error('update check unavailable')
    const admin = fakeAdmin(async () => { throw failure })

    await render(fakeAuthenticatedApi(async () => admin), true)

    expect(latest()).toBeNull()
    expect(auth.logRpcFailure).toHaveBeenCalledWith(expect.any(String), failure)
    expect(admin[Symbol.dispose]).toHaveBeenCalledTimes(1)
  })

  it('reads again through a new connection', async () => {
    const first = fakeAdmin(async () => testUpdateStatus({ latestReleaseId: 'r101-bbbbbbb' }))
    await render(fakeAuthenticatedApi(async () => first), true)

    const second = fakeAdmin(async () => testUpdateStatus({ latestReleaseId: 'r102-ccccccc' }))
    const reconnected = fakeAuthenticatedApi(async () => second)
    await render(reconnected, true)

    expect(reconnected.getAdminApi).toHaveBeenCalledTimes(1)
    expect(second.getUpdateStatus).toHaveBeenCalledTimes(1)
    expect(latest()?.latestReleaseId).toBe('r102-ccccccc')
    expect(first[Symbol.dispose]).toHaveBeenCalledTimes(1)
    expect(second[Symbol.dispose]).toHaveBeenCalledTimes(1)
  })

  it('reports null once the user is no longer an admin', async () => {
    const api = fakeAuthenticatedApi(async () => fakeAdmin(async () => testUpdateStatus()))
    await render(api, true)
    expect(latest()).not.toBeNull()

    await render(api, false)

    expect(latest()).toBeNull()
    expect(api.getAdminApi).toHaveBeenCalledTimes(1)
  })
})
