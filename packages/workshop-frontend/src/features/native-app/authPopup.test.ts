// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeAuthRelay, nativeAuthStartUrl, NATIVE_AUTH_EVENT, openNativeAuthPopup } from './authPopup'
import { openConnectWindow } from '../../connectHandoff'

const ID = 'a'.repeat(64), TICKET = 'b'.repeat(64), NONCE = 'c'.repeat(64)
const FLOW = 'https://gatekeeper.example/connect?secret=flow'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

const bridge = () => {
  const authentication = { open: vi.fn<(id: string, url: string) => void>(), close: vi.fn<(id: string) => void>() }
  vi.stubGlobal('cloudflareOSNative', {
    version: 1, isAvailable: () => true, loginReady: vi.fn<() => void>(), returnToInstalls: vi.fn<() => void>(), authentication,
  })
  return authentication
}
const result = (id: string, ticket?: string) => {
  window.dispatchEvent(new CustomEvent(NATIVE_AUTH_EVENT, { detail: { id, ticket } }))
}

describe('native auth transport', () => {
  it('leaves ordinary desktop popups alone', () => {
    expect(openNativeAuthPopup(FLOW, vi.fn<(ticket: string) => Promise<void>>())).toBeNull()
  })

  it('uses native instead of window.open and redeems on the initiating API with its nonce', async () => {
    const auth = bridge()
    const open = vi.spyOn(window, 'open')
    const completeConnectHandoff = vi.fn<(ticket: string, nonce: string) => Promise<void>>().mockResolvedValue(undefined)
    const completion = openConnectWindow({ url: FLOW, nonce: NONCE }, { completeConnectHandoff })
    const [id, url] = auth.open.mock.calls[0]
    expect(open).not.toHaveBeenCalled()
    expect(url).toContain('/connect/handoff#native-auth=')
    expect(decodeURIComponent(url)).not.toContain(NONCE)
    result('d'.repeat(64), TICKET)
    expect(completeConnectHandoff).not.toHaveBeenCalled()
    result(id, TICKET)
    await completion
    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET, NONCE)
    result(id, TICKET)
    expect(completeConnectHandoff).toHaveBeenCalledTimes(1)
  })

  it('propagates server redemption failures instead of claiming success', async () => {
    const auth = bridge()
    const complete = vi.fn<(ticket: string) => Promise<void>>().mockRejectedValue(new Error('expired ticket'))
    const popup = openNativeAuthPopup(FLOW, complete)!
    result(auth.open.mock.calls[0][0], TICKET)
    await expect(popup.completion).rejects.toThrow('expired ticket')
  })

  it.each([undefined, 'invalid'])('rejects cancelled or malformed results (%s)', async ticket => {
    const auth = bridge()
    const complete = vi.fn<(ticket: string) => Promise<void>>()
    const popup = openNativeAuthPopup(FLOW, complete)!
    result(auth.open.mock.calls[0][0], ticket)
    await expect(popup.completion).rejects.toThrow(/cancelled/)
    expect(popup.closed).toBe(true)
    expect(complete).not.toHaveBeenCalled()
  })

  it('cancels and expires flows, ignoring later callbacks', async () => {
    vi.useFakeTimers()
    const auth = bridge(), complete = vi.fn<(ticket: string) => Promise<void>>()
    const popup = openNativeAuthPopup(FLOW, complete)!
    const outcome = popup.completion!.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    await expect(outcome).resolves.toMatchObject({ message: expect.stringContaining('expired') })
    expect(auth.close).toHaveBeenCalledOnce()
    result(auth.open.mock.calls[0][0], TICKET)
    expect(complete).not.toHaveBeenCalled()
  })

  it('closes the native browser when the caller cancels and ignores its late result', async () => {
    const auth = bridge(), complete = vi.fn<(ticket: string) => Promise<void>>()
    const popup = openNativeAuthPopup(FLOW, complete)!
    popup.close()
    popup.close()
    await expect(popup.completion).rejects.toThrow(/cancelled/)
    const id = auth.open.mock.calls[0][0]
    expect(auth.close).toHaveBeenCalledExactlyOnceWith(id)
    result(id, TICKET)
    expect(complete).not.toHaveBeenCalled()
  })

  it('cancels the previous connect attempt when a new flow replaces it', async () => {
    const auth = bridge(), completeConnectHandoff = vi.fn<(ticket: string, nonce: string) => Promise<void>>().mockResolvedValue(undefined)
    const api = { completeConnectHandoff }
    const first = openConnectWindow({ url: FLOW, nonce: NONCE }, api)
    const cancelled = Promise.resolve(first).catch((error: unknown) => error)
    const second = openConnectWindow({ url: FLOW, nonce: 'e'.repeat(64) }, api)
    await expect(cancelled).resolves.toMatchObject({ message: expect.stringContaining('cancelled') })
    const oldId = auth.open.mock.calls[0][0], newId = auth.open.mock.calls[1][0]
    expect(auth.close).toHaveBeenCalledExactlyOnceWith(oldId)
    result(oldId, TICKET)
    result(newId, TICKET)
    await second
    expect(completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(TICKET, 'e'.repeat(64))
  })
})

describe('external browser relay', () => {
  it('round trips only correlation state and a one-time ticket, never the nonce/session', () => {
    const start = new URL(nativeAuthStartUrl(FLOW, ID))
    const bootstrap = nativeAuthRelay(start.hash, null, 1000)!
    expect(bootstrap.destination).toBe(FLOW)
    const returned = nativeAuthRelay('#' + TICKET, bootstrap.record, 2000)!
    const url = new URL(returned.destination)
    expect(url.origin + url.pathname).toBe('https://os.cloudflare.app/authpopup')
    expect(url.search).toBe('')
    expect(new URLSearchParams(url.hash.slice(1)).get('id')).toBe(ID)
    expect(new URLSearchParams(url.hash.slice(1)).get('ticket')).toBe(TICKET)
    expect(returned.record).toBeNull()
  })

  it('does not relay unsolicited, malformed, expired or replayed handoff links', () => {
    expect(nativeAuthRelay('#' + TICKET, null, 1000)).toBeNull()
    expect(nativeAuthRelay('#bad', JSON.stringify({ id: ID, expiresAt: 2000 }), 1000)).toBeNull()
    expect(nativeAuthRelay('#' + TICKET, JSON.stringify({ id: ID, expiresAt: 999 }), 1000)).toBeNull()
    expect(nativeAuthRelay('#' + TICKET, 'garbage', 1000)).toBeNull()
  })

  it.each(['http://provider.example', 'javascript:alert(1)', 'https://user:password@provider.example'])('rejects unsafe provider URL %s', url => {
    const hash = '#native-auth=' + encodeURIComponent(JSON.stringify({ id: ID, url }))
    expect(nativeAuthRelay(hash, null, 1000)).toBeNull()
  })
})
