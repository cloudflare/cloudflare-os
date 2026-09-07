// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodingSessionPiCommand, CodingSessionPiConnection } from '@gadgets/workshop-shared/api'
import { PiWorkbenchInner } from './PiWorkbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./LazySessionTerminal', () => ({ default: (props: { initialInput?: string }) => <div data-terminal="true">Legacy terminal {props.initialInput}</div> }))

const rpc = (): CodingSessionPiConnection => ({ mode: 'rpc', version: 1, connectionId: 'handle', expiresAt: new Date(Date.now() + 300_000) })
const json = (value: unknown) => ({ json: JSON.stringify(value) })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('PiWorkbench owner adapter', () => {
  let root: Root
  let container: HTMLDivElement
  let events: unknown
  let initialSent: ReturnType<typeof vi.fn<() => void>>
  let connect: ReturnType<typeof vi.fn<(id: string) => Promise<CodingSessionPiConnection>>>
  let call: ReturnType<typeof vi.fn<(id: string, handle: string, command: CodingSessionPiCommand) => Promise<{ json: string }>>>
  let handle: (command: CodingSessionPiCommand) => Promise<{ json: string }>

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    initialSent = vi.fn<() => void>()
    events = { cursor: 0, truncated: false, dead: false, events: [], dialogs: [] }
    connect = vi.fn<(id: string) => Promise<CodingSessionPiConnection>>(async () => rpc())
    handle = async (command) => {
      if (command.type === 'events') return json(events)
      if (command.type === 'get_state') return json({ isStreaming: false, sessionId: 'existing-pi' })
      if (command.type === 'get_entries') return json({ entries: [
        { id: 'old', type: 'message', message: { role: 'user', content: '<script>bad()</script> old persisted message' } },
        { id: 'compact', type: 'compaction', summary: 'compaction record' },
        { id: 'branch', parentId: 'old', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'another branch' }, { type: 'toolCall', name: 'read', arguments: { path: 'file' } }] } },
      ] })
      if (command.type === 'get_tree') return json({ tree: [{ entry: { id: 'old' }, children: [] }] })
      if (command.type === 'export_html') return json({ filename: 'pi-session.html', mediaType: 'text/html', base64: btoa('<script>bad()</script>') })
      return json({ accepted: true })
    }
    call = vi.fn<(id: string, handle: string, command: CodingSessionPiCommand) => Promise<{ json: string }>>(async (_id, _handle, command) => handle(command))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // Keep the API object stable, just as AuthContext does.
  let api: { connectCodingSessionPi: typeof connect; callCodingSessionPi: typeof call }
  async function render(id = 'session', draft = 'prepared draft') {
    api ??= { connectCodingSessionPi: connect, callCodingSessionPi: call }
    if (api.connectCodingSessionPi !== connect) api = { connectCodingSessionPi: connect, callCodingSessionPi: call }
    await act(async () => root.render(<PiWorkbenchInner authenticatedApi={api} sessionId={id} initialInput={draft} onInitialInputSent={initialSent} />))
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === label)
    expect(button).toBeTruthy()
    await act(async () => button!.click())
  }
  const commands = () => call.mock.calls.map((args) => args[2])

  it('reads full persisted entries and tree, escapes content, and only drafts initial input', async () => {
    await render()
    expect(container.textContent).toContain('old persisted message')
    expect(container.textContent).toContain('compaction record')
    expect(container.textContent).toContain('another branch')
    expect(container.querySelector('script, iframe, img')).toBeNull()
    expect(container.querySelector('textarea')?.value).toBe('prepared draft')
    expect(commands().map((command) => command.type)).toEqual(['events', 'get_state', 'get_entries', 'get_tree'])
    expect(initialSent).not.toHaveBeenCalled()
    await click('Send to Pi')
    expect(commands()).toContainEqual({ type: 'prompt', message: 'prepared draft' })
    expect(initialSent).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('not proof of turn completion')
  })

  it.each(['steer', 'follow_up'] as const)('submits %s only on an explicit action', async (mode) => {
    await render()
    await act(async () => {
      const select = container.querySelector('select')!
      select.value = mode
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('Send to Pi')
    expect(commands()).toContainEqual({ type: mode, message: 'prepared draft' })
    await click('Cancel turn')
    expect(commands()).toContainEqual({ type: 'abort' })
  })

  it('does not replay ambiguous writes or restore consumed input after read reconnect', async () => {
    const normal = handle
    handle = async (command) => {
      if (command.type === 'prompt') throw new Error('timeout')
      return normal(command)
    }
    await render()
    await click('Send to Pi')
    expect(container.textContent).toContain('Outcome unknown')
    expect(container.querySelector('textarea')?.value).toBe('')
    expect(initialSent).toHaveBeenCalledOnce()
    events = null
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    events = { cursor: 0, truncated: false, dead: false, events: [], dialogs: [] }
    await click('Reconnect reads')
    expect(commands().filter((command) => command.type === 'prompt')).toHaveLength(1)
    expect(container.textContent).toContain('Outcome unknown')
    expect(container.querySelector('[data-terminal]')).toBeNull()
  })

  it('renews an expired handle on reads without sending input', async () => {
    connect.mockImplementationOnce(async () => ({ ...rpc(), expiresAt: new Date(Date.now() + 1000) }))
    await render()
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(connect).toHaveBeenCalledTimes(2)
    expect(commands().every((command) => command.type.startsWith('get_') || command.type === 'events')).toBe(true)
  })

  it('allows terminal fallback only for an explicit terminal connection and never auto-types', async () => {
    connect.mockResolvedValue({ mode: 'terminal', reason: 'Existing legacy TUI' })
    await render()
    expect(container.querySelector('[data-terminal]')?.textContent).toBe('Legacy terminal ')
    expect(container.textContent).toContain('Existing legacy TUI')
    expect(call).not.toHaveBeenCalled()
    expect(initialSent).not.toHaveBeenCalled()
  })

  it('does not fall back or keep polling on an uncertain connect error', async () => {
    connect.mockRejectedValue(new Error('protocol outcome unknown'))
    await render()
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(container.querySelector('[data-terminal]')).toBeNull()
    expect(container.textContent).toContain('No terminal fallback')
    expect(connect).toHaveBeenCalledOnce()
  })

  it('polls cursors, refreshes full history on gaps, and does not equate agent_end with settlement', async () => {
    events = { cursor: 1, truncated: true, dead: false, events: [{ cursor: 1, data: { type: 'agent_end' } }], dialogs: [] }
    await render()
    expect(container.textContent).toContain('Event gap detected')
    expect(container.textContent).toContain('not proof of settlement')
    events = { cursor: 1, truncated: false, dead: false, events: [], dialogs: [] }
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(commands()).toContainEqual({ type: 'events', after: 1 })
    expect(commands().filter((command) => command.type === 'get_entries')).toHaveLength(2)
  })

  it('requires explicit restart when dead, stopping reads and writes', async () => {
    events = { cursor: 0, truncated: false, dead: true, events: [], dialogs: [] }
    await render()
    expect(container.textContent).toContain('Explicit environment restart required')
    await click('Send to Pi')
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(commands()).toEqual([{ type: 'events', after: 0 }])
    expect(container.querySelector('[data-terminal]')).toBeNull()
  })

  it('keeps Pi dialogs separate and never retries an ambiguous dialog response', async () => {
    events = { cursor: 0, truncated: false, dead: false, events: [], dialogs: [{ id: 'dialog', method: 'confirm', title: 'Question', message: 'Continue?' }] }
    const normal = handle
    handle = async (command) => {
      if (command.type === 'extension_ui_response') throw new Error('dialog timeout')
      return normal(command)
    }
    await render()
    expect(container.textContent).toContain('not Workshop approvals')
    await click('Decline Pi dialog')
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    await click('Decline Pi dialog')
    expect(commands().filter((command) => command.type === 'extension_ui_response')).toEqual([{ type: 'extension_ui_response', id: 'dialog', confirmed: false }])
    events = { cursor: 0, truncated: false, dead: false, events: [], dialogs: [] }
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(container.querySelector('fieldset')).toBeNull()
  })

  it('downloads export as a fixed-name Blob, never embedded HTML, and revokes the URL', async () => {
    const create = vi.fn<(blob: Blob) => string>(() => 'blob:pi-download')
    const revoke = vi.fn<(url: string) => void>()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    const links: { href: string; download: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { links.push({ href: this.href, download: this.download }) })
    await render()
    expect(create).not.toHaveBeenCalled()
    await click('Download HTML')
    expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob)
    expect(links).toEqual([{ href: 'blob:pi-download', download: 'pi-session.html' }])
    expect(container.querySelector('iframe, script, object, embed')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(revoke).toHaveBeenCalledWith('blob:pi-download')
  })

  it('ignores late session results and stops future reads on cleanup', async () => {
    const pending = deferred<CodingSessionPiConnection>()
    connect.mockImplementationOnce(() => pending.promise)
    await render('old')
    await render('new', 'new draft')
    await act(async () => pending.resolve({ mode: 'terminal', reason: 'stale fallback' }))
    expect(container.querySelector('[data-terminal]')).toBeNull()
    expect(call.mock.calls.every((args) => args[0] === 'new')).toBe(true)
    await act(async () => root.render(<div />))
    const count = call.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(call).toHaveBeenCalledTimes(count)
  })

  it.each(['input', 'editor', 'select'])('answers an explicit %s dialog with a value', async (method) => {
    events = { cursor: 0, truncated: false, dead: false, events: [], dialogs: [{ id: 'value-dialog', method, title: 'Choose value', prefill: 'chosen', options: ['chosen'] }] }
    await render()
    await click('Reply to Pi')
    expect(commands()).toContainEqual({ type: 'extension_ui_response', id: 'value-dialog', value: 'chosen' })
    expect(initialSent).not.toHaveBeenCalled()
  })

  it('dismisses a dialog without approving any action', async () => {
    events = { cursor: 0, truncated: false, dead: false, events: [], dialogs: [{ id: 'dismiss', method: 'confirm' }] }
    await render()
    await click('Dismiss Pi dialog')
    expect(commands()).toContainEqual({ type: 'extension_ui_response', id: 'dismiss', cancelled: true })
  })

  it('does not dispatch or consume a draft against an expired handle', async () => {
    connect.mockImplementationOnce(async () => ({ ...rpc(), expiresAt: new Date(Date.now() + 1000) }))
    await render()
    await act(async () => vi.advanceTimersByTimeAsync(1100))
    await click('Send to Pi')
    expect(container.textContent).toContain('Nothing was sent')
    expect(initialSent).not.toHaveBeenCalled()
    expect(commands().some((command) => command.type === 'prompt')).toBe(false)
    expect(connect).toHaveBeenCalledOnce()
  })

  it('rejects oversized UTF-8 drafts before dispatch', async () => {
    await render('session', '😀'.repeat(8193))
    await click('Send to Pi')
    expect(commands().some((command) => command.type === 'prompt')).toBe(false)
  })

  it('does not download a late export after switching sessions', async () => {
    const pending = deferred<{ json: string }>()
    const normal = handle
    handle = (command) => command.type === 'export_html' ? pending.promise : normal(command)
    const create = vi.fn<(blob: Blob) => string>(() => 'blob:unexpected')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    await render('old')
    await click('Download HTML')
    await render('new')
    await act(async () => pending.resolve(json({ filename: 'pi-session.html', mediaType: 'text/html', base64: btoa('late') })))
    expect(create).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('HTML downloaded')
  })

  it('rejects an export with an untrusted filename without creating a URL', async () => {
    const normal = handle
    handle = async (command) => command.type === 'export_html' ? json({ filename: 'evil.html', mediaType: 'text/html', base64: btoa('bad') }) : normal(command)
    const create = vi.fn<(blob: Blob) => string>(() => 'blob:unexpected')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    await render()
    await click('Download HTML')
    expect(create).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Invalid Pi export')
    expect(commands().filter((command) => command.type === 'export_html')).toHaveLength(1)
  })

  it('ignores late history without scheduling another poll after unmount', async () => {
    const pending = deferred<{ json: string }>()
    const normal = handle
    handle = (command) => command.type === 'get_entries' ? pending.promise : normal(command)
    await render()
    await act(async () => root.render(<div>Unmounted</div>))
    const count = call.mock.calls.length
    await act(async () => pending.resolve(json({ entries: [{ type: 'message', message: { role: 'assistant', content: 'stale history' } }] })))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(call).toHaveBeenCalledTimes(count)
    expect(container.textContent).toBe('Unmounted')
  })

  it.each(['null', '{bad json', JSON.stringify({ entries: [null] })])('fails closed on malformed history %s', async (payload) => {
    const normal = handle
    handle = async (command) => command.type === 'get_entries' ? { json: payload } : normal(command)
    await render()
    expect(container.textContent).toContain('Full history is unavailable, not complete')
    expect(container.querySelector('[data-terminal]')).toBeNull()
    expect(container.textContent).not.toContain('No persisted entries yet')
    await click('Cancel turn')
    expect(commands()).toContainEqual({ type: 'abort' })
  })

  it.each(['get_entries', 'get_tree'] as const)('keeps state, dialogs and cancel healthy when %s fails', async (failed) => {
    const normal = handle
    handle = async (command) => {
      if (command.type === failed) throw new Error('Response byte cap exceeded')
      if (command.type === 'abort') throw new Error('Cancel outcome unknown')
      return normal(command)
    }
    events = { cursor: 1, truncated: false, dead: false, events: [{ cursor: 1, data: { type: 'agent_start' } }], dialogs: [{ id: 'healthy-dialog', method: 'confirm' }] }
    await render()
    expect(container.textContent).toContain(failed === 'get_entries' ? 'Full history is unavailable, not complete' : 'Branch tree unavailable, not complete')
    expect(container.textContent).toContain('Not streaming')
    expect(container.querySelector('fieldset')?.disabled).toBe(false)
    await click('Cancel turn')
    await click('Decline Pi dialog')
    events = { cursor: 1, truncated: false, dead: false, events: [], dialogs: [] }
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(commands()).toContainEqual({ type: 'events', after: 1 })
    expect(commands().filter((command) => command.type === 'abort')).toHaveLength(1)
    expect(commands()).toContainEqual({ type: 'extension_ui_response', id: 'healthy-dialog', confirmed: false })
    expect(container.querySelector('fieldset')).toBeNull()
    expect(connect).toHaveBeenCalledOnce()
    handle = normal
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(container.textContent).not.toContain('unavailable, not complete')
    expect(container.textContent).toContain('old persisted message')
  })

  it('does not wait for large history reads to poll controls or show dialogs', async () => {
    const pending = deferred<{ json: string }>()
    const normal = handle
    handle = (command) => command.type === 'get_entries' ? pending.promise : normal(command)
    await render()
    events = { cursor: 0, truncated: false, dead: false, events: [], dialogs: [{ id: 'during-history', method: 'confirm' }] }
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(container.querySelector('fieldset')?.disabled).toBe(false)
    await click('Cancel turn')
    await click('Dismiss Pi dialog')
    expect(commands()).toContainEqual({ type: 'abort' })
    expect(commands()).toContainEqual({ type: 'extension_ui_response', id: 'during-history', cancelled: true })
    await act(async () => pending.resolve(json({ entries: [] })))
  })

  const settlement = () => container.querySelector('[aria-label="Pi settlement"]')?.textContent
  async function batch(cursor: number, types: string[], truncated = false) {
    events = { cursor, truncated, dead: false, events: types.map((type, index) => ({ cursor: cursor - types.length + index + 1, data: { type } })), dialogs: [] }
    await act(async () => vi.advanceTimersByTimeAsync(3000))
  }

  it('tracks end, verified settlement, unrelated batches and the next turn independently', async () => {
    await render()
    await batch(1, ['agent_end'])
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(2, ['agent_settled'])
    expect(settlement()).toBe('Verified Pi settlement')
    await batch(3, ['extension_ui_request'])
    expect(settlement()).toBe('Verified Pi settlement')
    await batch(3, [])
    expect(settlement()).toBe('Verified Pi settlement')
    await batch(4, ['agent_start'])
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(5, ['agent_end'])
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(6, ['agent_settled'])
    expect(settlement()).toBe('Verified Pi settlement')
  })

  it.each(['prompt', 'steer', 'follow_up'] as const)('clears verified settlement on a %s attempt even if its outcome is unknown', async (mode) => {
    const normal = handle
    handle = async (command) => {
      if (command.type === mode) throw new Error('Unknown outcome')
      return normal(command)
    }
    await render()
    await batch(1, ['agent_settled'])
    await act(async () => {
      const select = container.querySelector('select')!
      select.value = mode
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('Send to Pi')
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(2, ['unrelated'])
    expect(settlement()).toBe('Pi settlement unknown')
    expect(commands().filter((command) => command.type === mode)).toHaveLength(1)
  })

  it.each(['truncated', 'bridge_frame_omitted'])('forgets settlement on a %s event gap, even with a settlement in that batch', async (gap) => {
    await render()
    await batch(1, ['agent_settled'])
    expect(settlement()).toBe('Verified Pi settlement')
    await batch(3, [gap, 'agent_settled'], gap === 'truncated')
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(4, ['unrelated'])
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(6, ['agent_start', 'agent_settled'])
    expect(settlement()).toBe('Verified Pi settlement')
  })

  it('does not restore settlement from an event read started before a new input attempt', async () => {
    await render()
    await batch(1, ['agent_settled'])
    const pending = deferred<{ json: string }>()
    const normal = handle
    handle = (command) => command.type === 'events' ? pending.promise : normal(command)
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    await click('Send to Pi')
    await act(async () => pending.resolve(json({ cursor: 2, truncated: false, dead: false, events: [{ cursor: 2, data: { type: 'agent_settled' } }], dialogs: [] })))
    expect(settlement()).toBe('Pi settlement unknown')
  })

  it.each(['prompt', 'steer', 'follow_up'] as const)('keeps settlement unknown after %s even for unread start/settled pairs and reconnects', async (mode) => {
    await render()
    const pendingInput = deferred<{ json: string }>()
    const normal = handle
    handle = (command) => command.type === mode ? pendingInput.promise : normal(command)
    await act(async () => {
      const select = container.querySelector('select')!
      select.value = mode
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const pollCount = commands().filter((command) => command.type === 'events').length
    await click('Send to Pi')
    expect(commands().filter((command) => command.type === mode)).toHaveLength(1)
    // Both events can be unread prior-turn events even though this poll starts
    // AFTER submission. Observing a start is not authoritative correlation.
    await batch(2, ['agent_start', 'agent_settled'])
    expect(commands().filter((command) => command.type === 'events')).toHaveLength(pollCount + 1)
    expect(settlement()).toBe('Pi settlement unknown')
    await act(async () => pendingInput.resolve(json({ accepted: true })))
    await batch(3, ['agent_end'])
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(4, ['agent_start'])
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(5, ['agent_settled'])
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(6, ['unrelated'])
    expect(settlement()).toBe('Pi settlement unknown')
    events = null
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    events = { cursor: 2, truncated: false, dead: false, events: [{ cursor: 1, data: { type: 'agent_start' } }, { cursor: 2, data: { type: 'agent_settled' } }], dialogs: [] }
    await click('Reconnect reads')
    expect(connect).toHaveBeenCalledTimes(2)
    expect(settlement()).toBe('Pi settlement unknown')
    expect(container.textContent).toContain('events cannot be correlated')
    expect(commands().filter((command) => command.type === mode)).toHaveLength(1)
  })

  it('never shows verified settlement while state reports streaming or restores it just because streaming stops', async () => {
    await render()
    await batch(1, ['agent_settled'])
    expect(settlement()).toBe('Verified Pi settlement')
    const normal = handle
    handle = async (command) => command.type === 'get_state' ? json({ isStreaming: true }) : normal(command)
    await batch(2, ['unrelated'])
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(3, ['agent_settled'])
    expect(settlement()).toBe('Pi settlement unknown')
    handle = normal
    await batch(4, ['unrelated'])
    expect(settlement()).toBe('Pi settlement unknown')
    await batch(5, ['agent_settled'])
    expect(settlement()).toBe('Verified Pi settlement')
  })
})
