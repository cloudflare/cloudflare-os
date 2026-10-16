// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthPopupCancelledError, nativeAuthRelay, nativeAuthStartUrl, NATIVE_AUTH_EVENT, openNativeAuthPopup } from './authPopup'
import { openConnectWindow } from '../../connectHandoff'
import { NativeConnectSession } from './connectSession'

const ID = 'a'.repeat(64), TICKET = 'b'.repeat(64), NONCE = 'c'.repeat(64)
const FLOW = 'https://workshop.example/gatekeeper/example/connect?secret=flow'
const track = (completeConnectHandoff: (ticket: string, nonce: string) => Promise<void>) => {
  const api = { completeConnectHandoff, onRpcBroken: vi.fn<(callback: (error: unknown) => void) => void>() }
  new NativeConnectSession().track(api, Promise.resolve({ type: 'user', id: 'alice', name: 'Alice' }))
  return api
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })
beforeEach(() => vi.stubGlobal('location', { origin: 'https://workshop.example' }))

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
    const completion = openConnectWindow({ url: FLOW, nonce: NONCE }, track(completeConnectHandoff))
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

  it('cleans up if the native bridge throws before opening', () => {
    const auth = bridge()
    auth.open.mockImplementation(() => { throw new Error('cannot open browser') })
    const remove = vi.spyOn(window, 'removeEventListener')
    expect(() => openNativeAuthPopup(FLOW, vi.fn<(ticket: string) => Promise<void>>())).toThrow('cannot open browser')
    expect(remove).toHaveBeenCalledWith(NATIVE_AUTH_EVENT, expect.any(Function))
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

  it('settles an expired connect even if the native browser is already gone', async () => {
    vi.useFakeTimers()
    const auth = bridge(), complete = vi.fn<(ticket: string, nonce: string) => Promise<void>>()
    auth.close.mockImplementation(() => { throw new Error('Native browser already gone') })
    const controller = new AbortController()
    const settled = vi.fn<(error: unknown) => void>()
    const completion = openConnectWindow({ url: FLOW, nonce: NONCE }, track(complete), controller.signal)
      .catch(settled)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining('expired') }))
    controller.abort()
    result(auth.open.mock.calls[0][0], TICKET)
    await completion
    expect(auth.close).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledOnce()
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
    const api = track(completeConnectHandoff)
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

  it.each([false, true])('lets a connect caller cancel without a native dismissal event (close throws: %s)', async closeThrows => {
    const auth = bridge(), complete = vi.fn<(ticket: string, nonce: string) => Promise<void>>().mockResolvedValue(undefined)
    auth.close.mockImplementation(() => { if (closeThrows) throw new Error('Native browser already gone') })
    const controller = new AbortController()
    const completion = openConnectWindow({ url: FLOW, nonce: NONCE }, track(complete), controller.signal)
      .catch((error: unknown) => error)
    const id = auth.open.mock.calls[0][0]
    try {
      window.dispatchEvent(new Event('focus'))
      controller.abort()
      await Promise.resolve()
      expect(auth.close).toHaveBeenCalledExactlyOnceWith(id)
      await expect(completion).resolves.toBeInstanceOf(AuthPopupCancelledError)
      result(id, TICKET)
      expect(complete).not.toHaveBeenCalled()
    } finally {
      result(id)
      await completion
    }
  })

  it('does not open a flow whose caller already cancelled', async () => {
    const auth = bridge(), complete = vi.fn<(ticket: string, nonce: string) => Promise<void>>()
    const controller = new AbortController()
    controller.abort()
    const completion = openConnectWindow({ url: FLOW, nonce: NONCE }, track(complete), controller.signal)
      .catch((error: unknown) => error)
    try {
      expect(auth.open).not.toHaveBeenCalled()
      await expect(completion).resolves.toBeInstanceOf(AuthPopupCancelledError)
    } finally {
      auth.open.mock.calls.forEach(([id]) => result(id))
      await completion
    }
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

  it.each(['http://provider.example', 'javascript:alert(1)', 'https://user:password@workshop.example/gatekeeper/x',
    'https://attacker.example/gatekeeper/x', 'https://workshop.example/not-a-gatekeeper',
    'https://workshop.example/gatekeeper/../elsewhere', 'https://workshop.example:444/gatekeeper/x',
  ])('rejects unsafe provider URL %s at both native start and browser bootstrap', url => {
    const hash = '#native-auth=' + encodeURIComponent(JSON.stringify({ id: ID, url }))
    expect(nativeAuthRelay(hash, null, 1000)).toBeNull()
    expect(() => nativeAuthStartUrl(url, ID)).toThrow(/Authentication must start/)
  })
})
