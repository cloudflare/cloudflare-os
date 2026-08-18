// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { setErrorReportingUserId } from './errorReporting'
import { AuthProvider, useAuthenticatedApi } from './AuthContext'

vi.mock('./errorReporting', () => ({
  setErrorReportingUserId: vi.fn<(userId: string | undefined) => void>(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const person: AiChatAuthorInfo = { type: 'user', id: 'person@example.com', name: 'Person' }

/** A stub whose `whoami` resolves to the given author, or rejects when none is given. */
function stubApi(author?: AiChatAuthorInfo): RpcStub<AuthenticatedApi> {
  return {
    whoami: async () => {
      if (!author) throw new Error('session gone')
      return author
    },
    amIAdmin: async () => false,
  } as unknown as RpcStub<AuthenticatedApi>
}

function CurrentUserName() {
  return <span>{useAuthenticatedApi().currentUser?.name ?? 'none'}</span>
}

describe('AuthProvider error reporting context', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    container?.remove()
    container = undefined
    vi.clearAllMocks()
  })

  /** Mounts or re-renders the provider around a consumer, returning the rendered text. */
  async function render(api: RpcStub<AuthenticatedApi>): Promise<string> {
    if (!container) {
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
    }
    await act(async () => root!.render(
      <AuthProvider authenticatedApi={api} onLogout={() => {}}>
        <CurrentUserName />
      </AuthProvider>,
    ))
    return container.textContent ?? ''
  }

  it('sets the authenticated user and clears it on unmount', async () => {
    expect(await render(stubApi(person))).toBe('Person')
    expect(setErrorReportingUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')

    act(() => root!.unmount())
    root = undefined
    expect(setErrorReportingUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('keeps the identity when a reconnect swaps the API stub', async () => {
    await render(stubApi(person))
    // A reconnect mints a fresh stub. Clearing on that swap would blank the identity for the
    // whole round trip, which is the window most likely to be producing reports.
    await render(stubApi({ ...person, name: 'Person Again' }))

    expect(setErrorReportingUserId).not.toHaveBeenCalledWith(undefined)
    expect(setErrorReportingUserId).toHaveBeenCalledTimes(2)
  })

  it('does not name a person for an author that is not a user account', async () => {
    expect(await render(stubApi({ type: 'agent', id: 'gpt-5.1-pro', name: 'GPT' }))).toBe('GPT')
    expect(setErrorReportingUserId).not.toHaveBeenCalled()
  })

  it('sets nothing when the identity lookup fails', async () => {
    expect(await render(stubApi())).toBe('none')
    expect(setErrorReportingUserId).not.toHaveBeenCalled()
  })
})
