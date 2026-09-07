// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeWorkbenchInner } from './OpenCodeWorkbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runtime = vi.hoisted(() => ({
  requestNotificationPermission: vi.fn<() => Promise<boolean>>(async () => true),
  sendNotification: vi.fn<(options: { title: string; body: string }) => Promise<void>>(async () => {}),
}))

vi.mock('../../runtime', () => ({
  getWorkshopRuntime: () => runtime,
}))

type FetchCall = { url: string; init?: RequestInit; body?: unknown }

const fetchCalls: FetchCall[] = []
let handlers: ((url: URL, init?: RequestInit) => Response | Promise<Response>)[] = []

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function noContent(status = 204) {
  return new Response(null, { status })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function queue(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  handlers.push(handler)
}

function defaultOpenCodeResponses() {
  queue((url, init) => {
    fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.pathname.endsWith('/session') && init?.method === 'POST') return json({ id: 'created', title: 'Created', updatedAt: '2026-09-01T00:00:00Z' })
    if (url.pathname.endsWith('/session')) return json([{ id: 'older', title: 'Older', updatedAt: '2026-08-31T00:00:00Z' }, { id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z', status: 'idle' }])
    if (url.pathname.endsWith('/message')) return json([
      { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'Please **fix** it <script>alert(1)</script> ![tracker](https://evil.example/pixel)' }] },
      { info: { id: 'm2', role: 'assistant' }, parts: [{ type: 'text', text: 'Done' }, { id: 'tool-1', type: 'tool', tool: 'edit', state: { status: 'completed', input: { file: 'src/app.ts', giant: 'x'.repeat(6000) }, output: 'Updated file' } }] },
    ])
    if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'idle' } })
    if (url.pathname.endsWith('/diff')) return json({ files: ['src/app.ts'] })
    if (url.pathname.endsWith('/todo')) return json([{ content: 'Run tests', status: 'pending' }])
    if (url.pathname.endsWith('/mcp')) return json({ servers: [{ name: 'odie', status: 'connected' }] })
    if (url.pathname.endsWith('/prompt_async')) return noContent()
    if (url.pathname.endsWith('/abort')) return noContent()
    return json({ error: 'not found' }, 404)
  })
}

describe('OpenCodeWorkbench', () => {
  let container: HTMLDivElement
  let root: Root
  let mint: ReturnType<typeof vi.fn<(sessionId: string) => Promise<{ url: string; expiresAt: Date }>>>
  let onInitialInputSent: ReturnType<typeof vi.fn<() => void>>
  let onSessionUnavailable: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    fetchCalls.length = 0
    handlers = []
    mint = vi.fn<(sessionId: string) => Promise<{ url: string; expiresAt: Date }>>(async () => ({ url: `${window.location.origin}/gatekeeper/sessions/opencode/token/`, expiresAt: new Date(Date.now() + 60_000) }))
    onInitialInputSent = vi.fn<() => void>()
    onSessionUnavailable = vi.fn<() => void>()
    runtime.requestNotificationPermission.mockClear()
    runtime.sendNotification.mockClear()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const handler = handlers[0] ?? (() => json({ error: 'missing handler' }, 500))
      return Promise.resolve(handler(new URL(String(input), window.location.href), init))
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function render(initialInput?: string) {
    defaultOpenCodeResponses()
    await act(async () => {
      root.render(
        <OpenCodeWorkbenchInner
          authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }}
          sessionId="odie-session"
          sessionTitle="Repair Jarvis"
          initialInput={initialInput}
          onInitialInputSent={onInitialInputSent}
          onSessionUnavailable={onSessionUnavailable}
        />,
      )
    })
    await act(async () => {})
    return container
  }

  async function typePrompt(textarea: HTMLTextAreaElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('mints a same-origin capability, selects the most recently updated session, and loads context', async () => {
    const rendered = await render()

    expect(mint).toHaveBeenCalledWith('odie-session')
    expect(rendered.textContent).toContain('Newer')
    expect(rendered.textContent).toContain('Please fix it')
    expect(rendered.textContent).toContain('user')
    expect(rendered.textContent).toContain('edit')
    expect(rendered.textContent).toContain('[truncated]')
    expect(rendered.innerHTML).not.toContain('<script>')
    expect(rendered.querySelector('img')).toBeNull()
    expect(rendered.textContent).toContain('Image blocked: tracker')
    expect(rendered.textContent).toContain('Output')
    expect(rendered.textContent).toContain('Run tests')
    expect(rendered.textContent).toContain('odie')
    expect(rendered.querySelector('[aria-label="OpenCode sessions"]')).toBeNull()
    expect(rendered.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')?.value).toBe('newer')
  })

  it('renders the transcript and sends while ancillary metadata is deferred, without overlapping metadata polls', async () => {
    const metadata = deferred<Response>()
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer' }])
      if (url.pathname.endsWith('/message')) return json([{ info: { id: 'm1', role: 'assistant', text: 'Transcript ready' } }])
      if (url.pathname.endsWith('/status')) return json({}) // idle sessions are omitted by OpenCode
      if (url.pathname.endsWith('/prompt_async')) return noContent()
      return metadata.promise.then((response) => response.clone())
    })
    await render()
    expect(container.textContent).toContain('Transcript ready')
    const textarea = container.querySelector('textarea')!
    expect(textarea.disabled).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(fetchCalls.filter((call) => call.url.endsWith('/mcp'))).toHaveLength(1)
    expect(fetchCalls.filter((call) => call.url.endsWith('/message'))).toHaveLength(2)
    await typePrompt(textarea, 'Keep going')
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(1)
    await act(async () => metadata.resolve(json({ note: 'Metadata finally ready' })))
    expect(container.textContent).toContain('Metadata finally ready')
  })

  it('publishes transcript and independent metadata failures while status is deferred, then sends initial input only when idle', async () => {
    const status = deferred<Response>()
    let statusReads = 0
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', status: 'idle' }])
      if (url.pathname.endsWith('/message')) return json([{ info: { id: 'm1', role: 'assistant', text: 'Visible before status' } }])
      if (url.pathname.endsWith('/status')) return statusReads++ === 0 ? status.promise : json({})
      if (url.pathname.endsWith('/mcp')) throw new Error('secret capability URL and provider diagnostics')
      if (url.pathname.endsWith('/diff')) return json({ files: ['ready.ts'] })
      if (url.pathname.endsWith('/prompt_async')) return noContent()
      return json([])
    })
    await render('Queued instructions')
    expect(container.textContent).toContain('Visible before status')
    expect(container.textContent).toContain('Checking whether OpenCode is ready')
    expect(container.textContent).toContain('MCP unavailable. Will retry automatically.')
    expect(container.textContent).toContain('ready.ts')
    expect(container.textContent).not.toContain('secret capability')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false)
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    expect(fetchCalls.some((call) => call.url.endsWith('/prompt_async'))).toBe(false)
    await act(async () => status.resolve(json({ newer: { type: 'idle' } })))
    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(1)
    expect(onInitialInputSent).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false)
  })

  it.each([null, [], { error: 'unexpected response' }, { newer: {} }, { newer: { type: 'unrecognized' } }])('fails closed for malformed status %j despite an idle session-list hint', async (status) => {
    queue((url) => {
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', status: 'idle' }])
      if (url.pathname.endsWith('/status')) return json(status)
      return json([])
    })
    await render('Must not send')
    expect(container.textContent).toContain('OpenCode status is unavailable. Retry before sending.')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false)
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    expect(onInitialInputSent).not.toHaveBeenCalled()
  })

  it('keeps pending approval status gated even when all metadata fails', async () => {
    queue((url) => {
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer' }])
      if (url.pathname.endsWith('/status')) return json({ newer: { type: 'pending' } })
      if (url.pathname.endsWith('/message')) return json([])
      return noContent(503)
    })
    await render('Must wait for approval')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true)
    expect(container.querySelector('[aria-label="Abort OpenCode session"]')).toBeTruthy()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(onInitialInputSent).not.toHaveBeenCalled()
  })

  it('keeps a status request failure fatal to sending but not to transcript visibility, and recovers on retry', async () => {
    const status = deferred<Response>()
    let failed = true
    queue((url) => {
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer' }])
      if (url.pathname.endsWith('/status')) return failed ? status.promise : json({})
      if (url.pathname.endsWith('/message')) return json([{ info: { id: 'm1', text: 'Still readable' } }])
      return json([])
    })
    await render()
    await act(async () => status.reject(new Error('sensitive transport details')))
    expect(container.textContent).toContain('Still readable')
    expect(container.querySelector('[role="alert"]')).toBeTruthy()
    expect(container.textContent).not.toContain('sensitive transport')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false)
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    failed = false
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh OpenCode"]')!.click())
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false)
  })

  it('keeps the focused draft editable through a quiet poll and unknown status while blocking button and Enter sends', async () => {
    const status = deferred<Response>()
    let statusReads = 0
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer' }])
      if (url.pathname.endsWith('/status')) return ++statusReads === 2 ? status.promise : json({})
      if (url.pathname.endsWith('/prompt_async')) return noContent()
      return json([])
    })
    await render()
    const textarea = container.querySelector('textarea')!
    const send = container.querySelector<HTMLButtonElement>('button[type="submit"]')!
    textarea.focus()
    await typePrompt(textarea, 'Draft before polling')
    expect(send.disabled).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(container.textContent).toContain('Checking whether OpenCode is ready')
    expect(textarea.disabled).toBe(false)
    expect(document.activeElement).toBe(textarea)
    await typePrompt(textarea, 'Draft edited while status is pending')
    expect(textarea.value).toBe('Draft edited while status is pending')
    expect(send.disabled).toBe(true)
    await act(async () => {
      send.click()
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(fetchCalls.some((call) => call.url.endsWith('/prompt_async'))).toBe(false)

    await act(async () => status.resolve(json({ newer: { type: 'unknown' } })))
    expect(textarea.disabled).toBe(false)
    expect(document.activeElement).toBe(textarea)
    await typePrompt(textarea, 'Draft edited after status failure')
    expect(send.disabled).toBe(true)
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(fetchCalls.some((call) => call.url.endsWith('/prompt_async'))).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(textarea.value).toBe('Draft edited after status failure')
    expect(document.activeElement).toBe(textarea)
    expect(send.disabled).toBe(false)
  })

  it.each(['timeout', 'transport'])('does not automatically replay an accepted initial prompt after an ambiguous %s failure', async (failure) => {
    const response = deferred<Response>()
    let accepted = 0
    queue((url, init) => {
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer' }])
      if (url.pathname.endsWith('/status')) return json({})
      if (url.pathname.endsWith('/message')) return json(accepted ? [{ info: { id: 'accepted', role: 'user', text: 'Accepted work' } }] : [])
      if (url.pathname.endsWith('/prompt_async')) {
        accepted++ // The server accepted work, but the browser may never receive its acknowledgement.
        if (accepted > 1) return noContent()
        init?.signal?.addEventListener('abort', () => response.reject(init.signal?.reason))
        return response.promise
      }
      return json([])
    })
    await render('Accepted work')
    expect(accepted).toBe(1)
    expect(onInitialInputSent).toHaveBeenCalledOnce()
    if (failure === 'timeout') {
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    } else {
      await act(async () => response.reject(new TypeError('Network connection lost')))
    }
    expect(onInitialInputSent).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Accepted work')

    // Error recovery and several successful idle polls must not replay the initial input.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh OpenCode"]')!.click())
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(container.textContent).toContain('Accepted work')
    expect(accepted).toBe(1)
    expect(onInitialInputSent).toHaveBeenCalledOnce()

    // The user can deliberately send again from the composer after reviewing the transcript.
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(accepted).toBe(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(accepted).toBe(2)
  })

  it.each(['failed', 'in-flight'])('consumes parent initial input before acknowledgement so a %s request cannot replay on navigation remount', async (stage) => {
    const status = deferred<Response>()
    const request = deferred<Response>()
    let statusReads = 0
    let accepted = 0
    const api = { mintCodingSessionOpenCodeCapability: mint }
    queue((url, init) => {
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer' }])
      if (url.pathname.endsWith('/status')) return statusReads++ === 0 ? status.promise : json({})
      if (url.pathname.endsWith('/prompt_async')) {
        accepted++
        init?.signal?.addEventListener('abort', () => request.reject(init.signal?.reason))
        return request.promise
      }
      return json([])
    })
    // Mirrors SessionsContext: the parent survives route navigation and consumes
    // its queued input via the callback, while the workbench itself remounts.
    function Parent({ visible }: { visible: boolean }) {
      const [pendingInitialInput, setPendingInitialInput] = useState<string | undefined>('Accepted work')
      return <>
        <output>{pendingInitialInput ? 'Input queued' : 'Input consumed'}</output>
        {visible && <OpenCodeWorkbenchInner
          authenticatedApi={api}
          sessionId="odie-session"
          sessionTitle="Repair Jarvis"
          initialInput={pendingInitialInput}
          onInitialInputSent={() => { onInitialInputSent(); setPendingInitialInput(undefined) }}
        />}
      </>
    }
    await act(async () => root.render(<Parent visible />))
    expect(container.textContent).toContain('Input queued')
    expect(onInitialInputSent).not.toHaveBeenCalled()
    expect(accepted).toBe(0)

    await act(async () => status.resolve(json({})))
    expect(accepted).toBe(1)
    expect(container.textContent).toContain('Input consumed')
    expect(onInitialInputSent).toHaveBeenCalledOnce()
    if (stage === 'failed') await act(async () => request.reject(new TypeError('Response lost after acceptance')))

    await act(async () => root.render(<Parent visible={false} />))
    await act(async () => root.render(<Parent visible />))
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(container.textContent).toContain('Input consumed')
    expect(accepted).toBe(1)
    expect(onInitialInputSent).toHaveBeenCalledOnce()
  })

  it.each(['list', 'details', 'abort', 'command'])('replaces the API capability and ignores stale %s continuations for the same coding session', async (stage) => {
    const stale = deferred<Response>()
    const signals: AbortSignal[] = []
    let holdAbort = false
    let oldRequests = 0
    queue((url, init) => {
      const old = !url.pathname.includes('/replacement/')
      if (old) {
        oldRequests++
        if ((stage === 'list' && url.pathname.endsWith('/session')) ||
          (stage === 'details' && !url.pathname.endsWith('/session')) ||
          (stage === 'abort' && holdAbort && url.pathname.endsWith('/abort')) ||
          (stage === 'command' && url.pathname.endsWith('/command'))) {
          if (init?.signal) signals.push(init.signal)
          return stale.promise.then((response) => response.clone())
        }
      }
      if (url.pathname.endsWith('/session')) return json([{ id: old ? 'old' : 'new', title: old ? 'Old transcript' : 'Replacement transcript' }])
      if (url.pathname.endsWith('/status')) return json(old && stage === 'abort' ? { old: { type: 'busy' } } : {})
      if (url.pathname.endsWith('/message')) return json([{ info: { id: 'm1', text: old ? 'Old message' : 'Replacement message' } }])
      return json([])
    })
    await render()
    if (stage === 'abort') {
      holdAbort = true
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Abort OpenCode session"]')!.click())
    }
    if (stage === 'command') await typePrompt(container.querySelector('textarea')!, '/')
    const replacement = vi.fn<() => Promise<{ url: string; expiresAt: Date }>>(async () => ({ url: `${window.location.origin}/replacement/`, expiresAt: new Date(Date.now() + 60_000) }))
    await act(async () => root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: replacement }} sessionId="odie-session" sessionTitle="Repair Jarvis" onSessionUnavailable={onSessionUnavailable} />))
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(replacement).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Replacement message')
    const beforeRelease = vi.mocked(fetch).mock.calls.length
    await act(async () => stale.resolve(stage === 'list' ? json([]) : stage === 'command' ? json([{ name: 'stale-command' }]) : json({ old: { type: 'busy' }, secret: 'Stale metadata' })))
    expect(vi.mocked(fetch).mock.calls).toHaveLength(beforeRelease)
    expect(oldRequests).toBeGreaterThan(0)
    expect(mint).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Stale metadata')
    expect(container.textContent).toContain('Replacement message')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false)
    if (stage === 'command') {
      await typePrompt(container.querySelector('textarea')!, '/')
    }
    expect(container.textContent).not.toContain('stale-command')
  })

  it.each(['messages', 'status'])('allows drafts throughout bootstrap but gates all sends until both critical reads finish (%s first)', async (first) => {
    const capability = deferred<{ url: string; expiresAt: Date }>()
    const list = deferred<Response>()
    const create = deferred<Response>()
    const messages = deferred<Response>()
    const status = deferred<Response>()
    mint.mockImplementationOnce(() => capability.promise)
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return (init?.method === 'POST' ? create.promise : list.promise).then((response) => response.clone())
      if (url.pathname.endsWith('/message')) return messages.promise.then((response) => response.clone())
      if (url.pathname.endsWith('/status')) return status.promise.then((response) => response.clone())
      if (url.pathname.endsWith('/prompt_async')) return noContent()
      if (url.pathname.endsWith('/diff')) return json({ file: 'Independent metadata' })
      return json([])
    })
    await render('Queued instructions')
    const textarea = container.querySelector('textarea')!
    const send = container.querySelector<HTMLButtonElement>('button[type="submit"]')!
    textarea.focus()
    async function assertDraftOnly(phase: string) {
      expect(textarea.disabled).toBe(false)
      expect(document.activeElement).toBe(textarea)
      await typePrompt(textarea, `/draft ${phase}`)
      expect(textarea.value).toBe(`/draft ${phase}`)
      expect(send.disabled).toBe(true)
      await act(async () => {
        send.click()
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(fetchCalls.some((call) => call.url.endsWith('/prompt_async') || call.url.endsWith('/command'))).toBe(false)
      expect(onInitialInputSent).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('Ready for instructions')
    }
    expect(container.textContent).toContain('Connecting to the coding session…')
    await assertDraftOnly('capability')
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => capability.resolve({ url: `${window.location.origin}/secret-capability/`, expiresAt: new Date(Date.now() + 60_000) }))
    expect(container.textContent).toContain('Finding the OpenCode session…')
    await assertDraftOnly('list')
    await act(async () => list.resolve(json([])))
    expect(container.textContent).toContain('Creating the OpenCode session…')
    await assertDraftOnly('create')
    await act(async () => create.resolve(json({ id: 'created', title: 'Created' })))
    expect(container.textContent).toContain('Reading the transcript…')
    expect(container.textContent).toContain('Independent metadata')
    expect(fetchCalls.slice(2).map((call) => call.url.replace('/secret-capability', ''))).toEqual([
      '/session/created/message', '/session/status', '/session/created/diff', '/session/created/todo', '/mcp',
    ])
    await assertDraftOnly('critical reads')
    expect(container.textContent).not.toContain('secret-capability')
    await act(async () => first === 'messages' ? messages.resolve(json([])) : status.resolve(json({})))
    if (first === 'messages') expect(container.textContent).toContain('Checking OpenCode readiness…')
    await assertDraftOnly('one critical read pending')
    await act(async () => first === 'messages' ? status.resolve(json({})) : messages.resolve(json([])))
    expect(textarea.value).toBe('/draft one critical read pending')
    expect(textarea.disabled).toBe(false)
    expect(send.disabled).toBe(false)
    expect(container.textContent).toContain('Ready for instructions')
    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toEqual([
      expect.objectContaining({ body: { parts: [{ type: 'text', text: 'Queued instructions' }] } }),
    ])
    expect(onInitialInputSent).toHaveBeenCalledOnce()
    expect(fetchCalls.some((call) => call.url.endsWith('/command'))).toBe(true)
  })

  it.each(['capability', 'list', 'create', 'messages', 'status'])('clears an early draft on session change and cannot activate from stale %s results', async (stage) => {
    const stale = deferred<Response>()
    const oldCapability = deferred<{ url: string; expiresAt: Date }>()
    const newCapability = deferred<{ url: string; expiresAt: Date }>()
    const capability = { url: `${window.location.origin}/old/`, expiresAt: new Date(Date.now() + 60_000) }
    mint.mockImplementationOnce(() => stage === 'capability' ? oldCapability.promise : Promise.resolve(capability))
      .mockImplementationOnce(() => newCapability.promise)
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init })
      if ((stage === 'list' && url.pathname.endsWith('/session')) ||
        (stage === 'create' && init?.method === 'POST') ||
        (stage === 'messages' && url.pathname.endsWith('/message')) ||
        (stage === 'status' && url.pathname.endsWith('/status'))) return stale.promise
      if (url.pathname.endsWith('/session')) return json(stage === 'create' ? [] : [{ id: 'old', title: 'Old transcript' }])
      if (url.pathname.endsWith('/status')) return json({})
      return json([])
    })
    await render('Queued instructions')
    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Old early draft')
    expect(textarea.disabled).toBe(false)
    await act(async () => root.render(<OpenCodeWorkbenchInner
      authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="new-session" sessionTitle="New"
      initialInput="New queued instructions" onInitialInputSent={onInitialInputSent}
    />))
    expect(textarea.value).toBe('')
    await typePrompt(textarea, 'New early draft')
    const before = fetchCalls.length
    await act(async () => {
      oldCapability.resolve(capability)
      stale.resolve(json(stage === 'list' ? [{ id: 'old' }] : stage === 'create' ? { id: 'old' } : stage === 'status' ? {} : []))
    })
    expect(fetchCalls).toHaveLength(before)
    expect(textarea.value).toBe('New early draft')
    expect(container.textContent).not.toContain('Old transcript')
    expect(container.textContent).not.toContain('Ready for instructions')
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(fetchCalls.some((call) => call.url.endsWith('/prompt_async'))).toBe(false)
    expect(onInitialInputSent).not.toHaveBeenCalled()
  })

  it('discards a late capability mint when the authenticated API is replaced', async () => {
    const oldCapability = deferred<{ url: string; expiresAt: Date }>()
    mint.mockImplementationOnce(() => oldCapability.promise)
    await render()
    const replacement = vi.fn<() => Promise<{ url: string; expiresAt: Date }>>(async () => ({ url: `${window.location.origin}/replacement/`, expiresAt: new Date(Date.now() + 60_000) }))
    await act(async () => root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: replacement }} sessionId="odie-session" sessionTitle="Repair Jarvis" />))
    expect(container.textContent).toContain('Please fix it')
    const before = vi.mocked(fetch).mock.calls.length
    await act(async () => oldCapability.resolve({ url: `${window.location.origin}/stale-capability/`, expiresAt: new Date(Date.now() + 60_000) }))
    expect(vi.mocked(fetch).mock.calls).toHaveLength(before)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh OpenCode"]')!.click())
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).includes('/replacement/'))).toBe(true)
    expect(replacement).toHaveBeenCalledOnce()
  })

  it('does not discover slash commands from the previous ready render during API replacement', async () => {
    await render()
    const responses = handlers[0]
    const staleCommands = deferred<Response>()
    handlers = [(url, init) => url.pathname.endsWith('/command') ? staleCommands.promise : responses(url, init)]
    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, '/draft')
    const replacement = deferred<{ url: string; expiresAt: Date }>()
    const mintReplacement = vi.fn(() => replacement.promise)
    await act(async () => root.render(<OpenCodeWorkbenchInner
      authenticatedApi={{ mintCodingSessionOpenCodeCapability: mintReplacement }} sessionId="odie-session" sessionTitle="Repair Jarvis"
    />))
    // Only the session list may start after reminting; readiness is still unknown.
    const list = deferred<Response>()
    const status = deferred<Response>()
    handlers = [(url) => {
      if (url.pathname.endsWith('/session')) return list.promise
      if (url.pathname.endsWith('/status')) return status.promise
      if (url.pathname.endsWith('/command')) return json([{ name: 'draft-new' }])
      return json([])
    }]
    const callsBeforeMint = vi.mocked(fetch).mock.calls.length
    await act(async () => replacement.resolve({ url: `${window.location.origin}/replacement/`, expiresAt: new Date(Date.now() + 60_000) }))
    expect(vi.mocked(fetch).mock.calls.slice(callsBeforeMint).map(([url]) => new URL(String(url)).pathname)).toEqual(['/replacement/session'])
    expect(textarea.value).toBe('/draft')
    expect(textarea.disabled).toBe(false)
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    await act(async () => staleCommands.resolve(json([{ name: 'draft-stale' }])))
    expect(container.textContent).not.toContain('draft-stale')
    await act(async () => list.resolve(json([{ id: 'replacement' }])))
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/replacement/command'))).toBe(false)
    await act(async () => status.resolve(json({})))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/replacement/command'))).toHaveLength(1)
    expect(container.querySelector('[role="option"]')?.textContent).toContain('draft-new')
    expect(container.textContent).not.toContain('draft-stale')
  })

  it('aborts ancillary reads and clears their deadlines on unmount', async () => {
    const signals: AbortSignal[] = []
    queue((url, init) => {
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer' }])
      if (url.pathname.endsWith('/status')) return json({})
      if (url.pathname.endsWith('/message')) return json([])
      return new Promise<Response>((_resolve, reject) => {
        signals.push(init!.signal!)
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
      })
    })
    await render()
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false)
    await act(async () => root.unmount())
    expect(signals).toHaveLength(3)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('can render the reusable Changes surface from OpenCode diff data', async () => {
    defaultOpenCodeResponses()
    await act(async () => {
      root.render(
        <OpenCodeWorkbenchInner
          authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }}
          sessionId="odie-session"
          sessionTitle="Repair Jarvis"
          surface="changes"
        />,
      )
    })
    await act(async () => {})

    expect(container.querySelector('[aria-label="OpenCode changes"]')).toBeTruthy()
    expect(container.textContent).toContain('Review OpenCode')
    expect(container.textContent).toContain('src/app.ts')
    expect(container.textContent).toContain('Run tests')
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('creates an OpenCode session titled from the Odie session when none exist', async () => {
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session') && init?.method === 'POST') return json({ id: 'created', title: 'Repair Jarvis', updatedAt: '2026-09-01T00:00:00Z' })
      if (url.pathname.endsWith('/session')) return json([])
      if (url.pathname.endsWith('/message')) return json([])
      if (url.pathname.endsWith('/session/status')) return json({ created: { type: 'idle' } })
      return json({})
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair Jarvis" />)
    })
    await act(async () => {})

    expect(fetchCalls).toContainEqual(expect.objectContaining({ url: '/gatekeeper/sessions/opencode/token/session', body: { title: 'Repair Jarvis' } }))
    expect(container.textContent).toContain('Repair Jarvis')
    expect(container.querySelector('[aria-label="OpenCode transcript"]')).toBeNull()
  })

  it('sends prompts with prompt_async and aborts a running session', async () => {
    handlers = []
    let running = false
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: running ? 'busy' : 'idle' } })
      if (url.pathname.endsWith('/prompt_async')) { running = true; return noContent() }
      if (url.pathname.endsWith('/abort')) { running = false; return noContent() }
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})

    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Implement tests')
    const send = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Send'))!
    await act(async () => send.click())
    const abort = container.querySelector<HTMLButtonElement>('[aria-label="Abort OpenCode session"]')!
    await act(async () => abort.click())

    expect(fetchCalls).toContainEqual(expect.objectContaining({ url: '/gatekeeper/sessions/opencode/token/session/newer/prompt_async', body: { parts: [{ type: 'text', text: 'Implement tests' }] } }))
    expect(fetchCalls).toContainEqual(expect.objectContaining({ url: '/gatekeeper/sessions/opencode/token/session/newer/abort' }))
  })

  it('notifies once when a mounted composer turn completes quickly after submit', async () => {
    handlers = []
    let submitted = false
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'idle' } })
      if (url.pathname.endsWith('/prompt_async')) { submitted = true; return noContent() }
      if (url.pathname.endsWith('/message')) return json(submitted
        ? [{ info: { id: 'm1', role: 'assistant' }, parts: [{ type: 'text', text: 'Secret model output that must not be notified' }] }]
        : [])
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair Jarvis" />)
    })
    await act(async () => {})

    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Prompt body that must not be notified')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })

    expect(runtime.requestNotificationPermission).toHaveBeenCalledOnce()
    expect(runtime.sendNotification).toHaveBeenCalledOnce()
    expect(runtime.sendNotification).toHaveBeenCalledWith({ title: 'Agent turn complete', body: 'Repair Jarvis' })
    expect(runtime.sendNotification.mock.calls[0][0].body).not.toContain('Secret model output')
    expect(runtime.sendNotification.mock.calls[0][0].body).not.toContain('Prompt body')
  })

  it('does not notify from initial hydration or unrelated child transcript switches', async () => {
    await render()
    expect(runtime.sendNotification).not.toHaveBeenCalled()

    const transcriptPicker = container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(transcriptPicker, 'older')
      transcriptPicker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})

    expect(runtime.sendNotification).not.toHaveBeenCalled()
  })

  it('notifies once when a submitted running turn later becomes idle', async () => {
    handlers = []
    let submitted = false
    let running = false
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: running ? 'busy' : 'idle' } })
      if (url.pathname.endsWith('/prompt_async')) { submitted = true; running = true; return noContent() }
      if (url.pathname.endsWith('/message')) return json(submitted ? [{ info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'Prompt' }] }] : [])
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair Jarvis" />)
    })
    await act(async () => {})
    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Run tests')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => {})
    expect(runtime.sendNotification).not.toHaveBeenCalled()

    running = false
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })

    expect(runtime.sendNotification).toHaveBeenCalledOnce()
  })

  it('submits with Enter but not Shift+Enter or while composing', async () => {
    await render()
    const textarea = container.querySelector('textarea')!

    await typePrompt(textarea, 'Shift newline')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })))
    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(0)

    await act(async () => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(0)

    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(fetchCalls).toContainEqual(expect.objectContaining({ url: '/gatekeeper/sessions/opencode/token/session/newer/prompt_async', body: { parts: [{ type: 'text', text: 'Shift newline' }] } }))
  })

  it('guards against duplicate prompt submissions before the sending render commits', async () => {
    let resolvePrompt: ((response: Response) => void) | undefined
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'idle' } })
      if (url.pathname.endsWith('/prompt_async')) return new Promise<Response>((resolve) => { resolvePrompt = resolve })
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})
    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Send once')

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(1)
    await act(async () => { resolvePrompt?.(noContent()) })
  })

  it.each(['messages', 'status'])('defers slash discovery until bootstrap is ready and opens the draft menu (%s first)', async (first) => {
    const messages = deferred<Response>()
    const status = deferred<Response>()
    queue((url) => {
      fetchCalls.push({ url: url.pathname })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer' }])
      if (url.pathname.endsWith('/message')) return messages.promise
      if (url.pathname.endsWith('/status')) return status.promise
      if (url.pathname.endsWith('/command')) return json([{ name: 'review' }, { name: 'test' }])
      return json([])
    })
    await render()
    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, '/')
    expect(fetchCalls.some((call) => call.url.endsWith('/command'))).toBe(false)
    await act(async () => first === 'messages' ? messages.resolve(json([])) : status.resolve(json({})))
    expect(fetchCalls.some((call) => call.url.endsWith('/command'))).toBe(false)
    await act(async () => first === 'messages' ? status.resolve(json({})) : messages.resolve(json([])))
    expect(fetchCalls.filter((call) => call.url.endsWith('/command'))).toHaveLength(1)
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2)
    expect(textarea.getAttribute('aria-expanded')).toBe('true')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(textarea.value).toBe('/review ')
  })

  it.each(['highlight', 'Escape'])('preserves slash menu interaction across an in-flight and completed quiet poll (%s)', async (interaction) => {
    await render()
    const responses = handlers[0]
    const status = deferred<Response>()
    handlers = [(url, init) => {
      if (url.pathname.endsWith('/command')) return json([{ name: 'review' }, { name: 'test' }])
      if (url.pathname.endsWith('/status')) return status.promise
      return responses(url, init)
    }]
    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, '/')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('/test')
    if (interaction === 'Escape') {
      await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    }
    function assertMenu() {
      if (interaction === 'Escape') {
        expect(container.querySelector('[role="listbox"]')).toBeNull()
        expect(textarea.getAttribute('aria-expanded')).toBe('false')
      } else {
        expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('/test')
      }
    }
    assertMenu()
    const listsBeforePoll = fetchCalls.filter((call) => call.url.endsWith('/session')).length
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(fetchCalls.filter((call) => call.url.endsWith('/session'))).toHaveLength(listsBeforePoll + 1)
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    assertMenu()
    await act(async () => status.resolve(json({ newer: { type: 'idle' } })))
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false)
    assertMenu()
    if (interaction === 'highlight') {
      await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
      expect(textarea.value).toBe('/test ')
    }
  })

  it('discovers slash commands, supports keyboard selection, and submits command payloads', async () => {
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'idle' } })
      if (url.pathname.endsWith('/prompt_async') || url.pathname.endsWith('/session/newer/command')) return noContent()
      if (url.pathname.endsWith('/command')) return json({ commands: [{ name: 'review', description: 'Review code' }, { name: 'test', description: 'Run tests' }] })
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})

    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, '/t fix flaky tests')
    await act(async () => {})

    expect(fetchCalls.some((call) => call.url.endsWith('/command'))).toBe(true)
    expect(container.textContent).toContain('Run tests')

    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(textarea.value).toBe('/test fix flaky tests')
    await act(async () => {})

    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(fetchCalls).toContainEqual(expect.objectContaining({
      url: '/gatekeeper/sessions/opencode/token/session/newer/command',
      body: { command: 'test', arguments: 'fix flaky tests', parts: [{ type: 'text', text: '/test fix flaky tests' }] },
    }))
  })

  it.each([false, true])('preserves image and text drafts for sending (API replacement: %s)', async (replaceApi) => {
    class ImmediateFileReader {
      result: string | ArrayBuffer | null = null
      #listeners = new Map<string, Array<() => void>>()
      addEventListener(type: string, listener: () => void) {
        this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
      }
      readAsDataURL(file: File) {
        this.result = `data:${file.type};base64,iVBORw0KGgo=`
        for (const listener of this.#listeners.get('load') ?? []) listener()
      }
    }
    vi.stubGlobal('FileReader', ImmediateFileReader)
    await render()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'bug.png', { type: 'image/png' })

    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})

    expect(container.textContent).toContain('bug.png')
    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Use this screenshot')
    const capability = deferred<{ url: string; expiresAt: Date }>()
    if (replaceApi) {
      await act(async () => root.render(<OpenCodeWorkbenchInner
        authenticatedApi={{ mintCodingSessionOpenCodeCapability: () => capability.promise }}
        sessionId="odie-session" sessionTitle="Repair Jarvis"
        onInitialInputSent={onInitialInputSent} onSessionUnavailable={onSessionUnavailable}
      />))
    }
    expect(textarea.value).toBe('Use this screenshot')
    expect(container.textContent).toContain('bug.png')
    expect(fetchCalls.some(call => call.url.endsWith('/prompt_async'))).toBe(false)
    if (replaceApi) {
      await act(async () => capability.resolve({
        url: `${window.location.origin}/gatekeeper/sessions/opencode/token/`,
        expiresAt: new Date(Date.now() + 60_000),
      }))
    }
    expect(textarea.value).toBe('Use this screenshot')
    expect(container.textContent).toContain('bug.png')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    const call = fetchCalls.find((item) => item.url.endsWith('/prompt_async'))
    expect(call?.body).toMatchObject({
      parts: [
        { type: 'text', text: 'Use this screenshot' },
        { type: 'file', mime: 'image/png', filename: 'bug.png' },
      ],
    })
    const body = call?.body as { parts: Array<{ url?: string }> } | undefined
    expect((body?.parts[1].url ?? '').startsWith('data:image/png')).toBe(true)
    expect(container.textContent).not.toContain('bug.png')
  })

  it('rejects image data that does not match its declared file type', async () => {
    class InvalidFileReader {
      result: string | ArrayBuffer | null = null
      #listeners = new Map<string, Array<() => void>>()
      addEventListener(type: string, listener: () => void) {
        this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
      }
      readAsDataURL(file: File) {
        this.result = `data:${file.type};base64,dGV4dA==`
        for (const listener of this.#listeners.get('load') ?? []) listener()
      }
    }
    vi.stubGlobal('FileReader', InvalidFileReader)
    await render()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!

    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['text'], 'fake.png', { type: 'image/png' })] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not contain valid PNG image data')
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  })

  it('shows an aria-live working indicator while running or sending', async () => {
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'busy' } })
      return json([])
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})

    const indicator = container.querySelector('[aria-live="polite"]')
    expect(indicator?.textContent).toContain('Agent is working…')
  })

  it('remints and retries once on an expired capability response', async () => {
    mint.mockResolvedValueOnce({ url: `${window.location.origin}/gatekeeper/sessions/opencode/old/`, expiresAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ url: `${window.location.origin}/gatekeeper/sessions/opencode/new/`, expiresAt: new Date(Date.now() + 60_000) })
    let first = true
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init })
      if (first) { first = false; return noContent(403) }
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'idle' } })
      return json([])
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})

    expect(mint).toHaveBeenCalledTimes(2)
    expect(fetchCalls[0].url).toContain('/old/session')
    expect(fetchCalls[1].url).toContain('/new/session')
    expect(onSessionUnavailable).not.toHaveBeenCalled()
  })

  it('does not retry a stale session generation', async () => {
    handlers = []
    queue(() => noContent(410))

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" onSessionUnavailable={onSessionUnavailable} />)
    })
    await act(async () => {})

    expect(mint).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('OpenCode request failed (410).')
  })

  it('loads the transcript when capability startup succeeds after 45 seconds', async () => {
    const capability = deferred<{ url: string; expiresAt: Date }>()
    mint.mockImplementationOnce(() => capability.promise)

    await render()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    expect(container.textContent).toContain('Connecting to the coding session…')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
      capability.resolve({ url: `${window.location.origin}/gatekeeper/sessions/opencode/token/`, expiresAt: new Date(Date.now() + 60_000) })
    })

    expect(mint).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Please fix it')
    expect(container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')?.value).toBe('newer')
    expect(container.textContent).not.toContain('Connecting to the coding session…')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('bounds capability startup and can retry after it times out', async () => {
    const capability = deferred<{ url: string; expiresAt: Date }>()
    mint.mockImplementationOnce(() => capability.promise)

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })

    expect(container.textContent).toContain('Connecting to the coding session…')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })

    expect(container.textContent).toContain('OpenCode took too long to start.')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    const timedOutUi = container.innerHTML
    await act(async () => {
      capability.resolve({ url: `${window.location.origin}/gatekeeper/sessions/opencode/stale/`, expiresAt: new Date(Date.now() + 60_000) })
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(container.innerHTML).toBe(timedOutUi)
    expect(mint).toHaveBeenCalledOnce()
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry')!

    defaultOpenCodeResponses()
    mint.mockResolvedValue({ url: `${window.location.origin}/gatekeeper/sessions/opencode/fresh/`, expiresAt: new Date(Date.now() + 60_000) })
    await act(async () => retry.click())
    await act(async () => {})

    expect(mint).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Please fix it')
    expect(container.textContent).not.toContain('OpenCode took too long to start.')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(fetchCalls.length).toBeGreaterThan(0)
    expect(fetchCalls.every((call) => call.url.startsWith('/gatekeeper/sessions/opencode/fresh/'))).toBe(true)

    const callsBeforeRefresh = fetchCalls.length
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh OpenCode"]')!.click())

    expect(mint).toHaveBeenCalledTimes(2)
    expect(fetchCalls.length).toBeGreaterThan(callsBeforeRefresh)
    expect(fetchCalls.every((call) => call.url.startsWith('/gatekeeper/sessions/opencode/fresh/'))).toBe(true)
    expect(container.textContent).toContain('Please fix it')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('aborts an OpenCode HTTP request that does not respond', async () => {
    handlers = []
    queue((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    }))

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

    expect(container.textContent).toContain('OpenCode did not respond in time.')
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Retry')).toBe(true)
  })

  it('sends initial input exactly once across rerenders', async () => {
    await render('Initial repair prompt')
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair Jarvis" initialInput="Initial repair prompt" onInitialInputSent={onInitialInputSent} />)
    })
    await act(async () => {})

    const promptCalls = fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0].body).toEqual({ parts: [{ type: 'text', text: 'Initial repair prompt' }] })
    expect(onInitialInputSent).toHaveBeenCalledOnce()
  })

  it('waits until the selected OpenCode session is idle before sending initial input', async () => {
    let running = true
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: running ? 'busy' : 'idle' } })
      if (url.pathname.endsWith('/prompt_async')) return noContent()
      return json([])
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" initialInput="Queued repair" onInitialInputSent={onInitialInputSent} />)
    })
    await act(async () => {})
    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(0)

    running = false
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })

    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(1)
    expect(onInitialInputSent).toHaveBeenCalledOnce()
  })

  it('aborts stale requests when the Odie session changes', async () => {
    mint.mockImplementation(async (id: string) => ({
      url: `${window.location.origin}/gatekeeper/sessions/opencode/${id}/`,
      expiresAt: new Date(Date.now() + 60_000),
    }))
    let oldAborted = false
    handlers = []
    queue((url, init) => {
      if (url.pathname.includes('/old-session/')) {
        return new Promise<Response>((resolve) => {
          init?.signal?.addEventListener('abort', () => {
            oldAborted = true
            resolve(noContent(499))
          })
        })
      }
      if (url.pathname.endsWith('/session')) return json([{ id: 'new-session', title: 'New transcript', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ 'new-session': { type: 'idle' } })
      return json([])
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="old-session" sessionTitle="Old" />)
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="new-session" sessionTitle="New" />)
    })
    await act(async () => {})

    expect(oldAborted).toBe(true)
    expect(container.textContent).toContain('New transcript')
    expect(container.textContent).not.toContain('Old transcript')
  })

  it('does not remint or report a late stale response after the Odie session changes', async () => {
    let releaseOld: (() => void) | undefined
    mint.mockImplementation(async (id: string) => ({
      url: `${window.location.origin}/gatekeeper/sessions/opencode/${id}/`,
      expiresAt: new Date(Date.now() + 60_000),
    }))
    handlers = []
    queue((url) => {
      if (url.pathname.includes('/old-session/')) {
        return new Promise<Response>((resolve) => { releaseOld = () => resolve(noContent(403)) })
      }
      if (url.pathname.endsWith('/session')) return json([{ id: 'new-session', title: 'New transcript', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ 'new-session': { type: 'idle' } })
      return json([])
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="old-session" sessionTitle="Old" onSessionUnavailable={onSessionUnavailable} />)
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="new-session" sessionTitle="New" onSessionUnavailable={onSessionUnavailable} />)
    })
    await act(async () => {})
    await act(async () => releaseOld?.())

    expect(mint.mock.calls.map(([id]) => id)).toEqual(['old-session', 'new-session'])
    expect(onSessionUnavailable).not.toHaveBeenCalled()
    expect(container.textContent).toContain('New transcript')
  })

  it('does not let a slower refresh overwrite a newly selected OpenCode transcript', async () => {
    let slowA = false
    let releaseA: (() => void) | undefined
    handlers = []
    queue((url) => {
      if (url.pathname.endsWith('/session')) return json([
        { id: 'session-a', title: 'Transcript A', updatedAt: '2026-09-01T00:00:00Z' },
        { id: 'session-b', title: 'Transcript B', updatedAt: '2026-08-31T00:00:00Z' },
      ])
      if (url.pathname.endsWith('/session-a/message') && slowA) {
        return new Promise<Response>((resolve) => { releaseA = () => resolve(json([{ info: { id: 'a2', role: 'assistant' }, parts: [{ type: 'text', text: 'Stale A' }] }])) })
      }
      if (url.pathname.endsWith('/session-a/message')) return json([{ info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'Current A' }] }])
      if (url.pathname.endsWith('/session-b/message')) return json([{ info: { id: 'b1', role: 'assistant' }, parts: [{ type: 'text', text: 'Current B' }] }])
      if (url.pathname.endsWith('/session/status')) return json({ 'session-a': { type: 'idle' }, 'session-b': { type: 'idle' } })
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})
    expect(container.textContent).toContain('Current A')

    slowA = true
    const refresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh OpenCode"]')!
    await act(async () => { refresh.click() })
    const transcriptPicker = container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(transcriptPicker, 'session-b')
      transcriptPicker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})
    expect(container.textContent).toContain('Current B')

    await act(async () => { releaseA?.() })
    expect(container.textContent).toContain('Current B')
    expect(container.textContent).not.toContain('Stale A')
  })

  it('aligns the visible transcript and blocks sending while a child selection loads', async () => {
    let releaseB: (() => void) | undefined
    handlers = []
    queue((url) => {
      if (url.pathname.endsWith('/session')) return json([
        { id: 'session-a', title: 'Transcript A', updatedAt: '2026-09-01T00:00:00Z' },
        { id: 'session-b', title: 'Transcript B', updatedAt: '2026-08-31T00:00:00Z' },
      ])
      if (url.pathname.endsWith('/session-a/message')) return json([{ info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'Current A' }] }])
      if (url.pathname.endsWith('/session-b/message')) return new Promise<Response>((resolve) => {
        releaseB = () => resolve(json([{ info: { id: 'b1', role: 'assistant' }, parts: [{ type: 'text', text: 'Current B' }] }]))
      })
      if (url.pathname.endsWith('/session/status')) return json({ 'session-a': { type: 'idle' }, 'session-b': { type: 'idle' } })
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})

    const picker = container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(picker, 'session-b')
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(picker.value).toBe('session-b')
    expect(container.textContent).not.toContain('Current A')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false)
    await typePrompt(container.querySelector('textarea')!, 'Draft while switching transcripts')
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)

    await act(async () => releaseB?.())
    expect(container.textContent).toContain('Current B')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false)
  })

  it('cleans up polling timers and in-flight requests on unmount', async () => {
    let aborted = false
    handlers = []
    queue((_url, init) => new Promise<Response>((resolve) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; resolve(noContent(499)) })
    }))

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => root.unmount())

    expect(aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up a capability startup deadline on unmount', async () => {
    mint.mockImplementation(() => new Promise(() => {}))

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    await act(async () => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
  })
})
