import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowClockwise, CircleNotch, PaperPlaneRight, Paperclip, Stop, Wrench, X } from '@phosphor-icons/react'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { getWorkshopRuntime } from '../../runtime'
import { WorkshopButton, WorkshopIconButton } from '../WorkshopControls'

const POLL_INTERVAL_MS = 4_000
const EXPIRY_REFRESH_WINDOW_MS = 10_000
// Total mint budget includes auth/policy startup before the backend's readiness-only wait.
const CAPABILITY_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const MAX_MESSAGE_COUNT = 80
const MAX_TEXT_LENGTH = 16_000
const MAX_PAYLOAD_LENGTH = 4_000
const MAX_TOOL_COUNT = 12
const MAX_IMAGE_ATTACHMENT_COUNT = 4
const MAX_IMAGE_ATTACHMENT_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024
const SAFE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const NOTIFICATION_BODY_MAX_LENGTH = 120

type Capability = { url: string; expiresAt: Date }
type MetadataField = 'diffText' | 'todoText' | 'mcpText'
type MetadataState = Partial<Record<MetadataField, { loading: boolean; error?: string }>>

type OpenCodeSession = {
  id: string
  title: string
  updatedAt: number
  rawStatus?: string
}

type OpenCodeMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  tools: OpenCodeTool[]
}

type OpenCodeTool = {
  id: string
  name: string
  state?: string
  input?: string
  output?: string
  error?: string
  metadata?: string
}

type OpenCodeCommand = {
  name: string
  description?: string
}

type OpenCodeFilePart = {
  type: 'file'
  mime: string
  filename: string
  url: string
}

type OpenCodeTextPart = {
  type: 'text'
  text: string
}

type OpenCodePromptPart = OpenCodeTextPart | OpenCodeFilePart

type ImageAttachment = OpenCodeFilePart & {
  id: string
  size: number
  status: 'loading' | 'ready' | 'error'
  error?: string
}

type WorkbenchSnapshot = {
  sessions: OpenCodeSession[]
  selected?: OpenCodeSession
  messages: OpenCodeMessage[]
  running: boolean
  statusText: string
  diffText?: string
  todoText?: string
  mcpText?: string
}

type PendingTurnNotification = {
  id: number
  openCodeSessionId: string
  assistantMessageBaseline: number
  observedRunning: boolean
  notified: boolean
}

type Props = {
  sessionId: string
  sessionTitle: string
  initialInput?: string
  /** Consume the parent's queued input once attempted, not once acknowledged. */
  onInitialInputSent?: () => void
  onSessionUnavailable?: () => void
  surface?: 'agent' | 'changes'
}

function hasExpectedImageSignature(mime: string, bytes: Uint8Array): boolean {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'image/png') return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
  return mime === 'image/webp' && bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
}

function hasExpectedImageDataUrl(mime: string, url: string): boolean {
  const prefix = `data:${mime};base64,`
  if (!url.startsWith(prefix)) return false
  try {
    const decoded = atob(url.slice(prefix.length, prefix.length + 16))
    return hasExpectedImageSignature(mime, Uint8Array.from(decoded, (character) => character.charCodeAt(0)))
  } catch {
    return false
  }
}

const MARKDOWN_COMPONENTS: Components = {
  a({ href, children, ...props }) {
    return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>
  },
  pre({ children, ...props }) {
    return <pre {...props} className="overflow-x-auto rounded-lg bg-kumo-tint p-3 text-[12px] leading-5">{children}</pre>
  },
  code({ children, className, ...props }) {
    return <code {...props} className={`${className ?? ''} rounded bg-kumo-tint px-1 py-0.5 text-[12px]`}>{children}</code>
  },
  img({ alt }) {
    return <span className="text-kumo-subtle">[Image blocked{alt ? `: ${alt}` : ''}]</span>
  },
}

export default function OpenCodeWorkbench(props: Props) {
  const { authenticatedApi } = useAuthenticatedApi()
  return <OpenCodeWorkbenchInner {...props} authenticatedApi={authenticatedApi} />
}

export function OpenCodeWorkbenchInner({
  authenticatedApi,
  sessionId,
  sessionTitle,
  initialInput,
  onInitialInputSent,
  onSessionUnavailable,
  surface = 'agent',
}: Props & { authenticatedApi: Pick<AuthenticatedApi, 'mintCodingSessionOpenCodeCapability'> }) {
  const capabilityRef = useRef<Capability | undefined>(undefined)
  const capabilityPromiseRef = useRef<Promise<Capability> | undefined>(undefined)
  const abortsRef = useRef<Set<AbortController>>(new Set())
  const mountedRef = useRef(true)
  const requestEpochRef = useRef(0)
  const refreshSequenceRef = useRef(0)
  const selectedOpenCodeSessionIdRef = useRef<string | undefined>(undefined)
  const initialSendKeyRef = useRef<string | undefined>(undefined)
  const pendingTurnNotificationRef = useRef<PendingTurnNotification | undefined>(undefined)
  const turnNotificationIdRef = useRef(0)
  const sendingRef = useRef(false)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>({ sessions: [], messages: [], running: false, statusText: 'Connecting…' })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [commands, setCommands] = useState<OpenCodeCommand[]>([])
  const [commandsLoaded, setCommandsLoaded] = useState(false)
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [commandMenuSuppressedToken, setCommandMenuSuppressedToken] = useState<string>()
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0)
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string>()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const metadataRequestsRef = useRef(new Map<MetadataField, { key: string }>())
  const [metadata, setMetadata] = useState<MetadataState>({})
  const [statusReady, setStatusReady] = useState(false)
  const [startupPhase, setStartupPhase] = useState('Connecting to the coding session…')
  const draftSessionIdRef = useRef(sessionId)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestEpochRef.current += 1
      for (const controller of abortsRef.current) controller.abort()
      abortsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    // Activity re-creates effects on resume; only a different session discards local input.
    if (draftSessionIdRef.current === sessionId) return
    draftSessionIdRef.current = sessionId
    selectedOpenCodeSessionIdRef.current = undefined
    initialSendKeyRef.current = undefined
    setPrompt('')
    setAttachments([])
    setAttachmentError(undefined)
  }, [sessionId])

  useEffect(() => {
    requestEpochRef.current += 1
    refreshSequenceRef.current += 1
    for (const controller of abortsRef.current) controller.abort()
    abortsRef.current.clear()
    capabilityRef.current = undefined
    capabilityPromiseRef.current = undefined
    pendingTurnNotificationRef.current = undefined
    sendingRef.current = false
    setSnapshot({ sessions: [], messages: [], running: false, statusText: 'Connecting…' })
    setLoading(true)
    setRefreshing(false)
    setSending(false)
    setAborting(false)
    setStatusReady(false)
    setStartupPhase('Connecting to the coding session…')
    metadataRequestsRef.current.clear()
    setMetadata({})
    setError(undefined)
    setCommands([])
    setCommandsLoaded(false)
    setCommandMenuOpen(false)
    setCommandMenuSuppressedToken(undefined)
    setHighlightedCommandIndex(0)
  }, [authenticatedApi, sessionId])

  const mintCapability = useCallback(async (expectedEpoch = requestEpochRef.current) => {
    if (expectedEpoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
    const existing = capabilityPromiseRef.current
    if (existing) return existing
    const controller = new AbortController()
    abortsRef.current.add(controller)
    const minting = withTimeout(
      authenticatedApi.mintCodingSessionOpenCodeCapability(sessionId),
      CAPABILITY_TIMEOUT_MS,
      'OpenCode took too long to start. Retry, or restart the coding session if the problem continues.',
      controller.signal,
    ).then((minted) => {
      if (expectedEpoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
      const url = new URL(minted.url, window.location.href)
      if (url.origin !== window.location.origin) throw new Error('OpenCode workbench capability was not same-origin.')
      const capability = { url: url.toString(), expiresAt: new Date(minted.expiresAt) }
      capabilityRef.current = capability
      return capability
    }).finally(() => {
      abortsRef.current.delete(controller)
      if (capabilityPromiseRef.current === minting) capabilityPromiseRef.current = undefined
    })
    capabilityPromiseRef.current = minting
    return minting
  }, [authenticatedApi, sessionId])

  const ensureCapability = useCallback(async (expectedEpoch: number) => {
    if (expectedEpoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
    const current = capabilityRef.current
    if (current && current.expiresAt.getTime() - Date.now() > EXPIRY_REFRESH_WINDOW_MS) return current
    return mintCapability(expectedEpoch)
  }, [mintCapability])

  const fetchJson = useCallback(async (path: string, init: RequestInit = {}, retry = true): Promise<unknown> => {
    const epoch = requestEpochRef.current
    const capability = await ensureCapability(epoch)
    if (epoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      controller.abort(timeoutError('OpenCode did not respond in time. Retry the request.'))
    }, REQUEST_TIMEOUT_MS)
    abortsRef.current.add(controller)
    try {
      const response = await fetch(new URL(path.replace(/^\//, ''), capability.url), {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        redirect: 'error',
      })
      if (!mountedRef.current || epoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
      if (response.status === 403 && retry) {
        if (epoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
        capabilityRef.current = undefined
        return fetchJson(path, init, false)
      }
      if (epoch === requestEpochRef.current && (response.status === 403 || response.status === 410)) onSessionUnavailable?.()
      if (!response.ok) throw new Error(`OpenCode request failed (${response.status}).`)
      if (response.status === 204) return undefined
      const text = await response.text()
      if (!mountedRef.current || epoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
      if (!text) return undefined
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    } finally {
      window.clearTimeout(timeout)
      abortsRef.current.delete(controller)
    }
  }, [ensureCapability, onSessionUnavailable])

  const refreshWorkbench = useCallback(async (options: { quiet?: boolean } = {}) => {
    const epoch = requestEpochRef.current
    const sequence = ++refreshSequenceRef.current
    const isCurrent = () => mountedRef.current && epoch === requestEpochRef.current && sequence === refreshSequenceRef.current
    setRefreshing(true)
    setStatusReady(false)
    setError(undefined)
    try {
      if (!options.quiet) setStartupPhase('Connecting to the coding session…')
      await ensureCapability(epoch)
      if (!isCurrent()) return
      setStartupPhase('Finding the OpenCode session…')
      const sessionListJson = await fetchJson('/session')
      if (!isCurrent()) return
      let sessions = parseSessions(sessionListJson)
      let selected = selectSession(sessions, selectedOpenCodeSessionIdRef.current)
      if (!selected) {
        setStartupPhase('Creating the OpenCode session…')
        const created = await fetchJson('/session', {
          method: 'POST',
          body: JSON.stringify({ title: sessionTitle || 'Odie coding session' }),
        })
        if (!isCurrent()) return
        const createdSession = parseSession(created)
        if (createdSession) {
          selected = createdSession
          sessions = [createdSession, ...sessions.filter((item) => item.id !== createdSession.id)]
        }
      }
      const selectedId = selected?.id
      if (!selectedId) throw new Error('Could not select an OpenCode session.')
      const changed = selectedOpenCodeSessionIdRef.current !== selectedId
      selectedOpenCodeSessionIdRef.current = selectedId
      setSnapshot((current) => ({ ...current, sessions, selected, ...(changed ? { messages: [], diffText: undefined, todoText: undefined, mcpText: undefined } : {}) }))
      setStartupPhase('Reading the transcript…')

      // Metadata reads neither create a session nor establish whether it is safe to send.
      // Keep one read per field/selection in flight across polls, so slow reads cannot starve.
      for (const [field, path, label] of [
        ['diffText', `/session/${selectedId}/diff`, 'Diff'],
        ['todoText', `/session/${selectedId}/todo`, 'Todo'],
        ['mcpText', '/mcp', 'MCP'],
      ] as const) {
        const key = `${epoch}:${selectedId}`
        if (metadataRequestsRef.current.get(field)?.key === key) continue
        const request = { key }
        metadataRequestsRef.current.set(field, request)
        const metadataCurrent = () => mountedRef.current && epoch === requestEpochRef.current && selectedOpenCodeSessionIdRef.current === selectedId && metadataRequestsRef.current.get(field) === request
        setMetadata((current) => ({ ...current, [field]: { loading: true } }))
        void fetchJson(path).then((data) => {
          if (!metadataCurrent()) return
          setSnapshot((current) => ({ ...current, [field]: summarizeUnknown(data, MAX_PAYLOAD_LENGTH) }))
          setMetadata((current) => ({ ...current, [field]: { loading: false } }))
        }).catch(() => {
          if (metadataCurrent()) setMetadata((current) => ({ ...current, [field]: { loading: false, error: `${label} unavailable. Will retry automatically.` } }))
        }).finally(() => {
          if (metadataRequestsRef.current.get(field) === request) metadataRequestsRef.current.delete(field)
        })
      }

      // Publish the transcript immediately, even if the safety-critical status read is slow.
      await Promise.all([
        fetchJson(`/session/${selectedId}/message`).then((messages) => {
          if (!isCurrent()) return
          setSnapshot((current) => ({ ...current, messages: parseMessages(messages) }))
          setLoading(false)
          setStartupPhase('Checking whether OpenCode is ready…')
        }),
        fetchJson('/session/status').then((status) => {
          if (!isCurrent()) return
          if (!isTrustworthyStatus(status, selected)) throw new Error('OpenCode status is unavailable. Retry before sending.')
          setSnapshot((current) => ({ ...current, running: parseRunning(status, selected), statusText: summarizeStatus(status, selected) }))
          setStatusReady(true)
        }),
      ])
    } catch (caught) {
      if (!mountedRef.current || epoch !== requestEpochRef.current || sequence !== refreshSequenceRef.current || isAbortError(caught)) return
      setLoading(false)
      setError(safeWorkbenchError(caught))
    } finally {
      if (mountedRef.current && epoch === requestEpochRef.current && sequence === refreshSequenceRef.current) setRefreshing(false)
    }
  }, [ensureCapability, fetchJson, sessionTitle])

  const loadCommands = useCallback(async () => {
    if (commandsLoaded) return
    const epoch = requestEpochRef.current
    const isCurrent = () => mountedRef.current && epoch === requestEpochRef.current
    try {
      const commandJson = await fetchJson('/command')
      if (!isCurrent()) return
      setCommands(parseCommands(commandJson))
    } catch {
      if (!isCurrent()) return
      setCommands([])
    } finally {
      if (isCurrent()) setCommandsLoaded(true)
    }
  }, [commandsLoaded, fetchJson])

  useEffect(() => {
    let timer: number | undefined
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      void refreshWorkbench({ quiet: true }).finally(() => {
        if (!cancelled) timer = window.setTimeout(tick, POLL_INTERVAL_MS)
      })
    }
    void refreshWorkbench().finally(() => {
      if (!cancelled) timer = window.setTimeout(tick, POLL_INTERVAL_MS)
    })
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refreshWorkbench])

  useEffect(() => {
    const node = transcriptRef.current
    if (!node) return
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    if (distanceFromBottom < 160) node.scrollTop = node.scrollHeight
  }, [snapshot.messages])

  const commandQuery = prompt.startsWith('/') ? prompt.slice(1).split(/\s/, 1)[0].toLowerCase() : ''
  const filteredCommands = useMemo(() => {
    if (!prompt.startsWith('/')) return []
    const list = commandQuery
      ? commands.filter((command) => command.name.toLowerCase().includes(commandQuery))
      : commands
    return list.slice(0, 8)
  }, [commandQuery, commands, prompt])

  useEffect(() => {
    if (!prompt.startsWith('/')) {
      setCommandMenuOpen(false)
      setCommandMenuSuppressedToken(undefined)
      return
    }
    const token = prompt.slice(1).split(/\s/, 1)[0]
    if (commandMenuSuppressedToken && token === commandMenuSuppressedToken) {
      setCommandMenuOpen(false)
      return
    }
    if (commandMenuSuppressedToken && token !== commandMenuSuppressedToken) setCommandMenuSuppressedToken(undefined)
    setCommandMenuOpen(true)
    setHighlightedCommandIndex(0)
    void loadCommands()
  }, [commandMenuSuppressedToken, loadCommands, prompt])

  useEffect(() => {
    setHighlightedCommandIndex((current) => Math.min(current, Math.max(0, filteredCommands.length - 1)))
  }, [filteredCommands.length])

  const readyAttachments = attachments.filter((attachment) => attachment.status === 'ready')
  const attachmentsLoading = attachments.some((attachment) => attachment.status === 'loading')
  const canSend = Boolean(snapshot.selected) && statusReady && !loading && !refreshing && !sending && !snapshot.running && !attachmentsLoading && !error && (Boolean(prompt.trim()) || readyAttachments.length > 0)

  const addImageFiles = useCallback((fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    setAttachmentError(undefined)
    const available = MAX_IMAGE_ATTACHMENT_COUNT - attachments.length
    if (available <= 0) {
      setAttachmentError(`Attach up to ${MAX_IMAGE_ATTACHMENT_COUNT} images.`)
      return
    }
    const accepted = files.slice(0, available)
    if (files.length > accepted.length) setAttachmentError(`Only ${MAX_IMAGE_ATTACHMENT_COUNT} images can be attached.`)
    let totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
    for (const file of accepted) {
      if (!SAFE_IMAGE_MIME_TYPES.has(file.type)) {
        setAttachmentError(`${file.name} must be a PNG, JPEG, or WebP image.`)
        continue
      }
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        setAttachmentError(`${file.name} is too large. Images must be ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)} or smaller.`)
        continue
      }
      if (totalBytes + file.size > MAX_TOTAL_IMAGE_ATTACHMENT_BYTES) {
        setAttachmentError(`Attachments must total ${formatBytes(MAX_TOTAL_IMAGE_ATTACHMENT_BYTES)} or less.`)
        continue
      }
      totalBytes += file.size
      const id = `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
      const loadingAttachment: ImageAttachment = {
        id,
        type: 'file',
        mime: file.type || 'application/octet-stream',
        filename: file.name || 'image',
        url: '',
        size: file.size,
        status: 'loading',
      }
      setAttachments((current) => [...current, loadingAttachment])
      const reader = new FileReader()
      reader.addEventListener('load', () => {
        const url = typeof reader.result === 'string' ? reader.result : ''
        const valid = hasExpectedImageDataUrl(file.type, url)
        if (!valid) setAttachmentError(`${file.name} does not contain valid ${file.type.replace('image/', '').toUpperCase()} image data.`)
        setAttachments((current) => current.map((attachment) => attachment.id === id ? {
          ...attachment,
          url: valid ? url : '',
          status: valid ? 'ready' : 'error',
          error: valid ? undefined : 'Image data does not match its file type.',
        } : attachment))
      })
      reader.addEventListener('error', () => {
        setAttachments((current) => current.map((attachment) => attachment.id === id ? { ...attachment, status: 'error', error: 'Could not read image.' } : attachment))
      })
      reader.readAsDataURL(file)
    }
  }, [attachments])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }, [])

  const chooseCommand = useCallback((command: OpenCodeCommand) => {
    const rest = prompt.replace(/^\/\S*/, '').replace(/^\s+/, '')
    setPrompt(`/${command.name}${rest ? ` ${rest}` : ' '}`)
    setCommandMenuOpen(false)
    setCommandMenuSuppressedToken(command.name)
  }, [prompt])

  const sendPrompt = useCallback(async (text: string, options: { fromInitialInput?: boolean; attachments?: OpenCodeFilePart[] } = {}) => {
    const epoch = requestEpochRef.current
    const selectedId = selectedOpenCodeSessionIdRef.current
    const trimmed = text.trim()
    const fileParts = options.attachments ?? []
    if (!mountedRef.current || !selectedId || !statusReady || loading || refreshing || error || (!trimmed && fileParts.length === 0) || sendingRef.current || snapshot.running) return
    sendingRef.current = true
    const parts: OpenCodePromptPart[] = [...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []), ...fileParts]
    const command = parseCommandPrompt(trimmed)
    setSending(true)
    setError(undefined)
    try {
      const request = fetchJson(command ? `/session/${selectedId}/command` : `/session/${selectedId}/prompt_async`, {
        method: 'POST',
        body: JSON.stringify(command ? { command: command.command, arguments: command.arguments, parts } : { parts }),
      })
      // Consume before awaiting acknowledgement: navigation must not replay an
      // attempted request whose response was lost after the server accepted it.
      if (options.fromInitialInput) onInitialInputSent?.()
      await request
      if (epoch !== requestEpochRef.current || selectedOpenCodeSessionIdRef.current !== selectedId) return
      if (!options.fromInitialInput) {
        pendingTurnNotificationRef.current = {
          id: ++turnNotificationIdRef.current,
          openCodeSessionId: selectedId,
          assistantMessageBaseline: countAssistantMessages(snapshot.messages),
          observedRunning: false,
          notified: false,
        }
      }
      if (!options.fromInitialInput) setPrompt('')
      if (!options.fromInitialInput) setAttachments([])
      if (!options.fromInitialInput) setAttachmentError(undefined)
      setCommandMenuOpen(false)
      await refreshWorkbench({ quiet: true })
    } catch (caught) {
      if (epoch === requestEpochRef.current && !isAbortError(caught)) {
        if (!options.fromInitialInput) pendingTurnNotificationRef.current = undefined
        // A timeout/transport failure can follow acceptance. Retain the attempted
        // initial-input key: refreshing must not silently replay side effects.
        if (options.fromInitialInput) setPrompt((current) => current || text)
        setError(caught instanceof Error ? caught.message : 'Could not send prompt.')
      }
    } finally {
      if (epoch === requestEpochRef.current) sendingRef.current = false
      if (mountedRef.current && epoch === requestEpochRef.current) setSending(false)
    }
  }, [error, loading, refreshing, statusReady, fetchJson, onInitialInputSent, refreshWorkbench, snapshot.messages, snapshot.running])

  const submitComposer = useCallback(() => {
    if (!mountedRef.current || !canSend) return
    void getWorkshopRuntime().requestNotificationPermission()
    void sendPrompt(prompt, { attachments: readyAttachments.map(({ type, mime, filename, url }) => ({ type, mime, filename, url })) })
  }, [canSend, prompt, readyAttachments, sendPrompt])

  useEffect(() => {
    const pending = pendingTurnNotificationRef.current
    if (!pending || pending.notified) return
    if (error || aborting) {
      pendingTurnNotificationRef.current = undefined
      return
    }
    if (snapshot.selected?.id !== pending.openCodeSessionId) {
      pendingTurnNotificationRef.current = undefined
      return
    }
    if (snapshot.running) {
      pending.observedRunning = true
      return
    }
    if (!statusReady || refreshing) return
    const assistantCount = countAssistantMessages(snapshot.messages)
    if (!pending.observedRunning && assistantCount <= pending.assistantMessageBaseline) return
    pending.notified = true
    void getWorkshopRuntime().sendNotification({
      title: 'Agent turn complete',
      body: boundedTurnNotificationBody(sessionTitle || snapshot.selected?.title || 'Coding session'),
    })
  }, [aborting, error, refreshing, statusReady, sessionTitle, snapshot.messages, snapshot.running, snapshot.selected])

  const onComposerKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing) return
    if (commandMenuOpen && filteredCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlightedCommandIndex((current) => (current + 1) % filteredCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlightedCommandIndex((current) => (current - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault()
        chooseCommand(filteredCommands[highlightedCommandIndex] ?? filteredCommands[0])
        return
      }
    }
    if (commandMenuOpen && event.key === 'Escape') {
      event.preventDefault()
      setCommandMenuOpen(false)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitComposer()
    }
  }, [chooseCommand, commandMenuOpen, filteredCommands, highlightedCommandIndex, submitComposer])

  const onComposerPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault()
    void addImageFiles(files)
  }, [addImageFiles])

  useEffect(() => {
    const input = initialInput
    if (surface !== 'agent' || !input || error || loading || !statusReady || !snapshot.selected || snapshot.running || refreshing || sending) return
    if (selectedOpenCodeSessionIdRef.current !== snapshot.selected.id) return
    const key = `${sessionId}:${snapshot.selected.id}:${input}`
    if (initialSendKeyRef.current === key) return
    initialSendKeyRef.current = key
    void sendPrompt(input, { fromInitialInput: true })
  }, [error, loading, statusReady, initialInput, refreshing, sending, sessionId, sendPrompt, snapshot.running, snapshot.selected, surface])

  const abortOpenCodeSession = useCallback(async () => {
    const epoch = requestEpochRef.current
    const selectedId = selectedOpenCodeSessionIdRef.current
    if (!selectedId || aborting) return
    setAborting(true)
    setError(undefined)
    try {
      await fetchJson(`/session/${selectedId}/abort`, { method: 'POST', body: '{}' })
      if (!mountedRef.current || epoch !== requestEpochRef.current || selectedOpenCodeSessionIdRef.current !== selectedId) return
      pendingTurnNotificationRef.current = undefined
      await refreshWorkbench({ quiet: true })
    } catch (caught) {
      if (epoch === requestEpochRef.current && !isAbortError(caught)) setError(caught instanceof Error ? caught.message : 'Could not abort OpenCode session.')
    } finally {
      if (mountedRef.current && epoch === requestEpochRef.current) setAborting(false)
    }
  }, [aborting, fetchJson, refreshWorkbench])

  const selectedLabel = snapshot.selected?.title ?? 'OpenCode session'
  const sessionOptions = snapshot.sessions.slice(0, 20)

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-kumo-tint/30" aria-label="OpenCode workbench">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:grid lg:grid-cols-[minmax(0,1fr)_280px] lg:overflow-hidden">
        <main className="min-h-[28rem] min-w-0 flex-1 rounded-xl border border-kumo-line bg-kumo-base lg:min-h-0" aria-label={surface === 'changes' ? 'OpenCode changes' : `${selectedLabel} transcript`}>
          <div className="flex min-h-0 h-full flex-col">
            <div className="flex min-h-10 min-w-0 items-center gap-2 border-b border-kumo-line px-3">
              <div className="min-w-0 flex-1">
                {sessionOptions.length > 1 ? (
                  <select
                    aria-label="OpenCode transcript"
                    className="max-w-full rounded border-0 bg-transparent p-0 text-[13px] font-semibold text-kumo-default outline-none"
                    value={snapshot.selected?.id ?? ''}
                    onChange={(event) => {
                      const selected = sessionOptions.find((session) => session.id === event.currentTarget.value)
                      if (!selected) return
                      pendingTurnNotificationRef.current = undefined
                      selectedOpenCodeSessionIdRef.current = selected.id
                      setLoading(true)
                      setStatusReady(false)
                      setSnapshot((current) => ({
                        ...current,
                        selected,
                        messages: [],
                        running: false,
                        statusText: 'Loading transcript…',
                        diffText: undefined,
                        todoText: undefined,
                        mcpText: undefined,
                      }))
                      void refreshWorkbench()
                    }}
                  >
                    {sessionOptions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
                  </select>
                ) : <div className="truncate text-[13px] font-semibold text-kumo-default">{selectedLabel}</div>}
                <div className="truncate text-[11px] text-kumo-subtle" role="status">{refreshing ? startupPhase : snapshot.statusText}</div>
              </div>
              {refreshing && <CircleNotch size={13} className="animate-spin text-kumo-subtle" aria-label="Refreshing" />}
              <WorkshopButton aria-label="Refresh OpenCode" disabled={refreshing} onClick={() => void refreshWorkbench()}><ArrowClockwise size={13} /> Refresh</WorkshopButton>
              {snapshot.running && <WorkshopButton aria-label="Abort OpenCode session" disabled={aborting} onClick={() => void abortOpenCodeSession()}><Stop size={13} /> Abort</WorkshopButton>}
            </div>
            {error && (
              <div role="alert" className="flex items-center gap-3 border-b border-kumo-danger/20 bg-kumo-danger-tint px-3 py-2 text-xs text-kumo-danger">
                <span className="min-w-0 flex-1">{error}</span>
                <WorkshopButton disabled={refreshing} onClick={() => void refreshWorkbench()}>Retry</WorkshopButton>
              </div>
            )}
            {surface === 'changes' ? (
              <ChangesPane diffText={metadata.diffText?.error ?? snapshot.diffText} todoText={metadata.todoText?.error ?? snapshot.todoText} diffLoading={metadata.diffText?.loading ?? loading} todoLoading={metadata.todoText?.loading ?? loading} />
            ) : (
              <>
                <div ref={transcriptRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
                  {loading ? <EmptyState title="Loading OpenCode…" body={startupPhase} /> : null}
                  {!loading && !error && snapshot.messages.length === 0 ? <EmptyState title="Ready for instructions" body="Send a prompt to start this structured OpenCode session." /> : null}
                  <div className="min-w-0 space-y-3">
                    {snapshot.messages.map((message) => <MessageCard key={message.id} message={message} />)}
                    {(snapshot.running || sending) && <WorkingIndicator />}
                  </div>
                </div>
                <form className="shrink-0 border-t border-kumo-line p-3" onSubmit={(event: FormEvent) => { event.preventDefault(); submitComposer() }}>
                  <label className="sr-only" htmlFor="opencode-prompt">Prompt OpenCode</label>
                  {attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2" aria-label="Image attachments">
                      {attachments.map((attachment) => (
                        <div key={attachment.id} className="flex max-w-full items-center gap-2 rounded-lg border border-kumo-line bg-kumo-tint px-2 py-1 text-[11px] text-kumo-default">
                          {attachment.url ? <img src={attachment.url} alt="" className="h-8 w-8 rounded object-cover" /> : <span className="flex h-8 w-8 items-center justify-center rounded bg-kumo-base"><CircleNotch size={13} className="animate-spin" /></span>}
                          <span className="max-w-40 truncate">{attachment.filename}</span>
                          <span className={attachment.status === 'error' ? 'text-kumo-danger' : 'text-kumo-subtle'}>{attachment.status === 'loading' ? 'Reading…' : attachment.status === 'error' ? attachment.error : formatBytes(attachment.size)}</span>
                          <WorkshopIconButton aria-label={`Remove ${attachment.filename}`} className="!h-6 !w-6" onClick={() => removeAttachment(attachment.id)}><X size={12} /></WorkshopIconButton>
                        </div>
                      ))}
                    </div>
                  )}
                  {attachmentError && <div role="alert" className="mb-2 text-xs text-kumo-danger">{attachmentError}</div>}
                  <div className="relative">
                  <textarea
                    id="opencode-prompt"
                    className="max-h-40 min-h-20 w-full resize-y rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default outline-none focus:border-kumo-brand"
                    value={prompt}
                    disabled={loading || sending || snapshot.running || !snapshot.selected}
                    placeholder="Ask OpenCode to inspect, edit, test, or explain…"
                    onChange={(event) => setPrompt(event.currentTarget.value)}
                    onKeyDown={onComposerKeyDown}
                    onCompositionStart={() => { composingRef.current = true }}
                    onCompositionEnd={() => { composingRef.current = false }}
                    onPaste={onComposerPaste}
                    aria-controls={commandMenuOpen && filteredCommands.length > 0 ? 'opencode-command-suggestions' : undefined}
                    aria-expanded={commandMenuOpen && filteredCommands.length > 0}
                  />
                  {commandMenuOpen && prompt.startsWith('/') && (
                    <div id="opencode-command-suggestions" role="listbox" aria-label="OpenCode slash commands" className="absolute bottom-full mb-2 max-h-64 w-full overflow-auto rounded-xl border border-kumo-line bg-kumo-base p-1 shadow-lg">
                      {!commandsLoaded ? <div className="px-3 py-2 text-xs text-kumo-subtle">Loading commands…</div> : filteredCommands.length === 0 ? <div className="px-3 py-2 text-xs text-kumo-subtle">No matching commands.</div> : filteredCommands.map((command, index) => (
                        <button
                          key={command.name}
                          type="button"
                          role="option"
                          aria-selected={index === highlightedCommandIndex}
                          className={`block w-full rounded-lg px-3 py-2 text-left text-xs ${index === highlightedCommandIndex ? 'bg-kumo-fill text-kumo-strong' : 'text-kumo-default hover:bg-kumo-tint'}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => chooseCommand(command)}
                        >
                          <span className="font-medium">/{command.name}</span>
                          {command.description && <span className="mt-0.5 block text-kumo-subtle">{command.description}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  </div>
                  <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span className="min-w-0 text-[11px] text-kumo-subtle">Prompts stay in the session sandbox. Use tool approvals for external actions.</span>
                    <div className="flex items-center gap-2">
                      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(event) => { void addImageFiles(event.currentTarget.files ?? []); event.currentTarget.value = '' }} />
                      <WorkshopButton type="button" disabled={Boolean(error) || loading || refreshing || sending || snapshot.running || attachments.length >= MAX_IMAGE_ATTACHMENT_COUNT} onClick={() => fileInputRef.current?.click()}><Paperclip size={13} /> Attach image</WorkshopButton>
                      <WorkshopButton tone="primary" type="submit" disabled={!canSend}><PaperPlaneRight size={13} /> Send</WorkshopButton>
                    </div>
                  </div>
                </form>
              </>
            )}
          </div>
        </main>

        <aside className="grid gap-3 lg:block lg:min-h-0 lg:overflow-y-auto" aria-label="OpenCode context">
          <ContextCard title="MCP" text={metadata.mcpText?.error ?? snapshot.mcpText} loading={metadata.mcpText?.loading ?? loading} />
          <ContextCard title="Todo" text={metadata.todoText?.error ?? snapshot.todoText} loading={metadata.todoText?.loading ?? loading} />
          <ContextCard title="Diff" text={metadata.diffText?.error ?? snapshot.diffText} loading={metadata.diffText?.loading ?? loading} />
        </aside>
      </div>
    </section>
  )
}

function WorkingIndicator() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-kumo-line bg-kumo-tint/50 px-3 py-2 text-xs text-kumo-subtle" aria-live="polite" aria-label="Agent is working">
      <CircleNotch size={13} className="animate-spin" /> Agent is working…
    </div>
  )
}

function MessageCard({ message }: { message: OpenCodeMessage }) {
  const isUser = message.role === 'user'
  return (
    <article className={`min-w-0 rounded-xl border p-3 ${isUser ? 'border-kumo-brand/30 bg-kumo-brand/5' : 'border-kumo-line bg-kumo-base'}`}>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-kumo-subtle">{message.role}</div>
      {message.text && (
        <div className="prose prose-sm max-w-none min-w-0 overflow-hidden text-sm leading-6 text-kumo-default prose-pre:bg-transparent">
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={MARKDOWN_COMPONENTS}>{message.text}</ReactMarkdown>
        </div>
      )}
      {message.tools.length > 0 && (
        <div className="mt-3 space-y-2">
          {message.tools.slice(0, MAX_TOOL_COUNT).map((tool) => (
            <div key={tool.id} className="rounded-lg border border-kumo-line bg-kumo-tint/40 px-3 py-2 text-xs text-kumo-default">
              <div className="flex items-center gap-2 font-medium"><Wrench size={13} /> {tool.name} {tool.state && <span className="ml-auto text-kumo-subtle">{tool.state}</span>}</div>
              <ToolDetail label="Error" text={tool.error} tone="danger" />
              <ToolDetail label="Input" text={tool.input} />
              <ToolDetail label="Output" text={tool.output} />
              <ToolDetail label="Metadata" text={tool.metadata} />
            </div>
          ))}
          {message.tools.length > MAX_TOOL_COUNT && <p className="text-[11px] text-kumo-subtle">{message.tools.length - MAX_TOOL_COUNT} more tool entries hidden.</p>}
        </div>
      )}
    </article>
  )
}

function ToolDetail({ label, text, tone }: { label: string; text?: string; tone?: 'danger' }) {
  if (!text) return null
  return (
    <details className="mt-2">
      <summary className={`cursor-pointer text-[11px] font-medium ${tone === 'danger' ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>{label}</summary>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-kumo-subtle">{text}</pre>
    </details>
  )
}

function ChangesPane({ diffText, todoText, diffLoading, todoLoading }: { diffText?: string; todoText?: string; diffLoading: boolean; todoLoading: boolean }) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 rounded-xl border border-kumo-line bg-kumo-tint/40 p-3 text-xs leading-5 text-kumo-subtle">
        Review OpenCode's current diff here. For a full editor and source control workflow, open browser VS Code from the workbench toolbar.
      </div>
      <ContextCard title="Diff" text={diffText} loading={diffLoading} />
      <ContextCard title="Todo" text={todoText} loading={todoLoading} />
    </div>
  )
}

function ContextCard({ title, text, loading }: { title: string; text?: string; loading: boolean }) {
  return (
    <section className="mb-3 rounded-xl border border-kumo-line bg-kumo-base" aria-label={title}>
      <div className="border-b border-kumo-line px-3 py-2 text-xs font-semibold text-kumo-default">{title}</div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap p-3 text-xs leading-5 text-kumo-subtle">{loading ? 'Loading…' : text || 'No data reported.'}</pre>
    </section>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="flex h-full min-h-48 items-center justify-center text-center"><div><h2 className="text-sm font-semibold text-kumo-default">{title}</h2><p className="mt-1 max-w-sm text-xs leading-5 text-kumo-subtle">{body}</p></div></div>
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(signal?.reason ?? new DOMException('Request aborted.', 'AbortError')))
    const timer = window.setTimeout(() => finish(() => reject(timeoutError(message))), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

function timeoutError(message: string) {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

function parseSessions(input: unknown): OpenCodeSession[] {
  const list = Array.isArray(input) ? input : Array.isArray(readRecord(input)?.data) ? readRecord(input)!.data as unknown[] : Array.isArray(readRecord(input)?.sessions) ? readRecord(input)!.sessions as unknown[] : []
  return list.map(parseSession).filter((item): item is OpenCodeSession => Boolean(item)).toSorted((a, b) => b.updatedAt - a.updatedAt)
}

function parseCommands(input: unknown): OpenCodeCommand[] {
  const record = readRecord(input)
  const list = Array.isArray(input) ? input
    : Array.isArray(record?.data) ? record.data as unknown[]
      : Array.isArray(record?.commands) ? record.commands as unknown[]
        : []
  return list.map((item) => {
    if (typeof item === 'string') return { name: item.replace(/^\//, '') }
    const command = readRecord(item)
    const rawName = readString(command?.name) ?? readString(command?.command) ?? readString(command?.id)
    const name = rawName?.replace(/^\//, '')
    if (!name) return undefined
    return { name, description: readString(command?.description) ?? readString(command?.summary) }
  }).filter((command): command is OpenCodeCommand => Boolean(command && /^[A-Za-z0-9:_-]{1,80}$/.test(command.name)))
}

function parseCommandPrompt(text: string): { command: string; arguments: string } | undefined {
  const match = /^\/([A-Za-z0-9:_-]{1,80})(?:\s+(.*))?$/.exec(text)
  if (!match) return undefined
  return { command: match[1], arguments: match[2] ?? '' }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${Math.round(kib)} KB`
  return `${(kib / 1024).toFixed(1)} MB`
}

function countAssistantMessages(messages: OpenCodeMessage[]): number {
  return messages.filter((message) => message.role === 'assistant').length
}

export function boundedTurnNotificationBody(title: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim() || 'Coding session'
  if (normalized.length <= NOTIFICATION_BODY_MAX_LENGTH) return normalized
  return `${normalized.slice(0, NOTIFICATION_BODY_MAX_LENGTH - 1).trimEnd()}…`
}

function parseSession(input: unknown): OpenCodeSession | undefined {
  const record = readRecord(input)
  if (!record) return undefined
  const id = readString(record.id) ?? readString(record.sessionID) ?? readString(record.sessionId)
  if (!id || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return undefined
  const title = readString(record.title) ?? readString(record.name) ?? `Session ${id}`
  const time = readRecord(record.time)
  return { id, title, updatedAt: readTime(record.updatedAt ?? time?.updated ?? record.modifiedAt ?? record.createdAt), rawStatus: readString(record.status) }
}

function selectSession(sessions: OpenCodeSession[], selectedId?: string) {
  return sessions.find((session) => session.id === selectedId) ?? sessions[0]
}

function parseMessages(input: unknown): OpenCodeMessage[] {
  const list = Array.isArray(input) ? input : Array.isArray(readRecord(input)?.data) ? readRecord(input)!.data as unknown[] : Array.isArray(readRecord(input)?.messages) ? readRecord(input)!.messages as unknown[] : []
  return list.slice(-MAX_MESSAGE_COUNT).map((item, index) => parseMessage(item, index))
}

function parseMessage(input: unknown, index: number): OpenCodeMessage {
  const record = readRecord(input) ?? {}
  const info = readRecord(record.info) ?? record
  const role = normalizeRole(readString(info.role) ?? readString(info.type))
  const parts = Array.isArray(record.parts) ? record.parts : Array.isArray(record.content) ? record.content : []
  const error = summarizeUnknown(info.error, MAX_PAYLOAD_LENGTH)
  const textParts = [
    readString(info.text),
    readString(info.message),
    readString(info.content),
    ...parts.map(readPartText),
    error ? `Error: ${error}` : undefined,
  ].filter(Boolean) as string[]
  return {
    id: readString(info.id) ?? readString(info.messageID) ?? `message-${index}`,
    role,
    text: truncateText(textParts.join('\n\n') || summarizeUnknown(input, MAX_PAYLOAD_LENGTH) || '', MAX_TEXT_LENGTH),
    tools: [...parts.map(readPartTool), readPartTool(record)].filter((item): item is OpenCodeTool => Boolean(item)),
  }
}

function readPartText(input: unknown): string | undefined {
  const record = readRecord(input)
  if (!record) return readString(input)
  return readString(record.text) ?? readString(record.content) ?? readString(record.message)
}

function readPartTool(input: unknown): OpenCodeTool | undefined {
  const record = readRecord(input)
  if (!record) return undefined
  const type = readString(record.type)
  const name = readString(record.name) ?? readString(record.tool) ?? readString(record.toolID)
  if (!name && type !== 'tool') return undefined
  const state = readRecord(record.state)
  return {
    id: readString(record.id) ?? `${name ?? 'tool'}-${summarizeUnknown(record.state, 80)}`,
    name: name ?? 'tool',
    state: readString(state?.status) ?? readString(record.state) ?? readString(record.status),
    input: summarizeUnknown(state?.input ?? record.input, MAX_PAYLOAD_LENGTH),
    output: summarizeUnknown(state?.output ?? record.output, MAX_PAYLOAD_LENGTH),
    error: summarizeUnknown(state?.error ?? record.error, MAX_PAYLOAD_LENGTH),
    metadata: summarizeUnknown(state?.metadata ?? record.metadata, MAX_PAYLOAD_LENGTH),
  }
}

function parseRunning(statusJson: unknown, selected?: OpenCodeSession): boolean {
  const status = selectedStatus(statusJson, selected)
  return /running|busy|pending|working|loading|retry/.test(status.toLowerCase())
}

function isTrustworthyStatus(input: unknown, selected?: OpenCodeSession): boolean {
  const statuses = readRecord(input)
  if (!statuses || !selected) return false
  // OpenCode removes idle sessions from its status map. An absent entry is idle,
  // but an invalid response or unknown explicit status must never authorize a send.
  return Object.values(statuses).every((value) => {
    const status = readRecord(value)
    const type = readString(status?.type) ?? readString(status?.status) ?? readString(status?.state)
    return Boolean(type && /^(idle|running|busy|pending|working|loading|retry)$/.test(type.toLowerCase()))
  })
}

function safeWorkbenchError(caught: unknown): string {
  if (caught instanceof Error && (/^OpenCode request failed \(\d{3}\)\.$/.test(caught.message) ||
    caught.message === 'OpenCode status is unavailable. Retry before sending.' ||
    caught.message === 'OpenCode workbench capability was not same-origin.' ||
    caught.message === 'OpenCode took too long to start. Retry, or restart the coding session if the problem continues.' ||
    caught.message === 'OpenCode did not respond in time. Retry the request.')) return caught.message
  return 'Could not load OpenCode workbench. Retry the connection.'
}

function summarizeStatus(statusJson: unknown, selected?: OpenCodeSession): string {
  return selectedStatus(statusJson, selected) || 'OpenCode ready'
}

function selectedStatus(statusJson: unknown, selected?: OpenCodeSession): string {
  const statuses = readRecord(statusJson)
  const selectedRecord = selected ? readRecord(statuses?.[selected.id]) : undefined
  return readString(selectedRecord?.type) ?? readString(selectedRecord?.status) ??
    readString(selectedRecord?.state) ?? selected?.rawStatus ?? ''
}

function summarizeUnknown(input: unknown, limit = MAX_PAYLOAD_LENGTH): string | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input === 'string') return truncateText(input, limit)
  try {
    return truncateText(JSON.stringify(input, jsonReplacer, 2), limit)
  } catch {
    return '[unrenderable payload]'
  }
}

function jsonReplacer(_key: string, value: unknown) {
  if (typeof value === 'string') return truncateText(value, 800)
  return value
}

function truncateText(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}… [truncated]` : text
}

function readRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function readString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined
}

function readTime(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string') {
    const parsed = Date.parse(input)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function normalizeRole(input?: string): OpenCodeMessage['role'] {
  if (input === 'user' || input === 'assistant' || input === 'system' || input === 'tool') return input
  return 'assistant'
}

function isAbortError(caught: unknown) {
  return caught instanceof DOMException && caught.name === 'AbortError'
}
