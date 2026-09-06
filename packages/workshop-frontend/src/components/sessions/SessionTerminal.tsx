import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuthenticatedApi } from '../../AuthContext'
import { useTheme } from '../../ThemeContext'
import { WorkshopButton } from '../WorkshopControls'
import type { CodingSessionRuntime, CodingSessionTerminalKind } from '@gadgets/workshop-shared/api'
import { MAX_CODING_SESSION_UPLOAD_BYTES } from '@gadgets/workshop-shared/coding-sessions'
import { OrderedTerminalOperationQueue, TerminalWriteBatcher } from './orderedTerminalOperations'

type PendingChunk = { byteLength: number; cursor: string }

const MAX_RECONNECT_ATTEMPTS = 5
const MAX_CURSOR_LENGTH = 1024
const RECONNECT_STABILITY_WINDOW_MS = 5_000
const MAX_FILES_PER_UPLOAD = 5

const hasFiles = (types: readonly string[]) => Array.from(types).includes('Files')

const TERMINAL_THEMES = {
  light: { background: '#ffffff', foreground: '#18181b', cursor: '#ff4801', selectionBackground: '#dbeafe' },
  dark: { background: '#111318', foreground: '#f4f4f5', cursor: '#ff4801', selectionBackground: '#3f3f46' },
} as const

export type SessionTerminalProps = {
  sessionId: string
  terminalKind?: CodingSessionTerminalKind
  runtime?: CodingSessionRuntime
  initialInput?: string
  onInitialInputSent?: () => void
  onSessionUnavailable?: () => void
}

export default function SessionTerminal({
  sessionId,
  terminalKind = 'opencode',
  runtime = 'opencode',
  initialInput,
  onInitialInputSent,
  onSessionUnavailable,
}: SessionTerminalProps) {
  const { authenticatedApi } = useAuthenticatedApi()
  const { resolvedThemeMode } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const reconnectRef = useRef<() => void>(() => {})
  const insertTextRef = useRef<(text: string) => boolean>(() => false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const runtimeRef = useRef(runtime)
  const followLatestRef = useRef<() => void>(() => {})
  runtimeRef.current = runtime
  const initialInputRef = useRef(initialInput)
  const onInitialInputSentRef = useRef(onInitialInputSent)
  initialInputRef.current = initialInput
  onInitialInputSentRef.current = onInitialInputSent
  const [state, setState] = useState<'connecting' | 'starting' | 'connected' | 'disconnected'>('connecting')
  const [interactive, setInteractive] = useState(false)
  const [error, setError] = useState<string>()
  const [uploadMessage, setUploadMessage] = useState<string>()
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const terminalLabel = terminalKind === 'shell' ? 'Shell' : runtime === 'pi' ? 'Pi' : runtime === 'prime-agent' ? 'Prime Agent' : 'OpenCode'

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setState('connecting')
    setInteractive(false)
    setError(undefined)
    let cancelled = false
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined
    let reconnectStabilityTimer: number | undefined
    let reconnectAttempts = 0
    let connectionGeneration = 0
    let reconnectRequestGeneration = 0
    let terminalExited = false
    let fatalProtocolError = false
    let cursor: string | undefined
    let pendingChunk: PendingChunk | undefined
    let resizeFrame: number | undefined
    let lastSize = ''
    let visibleOutputDetected = false
    let initialInputSent = false
    const inputEncoder = new TextEncoder()
    const terminalOperations = new OrderedTerminalOperationQueue()
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      scrollOnUserInput: true,
      allowProposedApi: false,
      theme: TERMINAL_THEMES[resolvedThemeMode],
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    fit.fit()

    const sendSize = (force = false) => {
      fit.fit()
      const size = `${terminal.cols}x${terminal.rows}`
      if ((!force && size === lastSize) || socket?.readyState !== WebSocket.OPEN) return
      lastSize = size
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
    }
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = undefined
        sendSize()
      })
    })
    resizeObserver.observe(host)

    const input = terminal.onData((data) => {
      if (socket?.readyState !== WebSocket.OPEN) return
      socket.send(inputEncoder.encode(data))
    })
    insertTextRef.current = (text) => {
      if (socket?.readyState !== WebSocket.OPEN) return false
      socket.send(inputEncoder.encode(text))
      terminal.focus()
      return true
    }
    followLatestRef.current = () => {
      terminal.scrollToBottom()
      if (terminalKind === 'opencode' && runtimeRef.current === 'prime-agent' &&
          socket?.readyState === WebSocket.OPEN) {
        // Prime Agent documents Ctrl+Shift+Down as its explicit "resume following output" command.
        socket.send(inputEncoder.encode('\x1b[1;6B'))
      }
    }

    const writeOutput = (bytes: Uint8Array, done: () => void) => {
      terminal.write(bytes, () => {
        if (!cancelled && terminalKind === 'opencode' && !visibleOutputDetected && terminalHasVisibleContent(terminal)) {
          visibleOutputDetected = true
          window.requestAnimationFrame(() => {
            if (!cancelled) setInteractive(true)
          })
        }
        done()
      })
    }
    const outputBatcher = new TerminalWriteBatcher(
      terminalOperations,
      writeOutput,
      (flush) => window.requestAnimationFrame(flush),
      (handle) => window.cancelAnimationFrame(handle),
    )

    const scheduleReconnect = (message: string) => {
      if (cancelled || terminalExited || reconnectTimer !== undefined) return
      if (reconnectStabilityTimer !== undefined) {
        window.clearTimeout(reconnectStabilityTimer)
        reconnectStabilityTimer = undefined
      }
      setState('disconnected')
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        setError(message)
        onSessionUnavailable?.()
        return
      }
      const delay = Math.min(1000 * 2 ** reconnectAttempts, 8000)
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        reconnectAttempts++
        const reconnectRequest = ++reconnectRequestGeneration
        outputBatcher.flush()
        void terminalOperations.whenIdle().then(() => {
          if (!cancelled && reconnectRequest === reconnectRequestGeneration) connect()
        })
      }, delay)
    }

    const connect = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (reconnectStabilityTimer !== undefined) window.clearTimeout(reconnectStabilityTimer)
      reconnectStabilityTimer = undefined
      const generation = ++connectionGeneration
      socket?.close()
      socket = undefined
      pendingChunk = undefined
      fatalProtocolError = false
      setState('connecting')
      authenticatedApi.mintCodingSessionAttachCapability(sessionId, terminalKind).then((capability) => {
        if (cancelled || generation !== connectionGeneration) return
        const url = new URL(capability.url, window.location.href)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        if (cursor) url.searchParams.set('cursor', cursor)
        const nextSocket = new WebSocket(url)
        socket = nextSocket
        lastSize = ''
        nextSocket.binaryType = 'arraybuffer'
        nextSocket.addEventListener('open', () => {
          if (cancelled || generation !== connectionGeneration) return
          setState('starting')
          sendSize()
        })
        nextSocket.addEventListener('message', (event) => {
          if (cancelled || generation !== connectionGeneration) return
          const failProtocol = () => {
            fatalProtocolError = true
            if (reconnectStabilityTimer !== undefined) {
              window.clearTimeout(reconnectStabilityTimer)
              reconnectStabilityTimer = undefined
            }
            setError('Terminal protocol error.')
            setState('disconnected')
            nextSocket.close()
          }
          if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data)
            if (!pendingChunk || bytes.byteLength !== pendingChunk.byteLength) {
              failProtocol()
              return
            }
            const chunk = pendingChunk
            outputBatcher.push(bytes, () => {
              if (!cancelled) cursor = chunk.cursor
            })
            if (!visibleOutputDetected) {
              setState('connected')
            }
            pendingChunk = undefined
            return
          }
          if (typeof event.data !== 'string') return
          try {
            const message = JSON.parse(event.data) as {
              type?: string
              byteLength?: number
              cursor?: unknown
              message?: string
              exit?: { code?: number }
            }
            if (pendingChunk && message.type !== 'chunk') {
              failProtocol()
              return
            }
            if (message.type === 'ready') {
              if (message.cursor !== undefined && !isTerminalCursor(message.cursor)) {
                failProtocol()
                return
              }
              const readyCursor = message.cursor
              outputBatcher.flush()
              terminalOperations.enqueue((done) => {
                if (!cancelled && readyCursor !== undefined) cursor = readyCursor
                done()
              })
              if (reconnectStabilityTimer !== undefined) window.clearTimeout(reconnectStabilityTimer)
              reconnectStabilityTimer = window.setTimeout(() => {
                reconnectStabilityTimer = undefined
                reconnectAttempts = 0
              }, RECONNECT_STABILITY_WINDOW_MS)
              setError(undefined)
              setState('connected')
              if (terminalKind === 'shell') setInteractive(true)
              sendSize()
              terminal.focus()
              const preparedInput = initialInputRef.current
              if (terminalKind === 'opencode' && preparedInput && !initialInputSent && nextSocket.readyState === WebSocket.OPEN) {
                // This handoff is intentionally best-effort and at-most-once for this mounted
                // terminal. The PTY protocol has no input acknowledgement, so never retry it on a
                // reconnect where a duplicate could start the same work twice.
                initialInputSent = true
                initialInputRef.current = undefined
                nextSocket.send(inputEncoder.encode(`${preparedInput}\r`))
                onInitialInputSentRef.current?.()
              }
            } else if (message.type === 'chunk' && typeof message.byteLength === 'number') {
              if (pendingChunk || !Number.isSafeInteger(message.byteLength) || message.byteLength < 0 ||
                  !isTerminalCursor(message.cursor)) {
                failProtocol()
                return
              }
              pendingChunk = { byteLength: message.byteLength, cursor: message.cursor }
            } else if (message.type === 'truncated') {
              if (message.cursor !== undefined && !isTerminalCursor(message.cursor)) {
                failProtocol()
                return
              }
              const truncatedCursor = message.cursor
              outputBatcher.flush()
              terminalOperations.enqueue((done) => {
                if (!cancelled) {
                  terminal.clear()
                  cursor = truncatedCursor
                }
                done()
              })
            } else if (message.type === 'error') {
              setError(message.message ?? 'Terminal error.')
            } else if (message.type === 'exit') {
              if (!isTerminalCursor(message.cursor)) {
                failProtocol()
                return
              }
              const exitCursor = message.cursor
              outputBatcher.flush()
              terminalOperations.enqueue((done) => {
                if (!cancelled) cursor = exitCursor
                done()
              })
              terminalExited = true
              setError(`Terminal exited${message.exit?.code === undefined ? '' : ` (${message.exit.code})`}.`)
              setState('disconnected')
              void terminalOperations.whenIdle().then(() => {
                if (!cancelled && generation === connectionGeneration && terminalExited) {
                  onSessionUnavailable?.()
                }
              })
            } else {
              failProtocol()
            }
          } catch {
            failProtocol()
          }
        })
        nextSocket.addEventListener('close', () => {
          if (!cancelled && generation === connectionGeneration) {
            if (reconnectStabilityTimer !== undefined) {
              window.clearTimeout(reconnectStabilityTimer)
              reconnectStabilityTimer = undefined
            }
            if (!terminalExited && !fatalProtocolError) {
              scheduleReconnect('Terminal connection was lost.')
            }
          }
        })
        nextSocket.addEventListener('error', () => {
          if (!cancelled && generation === connectionGeneration) {
            setError('Terminal connection failed.')
          }
        })
      }).catch((caught: unknown) => {
        if (!cancelled && generation === connectionGeneration) {
          scheduleReconnect(caught instanceof Error ? caught.message : 'Could not attach to terminal.')
        }
      })
    }

    reconnectRef.current = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (reconnectStabilityTimer !== undefined) window.clearTimeout(reconnectStabilityTimer)
      reconnectStabilityTimer = undefined
      connectionGeneration++
      socket?.close()
      socket = undefined
      reconnectAttempts = 0
      terminalExited = false
      setError(undefined)
      const reconnectRequest = ++reconnectRequestGeneration
      outputBatcher.flush()
      void terminalOperations.whenIdle().then(() => {
        if (!cancelled && reconnectRequest === reconnectRequestGeneration) connect()
      })
    }
    connect()

    return () => {
      cancelled = true
      outputBatcher.cancel()
      terminalOperations.cancel()
      resizeObserver.disconnect()
      reconnectRef.current = () => {}
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (reconnectStabilityTimer !== undefined) window.clearTimeout(reconnectStabilityTimer)
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame)
      input.dispose()
      socket?.close()
      terminal.dispose()
      terminalRef.current = null
      insertTextRef.current = () => false
      followLatestRef.current = () => {}
    }
  }, [authenticatedApi, onSessionUnavailable, sessionId, terminalKind]) // Theme and prepared input updates are applied without reconnecting below.


  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = TERMINAL_THEMES[resolvedThemeMode]
  }, [resolvedThemeMode])

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0 || uploading) return
    if (state !== 'connected') {
      setUploadMessage('Connect to the terminal before uploading files.')
      return
    }
    const selected = files.slice(0, MAX_FILES_PER_UPLOAD)
    const omittedCount = files.length - selected.length
    const oversized = selected.find((file) => file.size > MAX_CODING_SESSION_UPLOAD_BYTES)
    if (oversized) {
      setUploadMessage(`${oversized.name} is larger than 10 MiB.`)
      return
    }
    const empty = selected.find((file) => file.size === 0)
    if (empty) {
      setUploadMessage(`${empty.name} is empty.`)
      return
    }

    setUploading(true)
    setUploadMessage(`Uploading ${selected.length === 1 ? selected[0]!.name : `${selected.length} files`}…`)
    try {
      const results = []
      for (const file of selected) {
        results.push(await authenticatedApi.uploadCodingSessionFile({
          sessionId,
          filename: file.name,
          content: new Uint8Array(await file.arrayBuffer()),
        }))
      }
      const inserted = insertTextRef.current(results.map(({ path }) => quoteTerminalPath(path)).join(' '))
      const resultMessage = inserted
        ? `${results.length === 1 ? 'File' : 'Files'} uploaded and path${results.length === 1 ? '' : 's'} inserted.`
        : `${results.length === 1 ? 'File' : 'Files'} uploaded, but the terminal disconnected before insertion.`
      setUploadMessage(omittedCount > 0 ? `${resultMessage} ${omittedCount} more not uploaded.` : resultMessage)
    } catch (caught) {
      setUploadMessage(caught instanceof Error ? caught.message : 'Could not upload files.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-kumo-base">
      <div className="flex h-10 items-center justify-between border-b border-kumo-line px-3 text-[12px] text-kumo-subtle">
        <span
          aria-live="polite"
          title="PTY connectivity only. Agent running or idle state is shown inside the terminal."
          className="flex items-center gap-1.5"
        >
          {state === 'connected' && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-kumo-success" />}
          {state === 'connected' ? 'Live connection' : state === 'starting' ? 'Starting terminal…' : state === 'connecting' ? 'Connecting…' : 'Disconnected'}
          {state === 'connected' && <span className="sr-only">PTY connectivity only; agent running or idle state is shown inside the terminal.</span>}
        </span>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            aria-label="Upload files to coding session"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
              void uploadFiles(files)
            }}
          />
          <WorkshopButton
            title="Upload files to the coding session and insert their paths into the terminal"
            disabled={state !== 'connected' || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? 'Uploading…' : 'Upload file'}
          </WorkshopButton>
          {state === 'connected' && (
            <WorkshopButton
              title={runtime === 'prime-agent' && terminalKind === 'opencode'
                ? "Sends Prime Agent's documented Ctrl+Shift+Down command to resume following output"
                : 'Scroll to the latest terminal output'}
              onClick={() => followLatestRef.current()}
            >
              {runtime === 'prime-agent' && terminalKind === 'opencode'
                ? 'Resume Prime Agent output'
                : 'Follow latest'}
            </WorkshopButton>
          )}
          {state === 'disconnected' && (
            <WorkshopButton onClick={() => reconnectRef.current()}>
              Reconnect
            </WorkshopButton>
          )}
        </div>
      </div>
      {error && <div className="border-b border-kumo-danger/20 bg-kumo-danger/10 px-3 py-2 text-xs text-kumo-danger">{error}</div>}
      {uploadMessage && <div role="status" aria-live="polite" className="border-b border-kumo-line px-3 py-2 text-xs text-kumo-subtle">{uploadMessage}</div>}
      <div
        className="relative min-h-0 flex-1"
        onPasteCapture={(event) => {
          const files = Array.from(event.clipboardData.files)
          if (files.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          void uploadFiles(files)
        }}
        onDragEnter={(event) => {
          if (!hasFiles(event.dataTransfer.types)) return
          event.preventDefault()
          dragDepthRef.current++
          setDragActive(true)
        }}
        onDragOver={(event) => {
          if (!hasFiles(event.dataTransfer.types)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(event) => {
          if (!hasFiles(event.dataTransfer.types)) return
          event.preventDefault()
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
          if (dragDepthRef.current === 0) setDragActive(false)
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files)
          if (files.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          dragDepthRef.current = 0
          setDragActive(false)
          void uploadFiles(files)
        }}
      >
        {dragActive && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-kumo-accent bg-kumo-base/90 text-sm font-medium text-kumo-default">
            Drop files to upload and insert their paths
          </div>
        )}
        {!interactive && state !== 'disconnected' && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-kumo-base/90 text-xs text-kumo-subtle">
            {state === 'connecting' ? 'Connecting to the sandbox…' : `Starting ${terminalLabel}…`}
          </div>
        )}
        <div ref={hostRef} className="h-full min-h-0" aria-label={`${terminalLabel} session terminal`} />
      </div>
    </section>
  )
}

function quoteTerminalPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

function terminalHasVisibleContent(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active
  const firstLine = Math.max(0, buffer.viewportY)
  const lastLine = Math.min(buffer.length, firstLine + terminal.rows)
  for (let lineIndex = firstLine; lineIndex < lastLine; lineIndex++) {
    if (buffer.getLine(lineIndex)?.translateToString(true).trim()) return true
  }
  return false
}

function isTerminalCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CURSOR_LENGTH
}
