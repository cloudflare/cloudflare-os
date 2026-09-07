// @vitest-environment jsdom

import React, { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  authenticatedApi: undefined as unknown as {
    mintCodingSessionAttachCapability: ReturnType<typeof vi.fn>
    uploadCodingSessionFile: ReturnType<typeof vi.fn>
  },
  terminalWrites: [] as Uint8Array[],
  terminalWriteCallbacks: [] as Array<() => void>,
  sockets: [] as MockWebSocket[],
  scrollToBottom: vi.fn<() => void>(),
  terminalInput: (_data: string) => {},
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80
    rows = 24
    options: { theme?: unknown }
    buffer = {
      active: {
        viewportY: 0,
        length: 0,
        getLine: () => undefined,
      },
    }

    constructor(options: { theme?: unknown }) {
      this.options = options
    }

    loadAddon() {}
    open() {}
    focus() {}
    scrollToBottom() { testState.scrollToBottom() }
    clear() {}
    dispose() {}
    onData(callback: (data: string) => void) { testState.terminalInput = callback; return { dispose() {} } }
    write(bytes: Uint8Array, callback: () => void) {
      testState.terminalWrites.push(bytes)
      testState.terminalWriteCallbacks.push(callback)
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('../../ThemeContext', () => ({
  useTheme: () => ({ resolvedThemeMode: 'dark' }),
}))

vi.mock('../WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick, disabled, title }: {
    children: React.ReactNode
    onClick: () => void
    disabled?: boolean
    title?: string
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} title={title}>{children}</button>
  ),
}))

import SessionTerminal from './SessionTerminal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Listener = (event: { data?: unknown }) => void

class MockWebSocket {
  static readonly OPEN = 1
  readonly url: string
  readyState = MockWebSocket.OPEN
  binaryType = ''
  readonly close = vi.fn<() => void>(() => {
    this.readyState = 3
    this.dispatch('close')
  })
  readonly send = vi.fn<(data: string | ArrayBufferLike | Blob | ArrayBufferView) => void>()
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string | URL) {
    this.url = url.toString()
    testState.sockets.push(this)
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  serverOpen() {
    this.dispatch('open')
  }

  serverMessage(data: unknown) {
    this.dispatch('message', { data })
  }

  serverClose() {
    this.readyState = 3
    this.dispatch('close')
  }

  private dispatch(type: string, event: { data?: unknown } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

function createApi() {
  let ticket = 0
  return {
    mintCodingSessionAttachCapability: vi.fn<() => Promise<{ url: string }>>(async () => {
      ticket++
      return { url: `https://terminal.example.test/attach?ticket=${ticket}` }
    }),
    uploadCodingSessionFile: vi.fn<({ filename }: { filename: string }) => Promise<{
      filename: string
      path: string
      bytesWritten: number
    }>>(async ({ filename }) => ({
      filename,
      path: `/workspace/.odie-uploads/id-${filename}`,
      bytesWritten: 5,
    })),
  }
}

function createFile(name: string, bytes = new Uint8Array([1, 2, 3, 4, 5])): File {
  const file = new File([bytes], name)
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })
  return file
}

async function renderTerminal(
  props: Partial<React.ComponentProps<typeof SessionTerminal>> = {},
) {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(SessionTerminal, { sessionId: 'session-1', ...props }))
  })
  await act(async () => {})
  return {
    container,
    async rerender(nextProps: Partial<React.ComponentProps<typeof SessionTerminal>>) {
      await act(async () => root.render(createElement(SessionTerminal, { sessionId: 'session-1', ...nextProps })))
    },
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function selectFiles(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}

beforeEach(() => {
  vi.useFakeTimers()
  testState.authenticatedApi = createApi()
  testState.terminalWrites = []
  testState.terminalWriteCallbacks = []
  testState.sockets = []
  testState.scrollToBottom.mockClear()
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  vi.stubGlobal('requestAnimationFrame', vi.fn<(callback: FrameRequestCallback) => number>((callback) => {
    return window.setTimeout(() => callback(performance.now()), 16)
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn<(handle: number) => void>((handle) => window.clearTimeout(handle)))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.textContent = ''
})

describe('SessionTerminal', () => {

  it.each(['resolve', 'reject'] as const)('times out a pending capability and ignores its late %s after recovery', async (outcome) => {
    const ticket = deferred<{ url: string }>()
    testState.authenticatedApi.mintCodingSessionAttachCapability.mockReturnValueOnce(ticket.promise)
    const rendered = await renderTerminal()
    await advance(30_000)
    expect(rendered.container.textContent).toContain('Timed out obtaining terminal access')
    expect(rendered.container.textContent).toContain('Retrying in 1s')
    await advance(1000)
    expect(testState.sockets).toHaveLength(1)
    await act(async () => testState.sockets[0]!.serverMessage(JSON.stringify({ type: 'ready' })))
    await act(async () => {
      if (outcome === 'resolve') ticket.resolve({ url: 'https://terminal.example.test/stale' })
      else ticket.reject(new Error('stale ticket error'))
    })
    await advance(60_000)
    expect(testState.sockets).toHaveLength(1)
    expect(rendered.container.textContent).toContain('Live connection')
    expect(rendered.container.textContent).not.toContain('Timed out')
    expect(rendered.container.textContent).not.toContain('stale ticket error')
    await rendered.unmount()
  })

  it('gives a slow capability a separate bounded ready window', async () => {
    const ticket = deferred<{ url: string }>()
    testState.authenticatedApi.mintCodingSessionAttachCapability.mockReturnValueOnce(ticket.promise)
    const rendered = await renderTerminal()
    await advance(25_000)
    await act(async () => ticket.resolve({ url: 'https://terminal.example.test/slow' }))
    await advance(29_000)
    expect(rendered.container.textContent).not.toContain('Timed out')
    await advance(1000)
    expect(rendered.container.textContent).toContain('Timed out waiting for the terminal to attach')
    await rendered.unmount()
  })

  it('clears a previous startup deadline before manual reconnect', async () => {
    const rendered = await renderTerminal()
    await advance(10_000)
    await act(async () => testState.sockets[0]!.serverClose())
    const reconnect = Array.from(rendered.container.querySelectorAll('button')).find((button) => button.textContent === 'Reconnect')!
    await act(async () => reconnect.click())
    await advance(20_000)
    expect(testState.sockets).toHaveLength(2)
    expect(testState.sockets[1]!.close).not.toHaveBeenCalled()
    expect(rendered.container.textContent).not.toContain('Timed out')
    await act(async () => testState.sockets[1]!.serverMessage(JSON.stringify({ type: 'ready' })))
    await advance(60_000)
    expect(testState.sockets).toHaveLength(2)
    expect(rendered.container.textContent).toContain('Live connection')
    await rendered.unmount()
  })

  it.each([false, true])('bounds waiting for ready (socket opened: %s), drains output and fences late events', async (opened) => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]!
    await act(async () => {
      if (opened) socket.serverOpen()
      socket.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 1, cursor: 'committed' }))
      socket.serverMessage(new Uint8Array([65]).buffer)
    })
    await advance(30_000)
    expect(socket.close).toHaveBeenCalledOnce()
    expect(rendered.container.textContent).toContain('Timed out waiting for the terminal to attach')
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready', cursor: 'stale' })))
    expect(rendered.container.textContent).not.toContain('Live connection')
    await advance(1000)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
    await act(async () => testState.terminalWriteCallbacks.shift()?.())
    expect(testState.sockets).toHaveLength(2)
    expect(new URL(testState.sockets[1]!.url).searchParams.get('cursor')).toBe('committed')
    await rendered.unmount()
  })

  it('caps repeated startup timeouts and supports manual recovery', async () => {
    testState.authenticatedApi.mintCodingSessionAttachCapability.mockImplementation(() => new Promise(() => {}))
    const onSessionUnavailable = vi.fn<() => void>()
    const rendered = await renderTerminal({ onSessionUnavailable })
    for (const delay of [1000, 2000, 4000, 8000, 8000]) {
      await advance(30_000 + delay)
    }
    await advance(30_000)
    expect(rendered.container.textContent).toContain('Disconnected')
    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    await advance(60_000)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(6)
    testState.authenticatedApi.mintCodingSessionAttachCapability.mockResolvedValueOnce({ url: 'https://terminal.example.test/recovered' })
    const reconnect = Array.from(rendered.container.querySelectorAll('button')).find((button) => button.textContent === 'Reconnect')!
    await act(async () => reconnect.click())
    await act(async () => testState.sockets[0]!.serverMessage(JSON.stringify({ type: 'ready' })))
    expect(rendered.container.textContent).toContain('Live connection')
    await rendered.unmount()
  })

  it('cleans the startup deadline on unmount', async () => {
    const onSessionUnavailable = vi.fn<() => void>()
    const rendered = await renderTerminal({ onSessionUnavailable })
    await rendered.unmount()
    await advance(300_000)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
    expect(onSessionUnavailable).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resolve', 'reject'] as const)('fences a pending file read across API replacement (%s)', async (outcome) => {
    const oldApi = testState.authenticatedApi
    const read = deferred<ArrayBuffer>()
    const file = new File(['x'], 'old.txt')
    Object.defineProperty(file, 'arrayBuffer', { value: () => read.promise })
    const rendered = await renderTerminal()
    await act(async () => testState.sockets[0]!.serverMessage(JSON.stringify({ type: 'ready' })))
    await selectFiles(rendered.container, [file, createFile('never.txt')])
    testState.authenticatedApi = createApi()
    await rendered.rerender({})
    const replacement = testState.sockets[1]!
    await act(async () => replacement.serverMessage(JSON.stringify({ type: 'ready' })))
    await act(async () => {
      if (outcome === 'resolve') read.resolve(new ArrayBuffer(1))
      else read.reject(new Error('stale file error'))
    })
    expect(oldApi.uploadCodingSessionFile).not.toHaveBeenCalled()
    expect(testState.authenticatedApi.uploadCodingSessionFile).not.toHaveBeenCalled()
    expect(replacement.send.mock.calls.filter(([data]) => typeof data !== 'string')).toHaveLength(0)
    expect(rendered.container.textContent).not.toMatch(/old.txt|stale file error|uploaded/)
    await selectFiles(rendered.container, [createFile('new.txt')])
    expect(testState.authenticatedApi.uploadCodingSessionFile).toHaveBeenCalledOnce()
    expect(rendered.container.textContent).toContain('File uploaded and path inserted.')
    await rendered.unmount()
  })

  it.each(['resolve', 'reject'] as const)('fences an in-flight upload and its final state updates across API replacement (%s)', async (outcome) => {
    const oldApi = testState.authenticatedApi
    const upload = deferred<{ path: string }>()
    oldApi.uploadCodingSessionFile.mockReturnValueOnce(upload.promise)
    const rendered = await renderTerminal()
    await act(async () => testState.sockets[0]!.serverMessage(JSON.stringify({ type: 'ready' })))
    const nextFile = createFile('never.txt')
    const nextRead = vi.spyOn(nextFile, 'arrayBuffer')
    await selectFiles(rendered.container, [createFile('old.txt'), nextFile])
    expect(oldApi.uploadCodingSessionFile).toHaveBeenCalledOnce()
    testState.authenticatedApi = createApi()
    const newUpload = deferred<{ path: string }>()
    testState.authenticatedApi.uploadCodingSessionFile.mockReturnValueOnce(newUpload.promise)
    await rendered.rerender({})
    const replacement = testState.sockets[1]!
    await act(async () => replacement.serverMessage(JSON.stringify({ type: 'ready' })))
    await selectFiles(rendered.container, [createFile('new.txt')])
    await act(async () => {
      if (outcome === 'resolve') upload.resolve({ path: '/workspace/old.txt' })
      else upload.reject(new Error('stale upload error'))
    })
    expect(oldApi.uploadCodingSessionFile).toHaveBeenCalledOnce()
    expect(nextRead).not.toHaveBeenCalled()
    expect(replacement.send.mock.calls.filter(([data]) => typeof data !== 'string')).toHaveLength(0)
    expect(rendered.container.textContent).toContain('Uploading new.txt')
    expect(rendered.container.textContent).not.toContain('stale upload error')
    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent === 'Uploading…')!
    expect(button.disabled).toBe(true)
    await act(async () => newUpload.resolve({ path: '/workspace/new.txt' }))
    expect(new TextDecoder().decode(replacement.send.mock.calls.at(-1)![0] as Uint8Array)).toBe("'/workspace/new.txt'")
    await rendered.unmount()
  })

  it('does not continue a multi-file upload after unmount', async () => {
    const upload = deferred<{ path: string }>()
    testState.authenticatedApi.uploadCodingSessionFile.mockReturnValueOnce(upload.promise)
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]!
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))
    await selectFiles(rendered.container, [createFile('old.txt'), createFile('never.txt')])
    await rendered.unmount()
    await act(async () => upload.resolve({ path: '/workspace/old.txt' }))
    expect(testState.authenticatedApi.uploadCodingSessionFile).toHaveBeenCalledOnce()
    expect(socket.send.mock.calls.filter(([data]) => typeof data !== 'string')).toHaveLength(0)
  })

  it('distinguishes attach, output waiting and retry phases, and gates input on ready', async () => {
    const rendered = await renderTerminal({ runtime: 'pi' })
    const socket = testState.sockets[0]!
    expect(rendered.container.textContent).toContain('Connecting…')
    await act(async () => socket.serverOpen())
    expect(rendered.container.textContent).toContain('Attaching terminal…')
    testState.terminalInput('not ready')
    expect(socket.send.mock.calls.filter(([data]) => typeof data !== 'string')).toHaveLength(0)
    await act(async () => {
      socket.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 1, cursor: 'output' }))
      socket.serverMessage(new Uint8Array([65]).buffer)
    })
    expect(rendered.container.textContent).not.toContain('Live connection')
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))
    expect(rendered.container.textContent).toContain('Waiting for Pi terminal output…')
    testState.terminalInput('ready')
    expect(socket.send.mock.calls.filter(([data]) => typeof data !== 'string')).toHaveLength(1)
    await act(async () => socket.serverClose())
    expect(rendered.container.textContent).toContain('Retrying in 1s (attempt 1/5)')
    await advance(1000)
    expect(rendered.container.textContent).toContain('Finishing buffered output before reconnecting')
    await act(async () => testState.terminalWriteCallbacks.shift()?.())
    expect(rendered.container.textContent).toContain('Connecting…')
    await rendered.unmount()
  })

  it('does not accept input or late ready messages after exit', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]!
    await act(async () => {
      socket.serverMessage(JSON.stringify({ type: 'ready' }))
      socket.serverMessage(JSON.stringify({ type: 'exit', cursor: 'exit' }))
      socket.serverMessage(JSON.stringify({ type: 'ready' }))
    })
    testState.terminalInput('must not send')
    expect(socket.send.mock.calls.filter(([data]) => typeof data !== 'string')).toHaveLength(0)
    expect(rendered.container.textContent).toContain('Disconnected')
    await rendered.unmount()
  })

  it('uploads a selected file and inserts its quoted sandbox path without submitting', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]!
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))
    const input = rendered.container.querySelector('input[type="file"]') as HTMLInputElement
    const file = createFile('screen shot.png')
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(testState.authenticatedApi.uploadCodingSessionFile).toHaveBeenCalledWith({
      sessionId: 'session-1',
      filename: 'screen shot.png',
      content: new Uint8Array([1, 2, 3, 4, 5]),
    })
    const inserted = new TextDecoder().decode(socket.send.mock.calls.at(-1)![0] as Uint8Array)
    expect(inserted).toBe("'/workspace/.odie-uploads/id-screen shot.png'")
    expect(inserted).not.toMatch(/[\r\n]/)
    expect(rendered.container.textContent).toContain('File uploaded and path inserted.')
    await rendered.unmount()
  })

  it('uploads dropped files in order and shell-quotes each inserted path', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]!
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))
    const terminalArea = rendered.container.querySelector('[aria-label="OpenCode session terminal"]')!.parentElement!
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [createFile('a.txt'), createFile("b's.png")], types: ['Files'], dropEffect: 'none' },
    })

    await act(async () => {
      terminalArea.dispatchEvent(drop)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(drop.defaultPrevented).toBe(true)
    expect(testState.authenticatedApi.uploadCodingSessionFile).toHaveBeenCalledTimes(2)
    expect(new TextDecoder().decode(socket.send.mock.calls.at(-1)![0] as Uint8Array))
      .toBe("'/workspace/.odie-uploads/id-a.txt' '/workspace/.odie-uploads/id-b'\\''s.png'")
    await rendered.unmount()
  })

  it('uploads clipboard files while leaving text-only paste to xterm', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]!
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))
    const terminalArea = rendered.container.querySelector('[aria-label="OpenCode session terminal"]')!.parentElement!
    const filePaste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(filePaste, 'clipboardData', { value: { files: [createFile('clipboard.png')] } })
    const textPaste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(textPaste, 'clipboardData', { value: { files: [] } })

    await act(async () => {
      terminalArea.dispatchEvent(filePaste)
      await Promise.resolve()
      await Promise.resolve()
    })
    terminalArea.dispatchEvent(textPaste)

    expect(filePaste.defaultPrevented).toBe(true)
    expect(textPaste.defaultPrevented).toBe(false)
    expect(testState.authenticatedApi.uploadCodingSessionFile).toHaveBeenCalledOnce()
    await rendered.unmount()
  })

  it('rejects oversized files before calling the upload API', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]!
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))
    const input = rendered.container.querySelector('input[type="file"]') as HTMLInputElement
    const oversized = createFile('huge.png')
    Object.defineProperty(oversized, 'size', { value: 10 * 1024 * 1024 + 1 })
    Object.defineProperty(input, 'files', { configurable: true, value: [oversized] })

    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))

    expect(testState.authenticatedApi.uploadCodingSessionFile).not.toHaveBeenCalled()
    expect(rendered.container.textContent).toContain('huge.png is larger than 10 MiB.')
    await rendered.unmount()
  })

  it('shows a live status and follows the latest Prime Agent TUI output', async () => {
    const rendered = await renderTerminal({ runtime: 'prime-agent', terminalKind: 'opencode' })
    const socket = testState.sockets[0]!
    await act(async () => socket.serverOpen())
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))

    expect(rendered.container.textContent).toContain('Live connection')
    expect(rendered.container.querySelector('[title^="Terminal-only integration in this application"]')).toBeTruthy()
    const follow = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Resume Prime Agent output'))
    expect(follow).toBeTruthy()
    await act(async () => follow!.click())

    expect(testState.scrollToBottom).toHaveBeenCalledOnce()
    expect(new TextDecoder().decode(socket.send.mock.calls.at(-1)?.[0] as Uint8Array)).toBe('\x1b[1;6B')
    await rendered.unmount()
  })

  it('sends one initial resize instead of redrawing again on ready', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => socket!.serverOpen())
    expect(socket!.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(socket!.send.mock.calls[0]![0] as string)).toEqual({
      type: 'resize', cols: 80, rows: 24,
    })

    await act(async () => socket!.serverMessage(JSON.stringify({ type: 'ready' })))
    expect(socket!.send).toHaveBeenCalledTimes(1)

    await rendered.unmount()
  })

  it('submits a prepared Work Item prompt once when the coding agent is ready', async () => {
    const onInitialInputSent = vi.fn<() => void>()
    const rendered = await renderTerminal({
      initialInput: 'Start working on Jira issue AI-3540.',
      onInitialInputSent,
    })
    const socket = testState.sockets[0]!

    await act(async () => socket.serverOpen())
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))

    expect(socket.send).toHaveBeenCalledTimes(2)
    expect(new TextDecoder().decode(socket.send.mock.calls[1]![0] as Uint8Array))
      .toBe('Start working on Jira issue AI-3540.\r')
    expect(onInitialInputSent).toHaveBeenCalledOnce()

    await rendered.rerender({ onInitialInputSent })
    expect(testState.sockets).toHaveLength(1)
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))
    expect(socket.send).toHaveBeenCalledTimes(2)

    await act(async () => socket.serverClose())
    await advance(1000)
    const reconnect = testState.sockets[1]!
    await act(async () => reconnect.serverOpen())
    await act(async () => reconnect.serverMessage(JSON.stringify({ type: 'ready' })))
    expect(reconnect.send).toHaveBeenCalledTimes(1)
    expect(onInitialInputSent).toHaveBeenCalledOnce()
    await rendered.unmount()
  })

  it('reconnects with a delivered chunk cursor only after the terminal write callback commits it', async () => {
    const rendered = await renderTerminal()
    const api = testState.authenticatedApi
    const firstSocket = testState.sockets[0]
    expect(firstSocket).toBeDefined()
    expect(firstSocket!.url).not.toContain('cursor=')

    firstSocket!.serverMessage(JSON.stringify({ type: 'ready' }))
    firstSocket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
    firstSocket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
    expect(testState.terminalWriteCallbacks).toHaveLength(0)
    firstSocket!.serverClose()

    await advance(1000)
    expect(api.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
    expect(testState.sockets).toHaveLength(1)
    expect(testState.terminalWriteCallbacks).toHaveLength(1)

    await act(async () => {
      testState.terminalWriteCallbacks.shift()?.()
      await Promise.resolve()
    })

    expect(api.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(testState.sockets).toHaveLength(2)
    const reconnectUrl = new URL(testState.sockets[1]!.url)
    expect(reconnectUrl.searchParams.get('ticket')).toBe('2')
    expect(reconnectUrl.searchParams.get('cursor')).toBe('chunk-cursor')

    await rendered.unmount()
  })

  it('coalesces terminal frames that arrive before the next animation frame', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 2, cursor: 'cursor-1' }))
      socket!.serverMessage(new Uint8Array([1, 2]).buffer)
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'cursor-2' }))
      socket!.serverMessage(new Uint8Array([3, 4, 5]).buffer)
    })

    expect(testState.terminalWrites).toEqual([])

    await advance(16)

    expect(testState.terminalWrites.map((chunk) => [...chunk])).toEqual([[1, 2, 3, 4, 5]])

    await rendered.unmount()
  })

  it.each([
    ['malformed cursor', JSON.stringify({ type: 'ready', cursor: '' })],
    ['protocol mismatch', new Uint8Array([1]).buffer],
  ])('closes on %s without scheduling automatic reconnect or ticket minting', async (_name, message) => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    socket!.serverMessage(message)
    expect(socket!.close).toHaveBeenCalledOnce()

    await advance(60_000)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
    expect(testState.sockets).toHaveLength(1)

    await rendered.unmount()
  })

  it('leaves fatal protocol errors disconnected and allows a manual reconnect with a fresh ticket', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => socket!.serverMessage(JSON.stringify({ type: 'ready', cursor: '' })))
    expect(rendered.container.textContent).toContain('Terminal protocol error.')
    expect(rendered.container.textContent).toContain('Disconnected')

    await advance(60_000)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
    expect(testState.sockets).toHaveLength(1)

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(testState.sockets).toHaveLength(2)
    const reconnectUrl = new URL(testState.sockets[1]!.url)
    expect(reconnectUrl.searchParams.get('ticket')).toBe('2')

    await rendered.unmount()
  })

  it('auto-retries a failed manual reconnect after the previous terminal exited', async () => {
    const rendered = await renderTerminal()
    const api = testState.authenticatedApi
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => socket!.serverMessage(JSON.stringify({
      type: 'exit', cursor: 'exit-cursor', exit: { code: 1 },
    })))
    api.mintCodingSessionAttachCapability.mockRejectedValueOnce(new Error('replacement not ready'))

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())

    expect(api.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(rendered.container.textContent).toContain('Retrying in 1s')
    await advance(1_000)

    expect(api.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(3)
    expect(testState.sockets).toHaveLength(2)
    expect(new URL(testState.sockets[1]!.url).searchParams.get('cursor')).toBe('exit-cursor')

    await rendered.unmount()
  })

  it('commits an exit cursor after pending output before manually reconnecting', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
      socket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
      socket!.serverMessage(JSON.stringify({ type: 'exit', cursor: 'exit-cursor', exit: { code: 0 } }))
    })

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)

    await act(async () => {
      testState.terminalWriteCallbacks.shift()?.()
      await Promise.resolve()
    })

    expect(testState.sockets).toHaveLength(2)
    expect(new URL(testState.sockets[1]!.url).searchParams.get('cursor')).toBe('exit-cursor')

    await rendered.unmount()
  })

  it('reports an exited session only after its final output write completes', async () => {
    const onSessionUnavailable = vi.fn<() => void>()
    const rendered = await renderTerminal({ onSessionUnavailable })
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
      socket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
      socket!.serverMessage(JSON.stringify({ type: 'exit', cursor: 'exit-cursor', exit: { code: 0 } }))
      await Promise.resolve()
    })

    expect(onSessionUnavailable).not.toHaveBeenCalled()

    await act(async () => {
      testState.terminalWriteCallbacks.shift()?.()
      await Promise.resolve()
    })

    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    await rendered.unmount()
  })

  it('stops auto-retrying quickly stable connections at the reconnect cap but keeps manual reconnect available', async () => {
    const rendered = await renderTerminal()

    for (const delay of [1_000, 2_000, 4_000, 8_000, 8_000]) {
      const socket = testState.sockets.at(-1)
      expect(socket).toBeDefined()
      await act(async () => {
        socket!.serverMessage(JSON.stringify({ type: 'ready' }))
        socket!.serverClose()
      })
      await advance(delay)
    }

    const cappedSocket = testState.sockets.at(-1)
    expect(cappedSocket).toBeDefined()
    await act(async () => {
      cappedSocket!.serverMessage(JSON.stringify({ type: 'ready' }))
      cappedSocket!.serverClose()
    })
    await advance(60_000)

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(6)
    expect(testState.sockets).toHaveLength(6)
    expect(rendered.container.textContent).toContain('Terminal connection was lost.')
    expect(rendered.container.textContent).toContain('Disconnected')

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(7)
    expect(testState.sockets).toHaveLength(7)
    expect(new URL(testState.sockets[6]!.url).searchParams.get('ticket')).toBe('7')

    await rendered.unmount()
  })

  it('does not send an uncommitted partial chunk cursor when reconnecting', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready', cursor: 'ready-cursor' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'partial-cursor' }))
      socket!.serverClose()
    })
    await advance(1000)

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(testState.sockets).toHaveLength(2)
    const reconnectUrl = new URL(testState.sockets[1]!.url)
    expect(reconnectUrl.searchParams.get('ticket')).toBe('2')
    expect(reconnectUrl.searchParams.get('cursor')).toBe('ready-cursor')

    await rendered.unmount()
  })

  it('lets a manual reconnect supersede an auto reconnect already waiting for terminal operations', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
      socket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
      socket!.serverClose()
    })
    await advance(1_000)

    expect(testState.terminalWriteCallbacks).toHaveLength(1)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)

    await act(async () => {
      testState.terminalWriteCallbacks.shift()?.()
      await Promise.resolve()
    })

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(testState.sockets).toHaveLength(2)
    expect(new URL(testState.sockets[1]!.url).searchParams.get('ticket')).toBe('2')

    await rendered.unmount()
  })

  it('lets the latest manual reconnect supersede earlier manual clicks waiting for terminal operations', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
      socket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
      await vi.advanceTimersByTimeAsync(16)
      socket!.serverMessage(JSON.stringify({ type: 'bogus' }))
    })

    expect(testState.terminalWriteCallbacks).toHaveLength(1)
    expect(rendered.container.textContent).toContain('Terminal protocol error.')

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())
    await act(async () => button!.click())

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)

    await act(async () => {
      testState.terminalWriteCallbacks.shift()?.()
      await Promise.resolve()
    })

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(testState.sockets).toHaveLength(2)
    expect(new URL(testState.sockets[1]!.url).searchParams.get('ticket')).toBe('2')

    await rendered.unmount()
  })

  it('unmount cancels reconnect timers and closes the socket', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    socket!.serverClose()
    await rendered.unmount()
    expect(socket!.close).toHaveBeenCalledOnce()

    await advance(60_000)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
    expect(testState.sockets).toHaveLength(1)
  })

  it('unmount cancels a reconnect waiting for buffered output', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]!
    await act(async () => {
      socket.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 1, cursor: 'pending' }))
      socket.serverMessage(new Uint8Array([65]).buffer)
      socket.serverClose()
    })
    await advance(1000)
    expect(rendered.container.textContent).toContain('Finishing buffered output')
    await rendered.unmount()
    await act(async () => testState.terminalWriteCallbacks.shift()?.())
    await advance(60_000)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
  })

  it('ignores an attach capability resolved after unmount', async () => {
    let resolve!: (value: { url: string }) => void
    testState.authenticatedApi.mintCodingSessionAttachCapability.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const rendered = await renderTerminal()
    await rendered.unmount()
    await act(async () => resolve({ url: 'https://terminal.example.test/attach' }))
    expect(testState.sockets).toHaveLength(0)
  })
})
