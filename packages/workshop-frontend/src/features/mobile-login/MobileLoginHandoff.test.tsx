// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, MobileHandoff } from '@gadgets/workshop-shared/api'
import { MobileLoginHandoff, mobileLoginAttempt } from './MobileLoginHandoff'

const state = 'abcdefab-0000-0000-0000-000000000001'
const publicKey = 'A'.repeat(87)
type WhoAmI = () => Promise<unknown>
type CreateMobileHandoff = (publicKey: string, state: string) => Promise<MobileHandoff>

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('native mobile login handoff', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function renderWithWhoami(
    whoami: WhoAmI,
    createMobileHandoff = vi.fn<CreateMobileHandoff>(() => new Promise<never>(() => {})),
  ) {
    window.history.replaceState({}, '', `/?cfos_mobile_state=${state}&cfos_mobile_key=${publicKey}`)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // A real Cap'n Web stub is callable. An object mock misses React's state-updater trap.
    const api = Object.assign(vi.fn<() => void>(),
      { whoami, createMobileHandoff }) as unknown as RpcStub<AuthenticatedApi>
    await act(async () => {
      root!.render(<MobileLoginHandoff authenticatedApi={api} />)
    })
    expect(api).not.toHaveBeenCalled()
    return container
  }

  it('accepts only the app nonce and ephemeral public key', () => {
    expect(mobileLoginAttempt(`?cfos_mobile_state=${state}&cfos_mobile_key=${publicKey}`))
      .toEqual({ state, publicKey })
    expect(mobileLoginAttempt(`?other=hello&cfos_mobile_state=${state}&cfos_mobile_key=${publicKey}`))
      .toEqual({ state, publicKey })
  })

  it('ignores missing, duplicated, or malformed states', () => {
    expect(mobileLoginAttempt('')).toBeNull()
    expect(mobileLoginAttempt(`?cfos_mobile_state=${state}&cfos_mobile_key=${publicKey}&cfos_mobile_state=${state}`)).toBeNull()
    expect(mobileLoginAttempt(`?cfos_mobile_state=${state}`)).toBeNull()
    expect(mobileLoginAttempt(`?cfos_mobile_state=${state}&cfos_mobile_key=bad`)).toBeNull()
    expect(mobileLoginAttempt(`?cfos_mobile_state=${state.toUpperCase()}&cfos_mobile_key=${publicKey}`)).toBeNull()
  })

  it('posts only an encrypted handoff to this installation for native completion', async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
      expect(this.method).toBe('post')
      expect(new URL(this.action).pathname).toBe('/api/mobile-login/callback')
      const body = new FormData(this)
      expect(Object.fromEntries(body)).toEqual({ state, ...sealed })
      expect(JSON.stringify(Object.fromEntries(body))).not.toContain('sessionToken')
    })
    const sealed = {
      publicKey: 'B'.repeat(87), salt: 'C'.repeat(43),
      iv: 'D'.repeat(16), ciphertext: 'E'.repeat(128),
    }
    const page = await renderWithWhoami(
      vi.fn<WhoAmI>().mockResolvedValue({ type: 'user' }),
      vi.fn<CreateMobileHandoff>().mockResolvedValue(sealed))
    expect(submit).toHaveBeenCalledOnce()
    expect(page.textContent).toContain('This browser will close and return to the app')
    expect(page.querySelector('aside')).toBeNull()
    expect(page.querySelector('button')).toBeNull()
  })

  it('shows only a transition screen while verifying and sealing the session', async () => {
    const whoami = vi.fn<WhoAmI>().mockResolvedValue({ type: 'user' })
    const createMobileHandoff = vi.fn<CreateMobileHandoff>(() => new Promise<never>(() => {}))
    const page = await renderWithWhoami(whoami, createMobileHandoff)
    expect(whoami).toHaveBeenCalledOnce()
    expect(createMobileHandoff).toHaveBeenCalledOnce()
    expect(createMobileHandoff).toHaveBeenCalledWith(publicKey, state)
    expect(page.textContent).toContain('Finishing sign-in')
    expect(page.querySelector('button')).toBeNull()
  })

  it('confirms the embedded web session only for a verified user on the install page', async () => {
    const loginReady = vi.fn<() => void>()
    vi.stubGlobal('cloudflareOSNative', {
      version: 1,
      isAvailable: () => true,
      loginReady,
      returnToInstalls: vi.fn<() => void>(),
    })
    await renderWithWhoami(vi.fn<WhoAmI>().mockResolvedValue({ type: 'user' }))
    expect(loginReady).toHaveBeenCalledOnce()
  })

  it('does not offer the handoff for a rejected or non-user session', async () => {
    let page = await renderWithWhoami(
      vi.fn<WhoAmI>().mockRejectedValue(new Error('expired token')))
    expect(page.textContent).toContain('Could not transfer this session automatically')
    expect(page.querySelector('button')?.textContent).toContain('Try again')
    act(() => root?.unmount())
    page.remove()
    root = undefined
    container = undefined

    page = await renderWithWhoami(vi.fn<WhoAmI>().mockResolvedValue({ type: 'gadget' }))
    expect(page.textContent).toContain('Could not transfer this session automatically')
  })

  it('keeps the manual return available when the automatic handoff fails', async () => {
    const createMobileHandoff = vi.fn<CreateMobileHandoff>()
      .mockRejectedValue(new Error('temporary failure'))
    const page = await renderWithWhoami(
      vi.fn<WhoAmI>().mockResolvedValue({ type: 'user' }), createMobileHandoff)
    expect(createMobileHandoff).toHaveBeenCalledOnce()
    expect(page.textContent).toContain('Try again')
    expect(page.querySelector('button')?.disabled).toBe(false)
    expect(page.querySelector('button')?.textContent).toContain('Return to app')
  })
})
