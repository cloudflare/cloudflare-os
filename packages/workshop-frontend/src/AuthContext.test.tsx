// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuthenticatedApi } from './AuthContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const user: AiChatAuthorInfo = { type: 'user', id: 'tester@example.com', name: 'Tester' }

const apiWithWhoami = (whoami: () => Promise<AiChatAuthorInfo>) => ({
  whoami,
  amIAdmin: async () => false,
}) as RpcStub<AuthenticatedApi>

const CurrentUserProbe = () => {
  const { currentUser } = useAuthenticatedApi()
  return <span>{currentUser?.id ?? 'loading'}</span>
}

describe('AuthProvider', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps the current user available while a reconnected API confirms the same account', async () => {
    let confirmReconnect!: (info: AiChatAuthorInfo) => void
    const nextIdentity = new Promise<AiChatAuthorInfo>(resolve => { confirmReconnect = resolve })
    const firstApi = apiWithWhoami(async () => ({ ...user }))
    const nextApi = apiWithWhoami(() => nextIdentity)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(
      <AuthProvider authenticatedApi={firstApi} onLogout={() => {}}>
        <CurrentUserProbe />
      </AuthProvider>
    ))
    expect(container.textContent).toBe(user.id)

    await act(async () => root.render(
      <AuthProvider authenticatedApi={nextApi} onLogout={() => {}}>
        <CurrentUserProbe />
      </AuthProvider>
    ))
    expect(container.textContent).toBe(user.id)

    await act(async () => confirmReconnect({ ...user }))
    expect(container.textContent).toBe(user.id)
    act(() => root.unmount())
  })

  it('confirms the current user after a transient identity lookup failure', async () => {
    vi.useFakeTimers()
    const whoami = vi.fn<AuthenticatedApi['whoami']>()
      .mockRejectedValueOnce(new Error('WebSocket not ready'))
      .mockResolvedValue(user)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(
      <AuthProvider authenticatedApi={apiWithWhoami(whoami)} onLogout={() => {}}>
        <CurrentUserProbe />
      </AuthProvider>
    ))
    expect(container.textContent).toBe('loading')

    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(container.textContent).toBe(user.id)
    expect(whoami).toHaveBeenCalledTimes(2)
    act(() => root.unmount())
  })
})
