// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, DeviceSessionHandoffStart } from '@gadgets/workshop-shared/api'
import {
  DeviceSessionHandoff,
  deviceSessionAttempt,
  deviceSessionDestination,
  deviceSessionSearch,
  hasDeviceSessionParameters,
} from './DeviceSessionHandoff'

const state = 'ABCDEFab-0000-0000-0000-000000000001'
const publicKey = 'A'.repeat(87)
type Begin = (publicKey: string, state: string) => Promise<DeviceSessionHandoffStart>

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('native device-session handoff', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    vi.restoreAllMocks()
  })

  const render = async (begin: Begin, search = `?cfos_native_state=${state}&cfos_native_key=${publicKey}`) => {
    window.history.replaceState({}, '', `/${search}`)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const api = Object.assign(vi.fn<() => void>(), {
      beginDeviceSessionHandoff: begin,
    }) as unknown as RpcStub<AuthenticatedApi>
    await act(async () => {
      root!.render(<DeviceSessionHandoff authenticatedApi={api} />)
    })
    return container
  }

  it('accepts a bounded opaque state and one ephemeral public key', () => {
    expect(deviceSessionAttempt(
      `?other=hello&cfos_native_state=${state}&cfos_native_key=${publicKey}`,
    )).toEqual({ state, publicKey })
    expect(hasDeviceSessionParameters('?cfos_native_state=bad')).toBe(true)
  })

  it('rejects missing, duplicated, or malformed attempt parameters', () => {
    expect(deviceSessionAttempt('')).toBeNull()
    expect(deviceSessionAttempt(
      `?cfos_native_state=${state}&cfos_native_key=${publicKey}&cfos_native_state=${state}`,
    )).toBeNull()
    expect(deviceSessionAttempt(`?cfos_native_state=${state}`)).toBeNull()
    expect(deviceSessionAttempt(`?cfos_native_state=short&cfos_native_key=${publicKey}`)).toBeNull()
    expect(deviceSessionAttempt(`?cfos_native_state=${state}&cfos_native_key=bad`)).toBeNull()
  })

  it('preserves only a validated attempt across authentication pages', () => {
    const search = `?unrelated=value&cfos_native_state=${state}&cfos_native_key=${publicKey}`
    expect(deviceSessionSearch(search)).toEqual({
      cfos_native_state: state,
      cfos_native_key: publicKey,
    })
    expect(deviceSessionDestination('/signup', search))
      .toBe(`/signup?cfos_native_state=${state}&cfos_native_key=${publicKey}`)
    expect(deviceSessionDestination('/', '?cfos_native_state=short')).toBe('/')
  })

  it('requires confirmation before staging and submits only an opaque server handle', async () => {
    const begin = vi.fn<Begin>().mockResolvedValue({ handoffId: 'a'.repeat(64) })
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(
      function (this: HTMLFormElement) {
        expect(this.method).toBe('post')
        expect(new URL(this.action).pathname).toBe('/api/device-session/callback')
        expect(Object.fromEntries(new FormData(this))).toEqual({
          state,
          handoffId: 'a'.repeat(64),
        })
      },
    )
    const page = await render(begin)
    expect(begin).not.toHaveBeenCalled()
    expect(page.textContent).toContain('Continue only if you started this sign-in')

    await act(async () => {
      page.querySelector('button')!.click()
    })
    expect(begin).toHaveBeenCalledOnce()
    expect(begin).toHaveBeenCalledWith(publicKey, state)
    expect(submit).toHaveBeenCalledOnce()
    expect(page.textContent).toContain('Finishing sign-in')
  })

  it('shows malformed attempts and staging failures instead of the Workshop', async () => {
    let page = await render(vi.fn<Begin>(), '?cfos_native_state=bad')
    expect(page.textContent).toContain('This device-session request is invalid')
    act(() => root?.unmount())
    page.remove()
    root = undefined
    container = undefined

    const begin = vi.fn<Begin>().mockRejectedValue(new Error('expired'))
    page = await render(begin)
    await act(async () => {
      page.querySelector('button')!.click()
    })
    expect(page.textContent).toContain('Could not prepare this device session')
    expect(page.querySelector('button')).not.toBeNull()
  })
})
