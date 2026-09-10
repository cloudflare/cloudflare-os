// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import { useAuth } from './useAuth'

vi.mock('./errorReporting', () => ({ setReportedUserId: vi.fn<(id?: string) => void>() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
let auth: ReturnType<typeof useAuth>

function identity(id: string) {
  return { whoami: async () => ({ id, name: id, type: 'user' as const }),
    [Symbol.dispose]: vi.fn<() => void>(), switchAccountIdentity: vi.fn<(id: string) => Promise<unknown>>() }
}

function apiFor(source: ReturnType<typeof identity>) {
  return { authenticate: () => source, authenticateFromCfAccess: () => source } as unknown as RpcStub<PublicApi>
}

function Consumer({ api }: { api: RpcStub<PublicApi> }) {
  auth = useAuth(api)
  return null
}

async function mount(api: RpcStub<PublicApi>) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  localStorage.setItem('authToken', 'login-one')
  await act(async () => root.render(<Consumer api={api} />))
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  localStorage.clear()
})

it('disposes the previous capability, resets the identity boundary, and restores the choice on reconnect', async () => {
  const old = identity('a@totango.com')
  const collision = identity('a@heyodie.ai')
  old.switchAccountIdentity.mockResolvedValue(collision)
  await mount(apiFor(old))
  await act(async () => auth.switchIdentity('a@heyodie.ai'))
  expect(auth.authenticatedApi).toBe(collision)
  expect(auth.identityRevision).toBe(1)
  expect(old[Symbol.dispose]).toHaveBeenCalled()
  const reconnected = identity('a@totango.com')
  const restored = identity('a@heyodie.ai')
  reconnected.switchAccountIdentity.mockResolvedValue(restored)
  await act(async () => root.render(<Consumer api={apiFor(reconnected)} />))
  expect(reconnected.switchAccountIdentity).toHaveBeenCalledWith('a@heyodie.ai')
  expect(reconnected[Symbol.dispose]).toHaveBeenCalled()
  expect(auth.authenticatedApi).toBe(restored)
  expect(auth.identityRevision).toBe(1)
})

it('does not carry a choice into a new login', async () => {
  const old = identity('a@totango.com')
  old.switchAccountIdentity.mockResolvedValue(identity('a@heyodie.ai'))
  await mount(apiFor(old))
  await act(async () => auth.switchIdentity('a@heyodie.ai'))
  await act(async () => auth.login('login-two'))
  expect(auth.authenticatedApi).toBe(old)
  expect(old.switchAccountIdentity).toHaveBeenCalledTimes(1)
  expect(auth.identityRevision).toBe(2)
})

it('disposes a late switch result after logout instead of restoring account access', async () => {
  const old = identity('a@totango.com')
  const collision = identity('a@heyodie.ai')
  let finish!: (value: typeof collision) => void
  old.switchAccountIdentity.mockReturnValue(new Promise(resolve => { finish = resolve }))
  await mount(apiFor(old))
  let switching!: Promise<void>
  await act(async () => { switching = auth.switchIdentity('a@heyodie.ai') })
  act(() => auth.logout())
  await act(async () => {
    finish(collision)
    await expect(switching).rejects.toThrow('login changed')
  })
  expect(auth.authenticatedApi).toBeNull()
  expect(collision[Symbol.dispose]).toHaveBeenCalledOnce()
})

it('keeps the current capability when the server denies switching', async () => {
  const old = identity('a@totango.com')
  old.switchAccountIdentity.mockRejectedValue(new Error('fresh SSO required'))
  await mount(apiFor(old))
  await act(async () => {
    await expect(auth.switchIdentity('a@heyodie.ai')).rejects.toThrow('fresh SSO')
  })
  expect(auth.authenticatedApi).toBe(old)
  expect(auth.identityRevision).toBeUndefined()
})
