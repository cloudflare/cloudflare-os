// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ native: false, connect: vi.fn<() => ReturnType<typeof connection>>(), render: vi.fn<() => void>() }))
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: fixture.render }) }))
vi.mock('./router', () => ({ createRouter: () => ({}) }))
vi.mock('./ThemeContext', () => ({ ThemeProvider: () => null }))
vi.mock('./components/AnnouncementBanner', () => ({ default: () => null }))
vi.mock('./FrontendErrorBoundary', () => ({ default: () => null }))
vi.mock('./errorReporting', () => ({ installWorkshopErrorReporting: vi.fn<() => void>(), reportIssue: vi.fn<() => void>() }))
vi.mock('./productFeedbackDiagnostics', () => ({ installProductFeedbackDiagnostics: vi.fn<() => void>() }))
vi.mock('./theme', () => ({ applyStoredThemeMode: vi.fn<() => void>(), applyAccentColor: vi.fn<() => void>() }))
vi.mock('./siteLogoUtils', () => ({ applySiteFavicon: vi.fn<() => void>(), cacheBustSiteLogoUrl: vi.fn<() => void>() }))
vi.mock('./runtime', () => ({
  getWorkshopRuntime: () => ({ kind: fixture.native ? 'tauri' : 'web', apiOrigin: new URL('https://example.test') }),
  installNativeLoginCoordinator: async () => {},
}))
vi.mock('./workshopWebSocketRpc', () => ({ newWorkshopWebSocketRpcSession: fixture.connect }))

// A controlled transport boundary; the production RpcPromise and retry loop remain real.
function connection(ping: () => Promise<void> = async () => {}) {
  let broken: ((error: unknown) => void) | undefined
  return {
    ping: vi.fn<() => Promise<void>>(ping),
    onRpcBroken: (callback: typeof broken) => { broken = callback },
    [Symbol.dispose]: vi.fn<() => void>(),
    fail: () => broken?.(new Error('remote-secret-must-not-be-logged')),
  }
}

let listeners: Array<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject }> = []
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  for (const level of ['debug', 'info', 'warn'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  fixture.native = false
  fixture.connect.mockReset()
  fixture.render.mockClear()
  // main owns page-lifetime listeners; clean them up when simulating a new page in the next test.
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) listeners.push({ target, type, listener })
      add(type, listener, options)
    })
  }
})
afterEach(() => {
  for (const { target, type, listener } of listeners) target.removeEventListener(type, listener)
  listeners = []
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([false, true])('retains exponential backoff across successful but short-lived connections (native=%s)', async (native) => {
  fixture.native = native
  const sockets: ReturnType<typeof connection>[] = []
  fixture.connect.mockImplementation(() => {
    const socket = connection()
    sockets.push(socket)
    return socket
  })
  await import('./main')
  const initial = native ? 500 : 1000
  if (native) await vi.advanceTimersByTimeAsync(initial)
  expect(sockets).toHaveLength(1)
  // Even a connection older than the original 0.5/1-second fast-retry threshold can be flapping.
  let expectedDelay = native ? initial * 2 : initial
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(2000)
    sockets.at(-1)!.fail()
    await vi.advanceTimersByTimeAsync(expectedDelay - 1)
    expect(sockets).toHaveLength(i + 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(i + 2)
    expectedDelay = Math.min(expectedDelay * 2, native ? 5000 : 10000)
  }
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('remote-secret')
  expect(console.info).toHaveBeenCalledWith('RPC connection restored.', expect.objectContaining({
    event: 'rpc.connection.restored', attempts: 1, elapsedMs: expectedDelay,
  }))
  await vi.advanceTimersByTimeAsync(30000)
  sockets.at(-1)!.fail()
  await vi.advanceTimersByTimeAsync(0)
  expect(sockets).toHaveLength(8)
  sockets.at(-1)!.fail()
  await vi.advanceTimersByTimeAsync(initial - 1)
  expect(sockets).toHaveLength(8)
  await vi.advanceTimersByTimeAsync(1)
  expect(sockets).toHaveLength(9)
})

it('recovers immediately after a stable connection, then backs off failed probes without publishing recovery', async () => {
  const first = connection()
  const failed = connection(async () => { throw new Error('private-probe-error') })
  const healthy = connection()
  fixture.connect.mockReturnValueOnce(first).mockReturnValueOnce(failed).mockReturnValueOnce(healthy)
  await import('./main')
  await vi.advanceTimersByTimeAsync(30000)
  first.fail()
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.connect).toHaveBeenCalledTimes(2)
  expect(first[Symbol.dispose]).toHaveBeenCalledOnce()
  expect(failed[Symbol.dispose]).toHaveBeenCalledOnce()
  expect(console.info).not.toHaveBeenCalled()
  // A second notification from the dead socket must not spawn a competing reconnect loop.
  first.fail()
  await vi.advanceTimersByTimeAsync(999)
  expect(fixture.connect).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(fixture.connect).toHaveBeenCalledTimes(3)
  expect(console.info).toHaveBeenCalledWith('RPC connection restored.', expect.objectContaining({ attempts: 2 }))
  expect(JSON.stringify(vi.mocked(console.debug).mock.calls)).not.toContain('private-probe-error')
})

it('disposes a timed-out probe and ignores its late success', async () => {
  const first = connection()
  let resolvePending!: () => void
  const pending = new Promise<void>(resolve => { resolvePending = resolve })
  const hung = connection(() => pending)
  const healthy = connection()
  fixture.connect.mockReturnValueOnce(first).mockReturnValueOnce(hung).mockReturnValueOnce(healthy)
  await import('./main')
  first.fail()
  await vi.advanceTimersByTimeAsync(21000)
  expect(hung[Symbol.dispose]).toHaveBeenCalledOnce()
  expect(console.info).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2000)
  expect(console.info).toHaveBeenCalledTimes(1)
  resolvePending()
  await vi.advanceTimersByTimeAsync(0)
  expect(console.info).toHaveBeenCalledTimes(1)
  expect(fixture.connect).toHaveBeenCalledTimes(3)
})
