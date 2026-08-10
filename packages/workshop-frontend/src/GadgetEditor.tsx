import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useParams, useNavigate, useSearch, Link } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import {
  ShareNetwork,
  Pencil,
  Check,
  X,
  Hexagon,
  Blueprint,
  Trash,
  ArrowsOutSimple,
  Pulse,
  type Icon,
} from '@phosphor-icons/react'
import { RpcStub, RpcTarget } from 'capnweb'
import { useAuthenticatedApi } from './AuthContext'
import UserMenu from './components/UserMenu'
import SiteLogo from './components/SiteLogo'

import {
  GadgetClient,
  AiChatAuthorInfo,
  ConsoleLogSubscriber,
  ConsoleLogEvent,
  ActionLogEntry,
  WorkpieceId,
  WorkpieceSummary,
  BlueprintOutput,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import ObserverConfigModal from './ObserverConfigModal'
import GadgetCodeInterface from './GadgetCodeInterface'
import GadgetUI from './GadgetUI'
import GadgetUseView from './GadgetUseView'
import Connections from './Connections'
import Activity, { type ActivityView } from './Activity'
import { CountBadge } from './components/CountBadge'
import ActivityNotifications from './ActivityNotifications'
import WorkpiecePicker, {
  WORKPIECE_RAIL_COLLAPSED_WIDTH,
  WORKPIECE_RAIL_EXPANDED_WIDTH,
} from './WorkpiecePicker'
import ChatInterface, { type StreamingProposedChanges, type ActiveFileTarget } from './ChatInterface'
import { formatOf } from './components/format/formats'
import { FormatGlyph } from './components/format/FormatVisuals'
import ShareModal from './ShareModal'
import { GadgetPresence } from './components/GadgetPresence'
import BlueprintModal from './BlueprintModal'
import TopBarNotice from './TopBarNotice'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import { useActions } from './useActions'
import DeleteConfirmationDialog from './components/DeleteConfirmationDialog'
import ReconnectingChip from './components/ReconnectingChip'
import WorkspaceOpenErrorPage from './components/WorkspaceOpenErrorPage'
import { useWorkspaceOpen } from './useWorkspaceOpen'
import { reportIssue } from './errorReporting'
import GadgetExportMenu from './GadgetExportMenu'

const NO_GADGETS: ReadonlySet<WorkpieceId> = new Set()

// ─── console log subscriber ───────────────────────────────────────────────────

type BufferedLogEntry = ConsoleLogEvent & { source: 'server' | 'client' }

class ConsoleLogSubscriberImpl extends RpcTarget implements ConsoleLogSubscriber {
  selectedChatIdRef: { current: number | null } = { current: null }
  logBufferRef: { current: BufferedLogEntry[] } = { current: [] }
  onBufferUpdated: () => void = () => {}

  async event(chatId: number | null, logs: ConsoleLogEvent[]) {
    for (const log of logs) {
      const method = (console as any)[log.level] ?? console.log
      method('server:', ...log.message)
    }
    // If the logs are not associated with any chat, deliver to the current chat. If they are
    // associated with a chat, this implies that the logs come from a version of the gadget that
    // has proposed changes from that chat; only deliver if it matches the current chat.
    if (chatId === null || chatId === this.selectedChatIdRef.current) {
      this.logBufferRef.current.push(...logs.map(l => ({ ...l, source: 'server' as const })))
      this.onBufferUpdated()
    }
  }
}

// ─── workpieces subscriber ────────────────────────────────────────────────────

// Receives the workspace's workpiece list (see Overseer.subscribeToWorkpieces()). Entries
// received before ready() are buffered so a (re)subscription replaces the list atomically instead
// of flashing a partially-populated one.
class WorkpiecesSubscriberImpl extends RpcTarget implements WorkpiecesSubscriber {
  private buffer: Map<WorkpieceId, WorkpieceSummary> | null = new Map()
  private cancelled = false

  constructor(
    private onUpdate: (
      update: (prev: Map<WorkpieceId, WorkpieceSummary>) => Map<WorkpieceId, WorkpieceSummary>,
    ) => void,
    private onReady: (initial: Map<WorkpieceId, WorkpieceSummary>) => void,
  ) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (this.cancelled) return
    if (this.buffer) {
      this.buffer.set(summary.id, summary)
      return
    }
    this.onUpdate(prev => new Map(prev).set(summary.id, summary))
  }

  removed(id: WorkpieceId) {
    if (this.cancelled) return
    if (this.buffer) {
      this.buffer.delete(id)
      return
    }
    this.onUpdate(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }

  ready() {
    if (this.cancelled) return
    const initial = this.buffer ?? new Map<WorkpieceId, WorkpieceSummary>()
    this.buffer = null
    this.onReady(initial)
  }

  // local call
  cancel() {
    this.cancelled = true
  }
}

function formatConsoleLogs(logs: BufferedLogEntry[]): string {
  const lines = logs.map(log => {
    const parts = log.message.map(p => (typeof p === 'string' ? p : JSON.stringify(p)))
    return `[${log.source} ${log.level}] ${parts.join(' ')}`
  })
  return 'Console logs:\n' + lines.join('\n')
}

// ─── right-panel tabs ─────────────────────────────────────────────────────────

type RightTab = 'app' | 'code' | 'connections'

type WorkspaceView =
  | { mode: 'chat' }
  // `appId` is absent only while lazily migrating the legacy "open" value.
  | { mode: 'app'; appId?: WorkpieceId }
  | { mode: 'activity' }

function formatHeaderCost(cost: number) {
  if (cost === 0) return '$0'
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

// The first tab is named after what the selected workpiece is ("Document" for a gadget built from
// a document blueprint), falling back to "App" when it declares no format.
function rightTabs(output?: BlueprintOutput): { value: RightTab; label: string }[] {
  return [
    { value: 'app', label: formatOf(output).noun },
    { value: 'code', label: 'Code' },
    { value: 'connections', label: 'Connections' },
  ]
}

const ACTIVITY_TABS: { value: ActivityView; label: string }[] = [
  { value: 'review', label: 'Needs review' },
  { value: 'auto', label: 'Auto-approval' },
  { value: 'history', label: 'History' },
]

// Names what the pane is showing. `icon` is for the workspace-level views (Activity); a workpiece
// passes its `output` instead, so a Doc gets a document glyph rather than the gadget hexagon.
function PaneLabel({
  icon: LabelIcon,
  output,
  title,
  badge,
}: {
  icon?: Icon
  output?: BlueprintOutput
  title: string
  badge?: string
}) {
  return (
    <div
      title={title}
      className="inline-flex w-full min-w-0 max-w-[180px] items-center gap-1.5 overflow-hidden rounded-lg bg-kumo-tint px-2.5 py-1.5 text-[13px] font-medium tracking-[-0.15px] text-kumo-default"
    >
      {LabelIcon
        ? <LabelIcon size={14} weight="bold" className="flex-shrink-0" />
        : <FormatGlyph output={output} size="sm" className="flex-shrink-0" weight="regular" />}
      <span className="truncate">{title}</span>
      {badge !== undefined && (
        <span className="rounded-full bg-kumo-fill px-1.5 py-0.5 text-[10px] font-medium leading-none text-kumo-subtle">
          {badge}
        </span>
      )}
    </div>
  )
}

// Breathing room left between the open tab and the edge it was scrolled away from, so a tab that
// only just fits doesn't look clipped.
const TAB_REVEAL_MARGIN = 8

// The workpiece tabs in the pane header, shown when the workspace holds more than one. The Outputs
// rail only shows when the pane is closed, so without these an open output gives no sign that the
// workspace holds others.
function PaneWorkpieceTabs({
  gadgets,
  activeId,
  onSelect,
}: {
  gadgets: WorkpieceSummary[]
  activeId: WorkpieceId | null
  onSelect: (id: WorkpieceId) => void
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // Whatever is open must be fully readable; the rest may sit off-scroll. Once per selection
  // change isn't enough, because the layout keeps moving afterwards: the pane animates its width,
  // and a new output's title arrives after its tab first renders. So re-run on the next frame and
  // on every resize of the strip.
  //
  // Scrolls the strip by hand rather than with scrollIntoView, which is free to scroll every
  // scrollable ancestor, including the page.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const reveal = () => {
      const active = activeRef.current
      if (!active) return
      const tab = active.getBoundingClientRect()
      const view = scroller.getBoundingClientRect()
      if (tab.right > view.right) {
        scroller.scrollLeft += tab.right - view.right + TAB_REVEAL_MARGIN
      } else if (tab.left < view.left) {
        scroller.scrollLeft -= view.left - tab.left + TAB_REVEAL_MARGIN
      }
    }

    reveal()
    const frame = requestAnimationFrame(reveal)
    // Catches the pane's width animation, which changes the strip's size for ~200ms after this runs.
    const observer = new ResizeObserver(reveal)
    observer.observe(scroller)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [activeId, gadgets])

  return (
    <div
      ref={scrollerRef}
      className="hide-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {gadgets.map(gadget => {
        const active = gadget.id === activeId
        return (
          <button
            key={gadget.id}
            ref={active ? activeRef : undefined}
            type="button"
            onClick={() => onSelect(gadget.id)}
            title={gadget.title}
            aria-current={active ? 'page' : undefined}
            // The open one gets room for its whole name; the others yield first.
            className={`inline-flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium tracking-[-0.15px] transition-colors duration-150 ${
              active
                ? 'max-w-[240px] bg-kumo-tint text-kumo-default'
                : 'max-w-[150px] text-kumo-subtle hover:bg-kumo-tint/50 hover:text-kumo-default'
            }`}
          >
            <FormatGlyph output={gadget.output} size="sm" className="flex-shrink-0" weight="regular" />
            <span className="truncate">{gadget.title}</span>
            {gadget.chatId !== undefined && (
              <span className="flex-shrink-0 rounded-full bg-kumo-fill px-1.5 py-0.5 text-[10px] font-medium leading-none text-kumo-subtle">
                Draft
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function PaneTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-medium tracking-[-0.15px] transition-colors duration-150 ${
        active ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'
      }`}
    >
      {label}
      <CountBadge count={count ?? 0} />
    </button>
  )
}

const CHAT_WIDTH_STORAGE_KEY = 'gadgets:workshop:chatWidth'
// Keep the old key prefix so existing "open" / "closed" preferences can migrate lazily.
const WORKSPACE_VIEW_STORAGE_KEY_PREFIX = 'gadgets:workshop:workspaceVisibility:'
const APP_RAIL_EXPANDED_STORAGE_KEY = 'gadgets:workshop:appRailExpanded'
const MIN_CHAT_WIDTH = 280
const MIN_WORKSPACE_WIDTH = 400
const DEFAULT_CHAT_WIDTH = 420
const WORKSPACE_TRANSITION_MS = 200

const isBrowser = typeof window !== 'undefined'

function clampChatWidth(width: number) {
  if (!isBrowser) return Math.max(MIN_CHAT_WIDTH, Math.min(DEFAULT_CHAT_WIDTH, width))
  const max = Math.max(MIN_CHAT_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH)
  return Math.max(MIN_CHAT_WIDTH, Math.min(max, width))
}

function getInitialChatWidth() {
  if (!isBrowser) return DEFAULT_CHAT_WIDTH
  const fallback = Math.min(DEFAULT_CHAT_WIDTH, Math.floor(window.innerWidth * 0.38))
  let parsed = NaN
  try {
    const stored = window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)
    if (stored) parsed = Number(stored)
  } catch {
    // private mode / sandboxed iframes
  }
  return clampChatWidth(Number.isFinite(parsed) ? parsed : fallback)
}

function workspaceViewStorageKey(gadgetId: string) {
  // Per-workspace keys may outlive deleted workspaces, but each entry is tiny and bounded by
  // workspaces created or opened.
  return `${WORKSPACE_VIEW_STORAGE_KEY_PREFIX}${gadgetId}`
}

function persistWorkspaceView(gadgetId: string, view: {mode: 'chat'} | {mode: 'app', appId: WorkpieceId}) {
  try {
    window.localStorage.setItem(workspaceViewStorageKey(gadgetId), JSON.stringify(view))
  } catch {
    // The preference still works for the current session when storage is unavailable.
  }
}

function getStoredWorkspaceView(gadgetId: string | undefined): WorkspaceView | null {
  if (!isBrowser || !gadgetId) return null
  try {
    const stored = window.localStorage.getItem(workspaceViewStorageKey(gadgetId))
    if (stored === 'open') return { mode: 'app' }
    if (stored === 'closed') {
      const view = { mode: 'chat' } as const
      persistWorkspaceView(gadgetId, view)
      return view
    }
    if (!stored) return null

    const parsed: unknown = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null || !('mode' in parsed)) return null
    if (parsed.mode === 'chat') return { mode: 'chat' }
    if (parsed.mode === 'app' && 'appId' in parsed &&
        typeof parsed.appId === 'number' && Number.isInteger(parsed.appId)) {
      return { mode: 'app', appId: parsed.appId }
    }
    return null
  } catch {
    return null
  }
}

function getInitialAppRailExpanded(): boolean {
  if (!isBrowser) return true
  try {
    return window.localStorage.getItem(APP_RAIL_EXPANDED_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

function NoGadgetPlaceholder({ height }: { height: string }) {
  return (
    <div className="flex items-center justify-center px-6 text-center" style={{ height }}>
      <div className="max-w-[360px]">
        <p className="m-0 text-[15px] leading-[22px] font-semibold tracking-[-0.3px] text-kumo-default">
          No gadgets yet
        </p>
        <p className="mt-1.5 mb-0 text-[13px] leading-[19px] tracking-[-0.25px] text-kumo-subtle">
          Ask the agent in chat to build something, and it will appear here.
        </p>
      </div>
    </div>
  )
}

// ─── component ────────────────────────────────────────────────────────────────

export default function GadgetEditor() {
  const params = useParams({ strict: false }) as { id?: string }
  const id = params.id
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()

  const { chat: chatParam, w: workpieceParam } = useSearch({ strict: false }) as
    { chat?: number; w?: number }
  const urlChatId = chatParam !== undefined ? chatParam : null
  const urlWorkpieceId = workpieceParam !== undefined ? workpieceParam : null

  // ── toasts ─────────────────────────────────────────────────────────────────────
  const toasts = useKumoToastManager()

  // ── core state ──────────────────────────────────────────────────────────────
  // The workspace's workpiece list (gadget-type workpieces only in v1), kept live via
  // subscribeToWorkpieces(). `workpiecesReady` flips once the initial listing has arrived.
  const [workpieces, setWorkpieces] = useState<Map<WorkpieceId, WorkpieceSummary>>(new Map())
  const [workpiecesReady, setWorkpiecesReady] = useState(false)
  const knownWorkpieceIdsRef = useRef<Set<WorkpieceId> | null>(null)
  // GadgetClient stub for the currently-selected gadget workpiece. Per-gadget operations (UI
  // bundle, RPC connection, bindings, blueprints) go through this stub. Null while the workspace
  // has no (visible) gadgets.
  const [gadget, setGadget] = useState<{ id: WorkpieceId; stub: RpcStub<GadgetClient> } | null>(null)

  // ── title editing ────────────────────────────────────────────────────────────
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const isEditingTitleRef = useRef(false)
  isEditingTitleRef.current = isEditingTitle
  const [titleInput, setTitleInput] = useState('')

  const {
    overseer,
    metadata,
    error,
    connectionLost,
    observerConfig,
    retry: retryOpen,
    cancelObserverConfig,
    updateTitle,
  } = useWorkspaceOpen({
    id,
    authenticatedApi,
    onMetadata: nextMetadata => {
      if (!isEditingTitleRef.current) setTitleInput(nextMetadata.title)
    },
    onShareKeyConsumed: () => {
      if (id) navigate({ to: '/workspace/$id', params: { id }, search: {}, replace: true })
    },
    onInvalidShareKey: () => {
      toasts.add({ title: 'Invalid or expired share link.', variant: 'error' })
    },
  })
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)

  // ── role gating ────────────────────────────────────────────────────────────────
  // "use"-role collaborators receive a restricted overseer that only permits rendering and
  // interacting with the gadget's deployed UI. We render the minimal use-only view for them (see
  // the early return below). Editor-only RPCs are fired speculatively regardless of role: the
  // restricted overseer denies the ones that matter and returns inert results for the two
  // telemetry subscriptions this component opens, so no client-side gating is needed here.
  const isUseOnly = metadata?.role === 'use'

  // ── layout ───────────────────────────────────────────────────────────────────
  const [chatWidth, setChatWidth] = useState(getInitialChatWidth)
  const chatWidthRef = useRef(chatWidth)
  const [isResizing, setIsResizing] = useState(false)
  const [activeTab, setActiveTab] = useState<RightTab>('app')
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(() =>
    getStoredWorkspaceView(id)
  )
  const [workspaceTransitionEnabled, setWorkspaceTransitionEnabled] = useState(false)
  const activityReturnViewRef = useRef<WorkspaceView | null>(null)
  const [activityView, setActivityView] = useState<ActivityView>('history')
  const [activityClosing, setActivityClosing] = useState(false)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [blueprintModalOpen, setBlueprintModalOpen] = useState(false)
  const [previewMode, _setPreviewMode] = useState(false)
  const [workpieceRailExpanded, setWorkpieceRailExpanded] = useState(getInitialAppRailExpanded)
  const workpieceRailWidth = workpieceRailExpanded
    ? WORKPIECE_RAIL_EXPANDED_WIDTH
    : WORKPIECE_RAIL_COLLAPSED_WIDTH
  const handleWorkpieceRailExpandedChange = useCallback((expanded: boolean) => {
    setWorkspaceTransitionEnabled(true)
    setWorkpieceRailExpanded(expanded)
    try {
      window.localStorage.setItem(APP_RAIL_EXPANDED_STORAGE_KEY, String(expanded))
    } catch {
      // The preference still works for the current session when storage is unavailable.
    }
  }, [])

  // Fullscreen gadget mode — renders the gadget iframe as an overlay covering the whole page.
  // Tied to the URL hash (#fullscreen) so the state is bookmarkable and survives reloads.
  const [isGadgetFullscreen, setIsGadgetFullscreen] = useState(
    () => typeof window !== 'undefined' && window.location.hash === '#fullscreen'
  )

  useEffect(() => {
    const onHashChange = () => {
      setIsGadgetFullscreen(window.location.hash === '#fullscreen')
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Brief hint banner shown when entering fullscreen, instructing the user how to exit.
  // We don't use the global Kumo toast manager here because the fullscreen overlay sits above
  // it in stacking order (and toasts render bottom-right, not top-center).
  const [showFullscreenHint, setShowFullscreenHint] = useState(false)
  // Element that had focus before entering fullscreen; we restore focus to it on exit so
  // keyboard users aren't stranded.
  const focusBeforeFullscreenRef = useRef<HTMLElement | null>(null)
  // Fullscreen overlay wrapper — we focus this on enter to move focus out of the now-occluded
  // Enter button. From here, Tab moves into the iframe.
  const fullscreenOverlayRef = useRef<HTMLDivElement>(null)

  const enterGadgetFullscreen = useCallback(() => {
    if (window.location.hash !== '#fullscreen') {
      // pushState so the browser Back button also exits fullscreen — natural for many users
      // and helpful for bookmarks: a bookmarked /workspace/foo#fullscreen can still go Back to a
      // useful (non-fullscreen) state if there's prior history.
      window.history.pushState(null, '', '#fullscreen')
    }
    focusBeforeFullscreenRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setIsGadgetFullscreen(true)
    setShowFullscreenHint(true)
  }, [])

  // Auto-dismiss the hint a few seconds after entering fullscreen.
  useEffect(() => {
    if (!showFullscreenHint) return
    const t = setTimeout(() => setShowFullscreenHint(false), 4000)
    return () => clearTimeout(t)
  }, [showFullscreenHint])

  // Move focus into the overlay when entering fullscreen, and back to the prior element on exit.
  useEffect(() => {
    if (isGadgetFullscreen) {
      fullscreenOverlayRef.current?.focus()
    } else if (focusBeforeFullscreenRef.current) {
      focusBeforeFullscreenRef.current.focus()
      focusBeforeFullscreenRef.current = null
    }
  }, [isGadgetFullscreen])

  const exitGadgetFullscreen = useCallback(() => {
    if (window.location.hash === '#fullscreen') {
      // Replace the hash without growing the history stack.
      const { pathname, search } = window.location
      window.history.replaceState(null, '', `${pathname}${search}`)
    }
    setIsGadgetFullscreen(false)
  }, [])

  // Escape exits fullscreen. When focus is in the workshop chrome this listener catches it
  // directly; when focus is in the gadget iframe, the iframe forwards Escape via postMessage
  // (see GadgetUI's `onIframeEscape`).
  useEffect(() => {
    if (!isGadgetFullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitGadgetFullscreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isGadgetFullscreen, exitGadgetFullscreen])

  // ── code / chat state ────────────────────────────────────────────────────────
  const [uiReloadTrigger, setUiReloadTrigger] = useState(0)
  const [autoApproveReloadTrigger, setAutoApproveReloadTrigger] = useState(0)
  const [proposedChanges, setProposedChanges] = useState<Uint8Array | undefined>(undefined)
  const [draftProposedChanges, setDraftProposedChanges] = useState<StreamingProposedChanges | undefined>(undefined)
  const [streamingProposedChanges, setStreamingProposedChanges] = useState<StreamingProposedChanges | undefined>(undefined)
  const [streamingActiveFileState, setStreamingActiveFileState] = useState<{
    chatId: number
    file: ActiveFileTarget | null | undefined
  } | null>(null)
  const [hasCode, setHasCode] = useState<boolean | null>(null)
  const [chatCount, setChatCount] = useState<number | null>(null)
  const [hasChatZero, setHasChatZero] = useState(false)
  const [_hasBindings, setHasBindings] = useState(false)
  const [isAgentActive, setIsAgentActive] = useState(false)
  const [hasAnyProposedChanges, setHasAnyProposedChanges] = useState(false)
  const [selectedChatHasProposedChanges, setSelectedChatHasProposedChanges] = useState(false)
  const selectedChatId = urlChatId
  const chatListReady = chatCount !== null
  const singleInitialChat = chatCount === 1 && hasChatZero
  const [userNavigatedToList, setUserNavigatedToList] = useState(false)
  // Note: raw `hasCode` (not `effectiveHasCode` below) is deliberate here, to avoid a dependency
  // cycle: the effective value depends on the selected workpiece, whose pending-gadget visibility
  // depends on `effectiveSelectedChatId`, which depends on this pin. When no gadget is selected
  // yet, `hasCode` is null and the pin stays on -- the right behavior for new workspaces.
  const pinInitialChatSelection =
    singleInitialChat && hasCode !== true && !userNavigatedToList

  // Before any code has been merged, a single-thread gadget conceptually only
  // has one useful conversation, so keep chat 0 selected even if the URL has
  // not caught up yet. As soon as merged code exists, dropping back to the chat
  // list should become possible.
  const effectiveSelectedChatId = selectedChatId ?? (pinInitialChatSelection ? 0 : null)

  // ── workpiece selection ──────────────────────────────────────────────────────
  const allGadgets = useMemo(() => {
    return [...workpieces.values()]
      .filter(w => w.type === 'gadget')
      .toSorted((a, b) => a.id - b.id)
  }, [workpieces])

  // The format a workpiece was built as, for surfaces that only know an id (the chat's "created
  // app" cards, the tool-call rows). Read from the live workpiece list, so it stays correct as the
  // workspace changes.
  //
  // Keyed on the formats, not on the workpiece list: this feeds buildChatDisplayEntries(), which
  // rebuilds the whole transcript when its inputs change, while `workpieces` is replaced by every
  // unrelated update.
  const workpieceOutputsRef = useRef(new Map<WorkpieceId, BlueprintOutput>())
  const outputSignature = useMemo(() => {
    const outputs = new Map<WorkpieceId, BlueprintOutput>()
    for (const workpiece of workpieces.values()) {
      if (workpiece.output) outputs.set(workpiece.id, workpiece.output)
    }
    workpieceOutputsRef.current = outputs
    return JSON.stringify([...outputs])
  }, [workpieces])
  const outputOfWorkpiece = useCallback(
    (workpieceId: WorkpieceId) => workpieceOutputsRef.current.get(workpieceId),
    [outputSignature],
  )

  const visibleGadgets = useMemo(() => {
    return allGadgets.filter(w =>
      w.chatId === undefined || w.chatId === effectiveSelectedChatId)
  }, [allGadgets, effectiveSelectedChatId])

  // The selected gadget: explicit URL state wins, followed by the app open in this session (only
  // accepted apps are persisted), then the workspace default and the first visible gadget.
  const selectedGadgetId = useMemo(() => {
    if (urlWorkpieceId !== null && visibleGadgets.some(g => g.id === urlWorkpieceId)) {
      return urlWorkpieceId
    }
    const storedId = workspaceView?.mode === 'app' ? workspaceView.appId : undefined
    if (storedId !== undefined && visibleGadgets.some(g => g.id === storedId)) {
      return storedId
    }
    const defaultId = metadata?.defaultGadgetId
    if (defaultId !== undefined && visibleGadgets.some(g => g.id === defaultId)) {
      return defaultId
    }
    return visibleGadgets.length > 0 ? visibleGadgets[0].id : null
  }, [urlWorkpieceId, workspaceView, visibleGadgets, metadata?.defaultGadgetId])

  const selectedGadgetSummary = selectedGadgetId !== null
    ? visibleGadgets.find(g => g.id === selectedGadgetId)
    : undefined

  // Lazily normalize legacy "open" preferences once the accepted app list is known. Draft apps
  // remain session-only until accepted; at that point this effect persists them automatically.
  useEffect(() => {
    if (!id || !workpiecesReady || workspaceView?.mode !== 'app') return

    if (workspaceView.appId !== undefined) {
      const chosen = allGadgets.find(g => g.id === workspaceView.appId)
      if (chosen?.chatId !== undefined) return
      if (chosen) {
        persistWorkspaceView(id, { mode: 'app', appId: chosen.id })
        return
      }
    }

    const acceptedApps = allGadgets.filter(g => g.chatId === undefined)
    const fallback = acceptedApps.find(g => g.id === metadata?.defaultGadgetId)
      ?? acceptedApps[0]
    if (fallback) {
      const normalized = { mode: 'app', appId: fallback.id } as const
      setWorkspaceView(normalized)
      persistWorkspaceView(id, normalized)
    } else {
      const normalized = { mode: 'chat' } as const
      setWorkspaceView(normalized)
      persistWorkspaceView(id, normalized)
    }
  }, [id, workpiecesReady, workspaceView, allGadgets, metadata?.defaultGadgetId])

  const selectedFilesRoot = selectedGadgetSummary?.filesRoot
  // The stub for the selected gadget arrives via an effect; during a switch it briefly lags the
  // selection, in which case gadget-dependent views render their empty states for a frame.
  const selectedGadgetStub =
    gadget !== null && gadget.id === selectedGadgetId ? gadget.stub : null
  // Only the selected chat's streaming drives this editor. Everything downstream then narrows it
  // further to the selected gadget.
  const streamingActiveFile = streamingActiveFileState?.chatId === effectiveSelectedChatId
    ? streamingActiveFileState.file
    : undefined
  // The file the agent is streaming edits into, when it is in the selected gadget. (Edits going
  // to a different gadget instead auto-switch the picker; see the effect below.)
  const streamingActiveFileForSelected =
    streamingActiveFile != null && streamingActiveFile.workpieceId === selectedGadgetId
      ? streamingActiveFile.filename
      : undefined

  const { actionsById } = useActions(overseer?.stub ?? null)
  // Hook bindings change once in a while, but `actionsById` is a fresh Map on every action-log
  // frame. Track just the bindHook enable states so the refetch isn't driven at animation rate.
  const hookSignature = useMemo(() => {
    const parts: string[] = []
    for (const record of actionsById.values()) {
      if (record.type === 'bindHook') parts.push(`${record.hookId}:${record.enabled}`)
    }
    return parts.join()
  }, [actionsById])
  const [hookedGadgetIds, setHookedGadgetIds] = useState<ReadonlySet<WorkpieceId>>(NO_GADGETS)
  useEffect(() => {
    if (!overseer || metadata === null || isUseOnly) return
    let cancelled = false
    overseer.stub.listHooks()
      .then(hooks => {
        if (!cancelled) setHookedGadgetIds(new Set(hooks.filter(h => h.enabled).map(h => h.gadgetId)))
      })
      .catch(err => reportIssue('gadget-hook-indicators.load', err))
    // Clear on teardown so a workspace switch never shows the previous workspace's indicators.
    return () => { cancelled = true; setHookedGadgetIds(NO_GADGETS) }
  }, [overseer, hookSignature, metadata !== null, isUseOnly])
  const pendingActions = useMemo(() => {
    const pending: ActionLogEntry[] = []
    for (const record of actionsById.values()) {
      if (record.state === 'pending') pending.push(record)
    }
    return pending
  }, [actionsById])
  const pendingActionsCount = pendingActions.length

  // Whether the *selected* gadget has code. When no gadget is selected, the code interface is
  // unmounted and raw `hasCode` can't update, but a gadget-less workspace has no code to show.
  const effectiveHasCode = selectedFilesRoot !== undefined
    ? hasCode
    : workpiecesReady ? false : null

  const codeStateReady = effectiveHasCode !== null
  const hasCodeRelatedState = effectiveHasCode === true
    || hasAnyProposedChanges
    || streamingProposedChanges !== undefined
  const layoutModeReady = chatListReady && (codeStateReady || hasCodeRelatedState)

  // Wait for all initial subscriptions before choosing the new-workspace chat-only layout.
  const simpleMode = layoutModeReady && !hasCodeRelatedState && singleInitialChat
    && visibleGadgets.length <= 1
  const hasAnyApps = allGadgets.length > 0
  const showingActivity = workspaceView?.mode === 'activity'
  const showFullEditor = layoutModeReady && (
    showingActivity || (hasAnyApps && (workspaceView === null ? !simpleMode : workspaceView.mode === 'app'))
  )
  const showOutputRail = layoutModeReady && hasAnyApps && !showFullEditor
  const paneShowsActivity = showingActivity || activityClosing
  useEffect(() => {
    if (!activityClosing) return
    const timeout = window.setTimeout(() => setActivityClosing(false), WORKSPACE_TRANSITION_MS)
    return () => window.clearTimeout(timeout)
  }, [activityClosing])
  const outputRailWidth = showOutputRail ? workpieceRailWidth : 0
  const workspaceTransitionClass = workspaceTransitionEnabled && !isResizing
    ? 'transition-[width,opacity] duration-200 ease-out'
    : ''

  const previewChatId =
    selectedChatHasProposedChanges && effectiveSelectedChatId !== null
      ? effectiveSelectedChatId
      : undefined

  // ── console log buffering ────────────────────────────────────────────────────
  const consoleLogSubscriberRef = useRef(new ConsoleLogSubscriberImpl())
  const consoleLogBufferRef = useRef<BufferedLogEntry[]>([])
  const [consoleLogCount, setConsoleLogCount] = useState(0)
  const selectedChatIdRef = useRef(effectiveSelectedChatId)
  selectedChatIdRef.current = effectiveSelectedChatId
  consoleLogSubscriberRef.current.selectedChatIdRef = selectedChatIdRef
  consoleLogSubscriberRef.current.logBufferRef = consoleLogBufferRef
  consoleLogSubscriberRef.current.onBufferUpdated = () =>
    setConsoleLogCount(consoleLogBufferRef.current.length)

  useEffect(() => {
    consoleLogBufferRef.current = []
    setConsoleLogCount(0)
  }, [effectiveSelectedChatId])

  const consumeConsoleLogs = useCallback((): string => {
    const logs = consoleLogBufferRef.current
    consoleLogBufferRef.current = []
    setConsoleLogCount(0)
    return formatConsoleLogs(logs)
  }, [])

  const discardConsoleLogs = useCallback(() => {
    consoleLogBufferRef.current = []
    setConsoleLogCount(0)
  }, [])

  chatWidthRef.current = chatWidth

  const handleClientConsoleLog = useCallback((log: ConsoleLogEvent) => {
    const method = (console as any)[log.level] ?? console.log
    method('client:', ...log.message)
    if (selectedChatIdRef.current !== null) {
      consoleLogBufferRef.current.push({ ...log, source: 'client' as const })
      setConsoleLogCount(consoleLogBufferRef.current.length)
    }
  }, [])

  const persistChatWidth = useCallback((width: number) => {
    try {
      window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(Math.round(width)))
    } catch {
      // private mode / sandboxed iframes
    }
  }, [])

  const setWorkspaceVisibility = useCallback((visibility: 'open' | 'closed', appId?: WorkpieceId) => {
    setWorkspaceTransitionEnabled(true)
    setActivityClosing(false)
    activityReturnViewRef.current = null
    if (visibility === 'closed') {
      const view = { mode: 'chat' } as const
      setWorkspaceView(view)
      if (id) persistWorkspaceView(id, view)
    } else {
      // Opening a draft is intentionally session-only. The normalization effect persists it if
      // and when the app is accepted.
      setWorkspaceView({ mode: 'app', appId })
    }
  }, [id])

  // Arriving with ?w= (from the Outputs page, say) has to show that workpiece, not whichever view
  // this workspace was last left on -- selectedGadgetId already honours the parameter, but the
  // stored view is what decides whether the pane shows an app at all.
  //
  // Honoured once per workpiece so it doesn't reopen the pane when the user closes it while the
  // parameter is still in the URL.
  const openedWorkpieceParamRef = useRef<WorkpieceId | null>(null)
  useEffect(() => {
    if (!workpiecesReady || urlWorkpieceId === null) return
    if (openedWorkpieceParamRef.current === urlWorkpieceId) return
    if (!visibleGadgets.some(g => g.id === urlWorkpieceId)) return
    openedWorkpieceParamRef.current = urlWorkpieceId
    setWorkspaceVisibility('open', urlWorkpieceId)
  }, [workpiecesReady, urlWorkpieceId, visibleGadgets, setWorkspaceVisibility])

  const openActivity = useCallback((initialView: ActivityView) => {
    setWorkspaceTransitionEnabled(true)
    setActivityClosing(false)
    if (workspaceView?.mode !== 'activity') activityReturnViewRef.current = workspaceView
    setActivityView(initialView)
    setWorkspaceView({ mode: 'activity' })
  }, [workspaceView])

  const closeWorkspacePane = useCallback(() => {
    if (workspaceView?.mode !== 'activity') {
      setWorkspaceVisibility('closed')
      return
    }
    setWorkspaceTransitionEnabled(true)
    const returnView = activityReturnViewRef.current
    const returnShowsPane = returnView?.mode === 'app'
      || (returnView === null && hasAnyApps && !simpleMode)
    setActivityClosing(!returnShowsPane)
    setWorkspaceView(returnView)
    activityReturnViewRef.current = null
  }, [workspaceView, setWorkspaceVisibility, hasAnyApps, simpleMode])

  // Ignore the initial listing, then open apps created by the active chat.
  useEffect(() => {
    if (!workpiecesReady) return

    if (knownWorkpieceIdsRef.current === null) {
      knownWorkpieceIdsRef.current = new Set(allGadgets.map(app => app.id))
      return
    }

    const known = knownWorkpieceIdsRef.current
    const newlyCreated = allGadgets.filter(app => !known.has(app.id))
    for (const app of newlyCreated) known.add(app.id)

    const target = newlyCreated.findLast(app =>
      app.chatId !== undefined && app.chatId === effectiveSelectedChatId)
    if (!target) return

    setActiveTab('app')
    setWorkspaceVisibility('open', target.id)
    navigate({
      to: '/workspace/$id',
      params: { id: id! },
      search: (prev: Record<string, unknown>) => ({ ...prev, w: target.id }),
      replace: true,
    })
  }, [workpiecesReady, allGadgets, effectiveSelectedChatId, setWorkspaceVisibility, navigate, id])

  useEffect(() => {
    const handleResize = () => {
      setChatWidth(width => clampChatWidth(width))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // ── chat count / auto-switch ─────────────────────────────────────────────────
  const handleChatCountChange = useCallback((count: number, chatZeroExists: boolean) => {
    setChatCount(count)
    setHasChatZero(chatZeroExists)
  }, [])

  const turnOutputRef = useRef<{
    chatId: number
    wroteFile: boolean
    wroteGadgetCode: boolean
    userSelectedTab: boolean
  } | null>(null)

  const handleAgentActiveChange = useCallback((chatId: number, isActive: boolean) => {
    if (chatId !== selectedChatIdRef.current) return
    setIsAgentActive(isActive)
    if (isActive) {
      turnOutputRef.current = {
        chatId,
        wroteFile: false,
        wroteGadgetCode: false,
        userSelectedTab: false,
      }
      return
    }

    let output = turnOutputRef.current
    turnOutputRef.current = null
    if (!output || output.chatId !== chatId || output.userSelectedTab) return
    if (output.wroteGadgetCode) setActiveTab('app')
    else if (output.wroteFile) setActiveTab('code')
  }, [])

  const handleStreamingActiveFileChange = useCallback(
      (chatId: number, file: ActiveFileTarget | null | undefined) => {
    if (file && chatId === selectedChatIdRef.current) {
      let output = turnOutputRef.current
      if (!output || output.chatId !== chatId) {
        output = {chatId, wroteFile: false, wroteGadgetCode: false, userSelectedTab: false}
        turnOutputRef.current = output
      }
      output.wroteFile = true
      if (file.filename === 'client.js' || file.filename === 'server.js') {
        output.wroteGadgetCode = true
      }
      if (!output.userSelectedTab) setActiveTab('code')
    }
    setStreamingActiveFileState({chatId, file})
  }, [])

  const handleTabSelect = useCallback((tab: RightTab) => {
    let output = turnOutputRef.current
    if (output?.chatId === selectedChatIdRef.current) output.userSelectedTab = true
    setActiveTab(tab)
  }, [])

  useEffect(() => {
    setProposedChanges(undefined)
    setDraftProposedChanges(undefined)
    setStreamingProposedChanges(undefined)
    setStreamingActiveFileState(null)
    setHasCode(null)
    setChatCount(null)
    setHasChatZero(false)
    setHasAnyProposedChanges(false)
    setSelectedChatHasProposedChanges(false)
    setWorkspaceView(getStoredWorkspaceView(id))
    openedWorkpieceParamRef.current = null
    activityReturnViewRef.current = null
    setActivityClosing(false)
    setWorkspaceTransitionEnabled(false)
    setWorkpieces(new Map())
    setWorkpiecesReady(false)
    knownWorkpieceIdsRef.current = null
    turnOutputRef.current = null
    setUserNavigatedToList(false)
  }, [id])

  // ── navigation helper ────────────────────────────────────────────────────────
  const navigateToChat = useCallback(
    (chatId: number | null, options?: { replace?: boolean }) => {
      setUserNavigatedToList(chatId === null)
      // Draft apps can only be previewed from their creating conversation.
      const pendingChatId = selectedGadgetSummary?.chatId
      const leavingPendingApp = pendingChatId !== undefined && chatId !== pendingChatId
      if (leavingPendingApp) {
        setWorkspaceTransitionEnabled(true)
        if (workspaceView?.mode === 'activity') {
          activityReturnViewRef.current = { mode: 'chat' }
        } else {
          setWorkspaceView({ mode: 'chat' })
        }
      }
      navigate({
        to: '/workspace/$id',
        params: { id: id! },
        // Keep committed selections, but clear draft selections outside their branch.
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          chat: chatId !== null ? chatId : undefined,
          w: leavingPendingApp
            ? undefined
            : typeof prev.w === 'number' ? prev.w : undefined,
        }),
        replace: options?.replace,
      })
    },
    [id, navigate, selectedGadgetSummary?.chatId, workspaceView?.mode]
  )

  // ── keep single-chat routing aligned with the current mode ──────────────────
  // Keep the URL aligned with simple mode's implied chat-0 selection.
  useEffect(() => {
    if (!layoutModeReady) return

    if (simpleMode) {
      if (urlChatId === 0) {
        navigate({
          to: '/workspace/$id',
          params: { id: id! },
          search: (prev: Record<string, unknown>) => ({ ...prev, chat: undefined }),
          replace: true,
        })
      }
      return
    }

    if (pinInitialChatSelection && urlChatId === null) {
      navigateToChat(0, { replace: true })
    }
  }, [layoutModeReady, simpleMode, pinInitialChatSelection, urlChatId, navigateToChat, navigate, id])

  // ── resize handle ─────────────────────────────────────────────────────────────
  //
  // Pointer capture keeps resizing reliable when dragging across the gadget iframe.
  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!showFullEditor) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      setIsResizing(true)
    },
    [showFullEditor],
  )
  const handleResizePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      setChatWidth(clampChatWidth(e.clientX))
    },
    [],
  )
  const handleResizePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      const width = e.type === 'pointercancel'
        ? chatWidthRef.current
        : clampChatWidth(e.clientX)
      setChatWidth(width)
      persistChatWidth(width)
      setIsResizing(false)
    },
    [persistChatWidth],
  )

  useEffect(() => {
    if (!isResizing) return
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isResizing])

  // ── workpiece list subscription ───────────────────────────────────────────────
  useEffect(() => {
    if (!overseer) return
    let sub: RpcStub<{}> | null = null
    let cancelled = false
    const subscriber = new WorkpiecesSubscriberImpl(
      update => setWorkpieces(update),
      initial => {
        setWorkpieces(initial)
        setWorkpiecesReady(true)
      },
    )
    overseer.stub
      .subscribeToWorkpieces(subscriber)
      .then(s => {
        if (cancelled) { s[Symbol.dispose](); return }
        sub = s
      })
      .catch(err => console.error('Failed to subscribe to workpieces:', err))
    return () => {
      cancelled = true
      subscriber.cancel()
      sub?.[Symbol.dispose]()
    }
  }, [overseer])

  // ── selected gadget stub ────────────────────────────────────────────────────────
  // Open a GadgetClient for the selected workpiece. getGadget() pipelines on the overseer stub,
  // so the stub is usable immediately with no extra round trip.
  useEffect(() => {
    if (!overseer || selectedGadgetId === null) {
      setGadget(null)
      return
    }
    const stub = overseer.stub.getGadget(selectedGadgetId)
    setGadget({ id: selectedGadgetId, stub })
    return () => { stub[Symbol.dispose]() }
  }, [overseer, selectedGadgetId])

  // ── follow the agent across gadgets ─────────────────────────────────────────────
  // When the agent starts editing a gadget other than the selected one, switch the picker to it,
  // unless the user picked a workpiece themselves during this turn.
  const userPickedWorkpieceThisTurnRef = useRef(false)
  useEffect(() => {
    userPickedWorkpieceThisTurnRef.current = false
  }, [isAgentActive])

  useEffect(() => {
    const target = streamingActiveFile
    if (target == null || target.workpieceId === selectedGadgetId) return
    if (userPickedWorkpieceThisTurnRef.current) return
    if (!visibleGadgets.some(g => g.id === target.workpieceId)) return
    navigate({
      to: '/workspace/$id',
      params: { id: id! },
      search: (prev: Record<string, unknown>) => ({ ...prev, w: target.workpieceId }),
      replace: true,
    })
  }, [streamingActiveFile, selectedGadgetId, visibleGadgets, navigate, id])

  // ── workpiece picker handlers ───────────────────────────────────────────────────
  const handleSelectWorkpiece = useCallback((workpieceId: WorkpieceId) => {
    if (isAgentActive) userPickedWorkpieceThisTurnRef.current = true
    // Picking a gadget is a deliberate move to its view, so the turn must not pull the tab back.
    handleTabSelect('app')
    setWorkspaceVisibility('open', workpieceId)
    const pendingChatId = workpieces.get(workpieceId)?.chatId
    navigate({
      to: '/workspace/$id',
      params: { id: id! },
      // Selecting a draft also returns to its creating conversation.
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        chat: pendingChatId ?? (typeof prev.chat === 'number' ? prev.chat : undefined),
        w: workpieceId,
      }),
    })
  }, [id, navigate, isAgentActive, setWorkspaceVisibility, workpieces, handleTabSelect])

  const handleRenameWorkpiece = useCallback(async (workpieceId: WorkpieceId, title: string) => {
    if (!overseer) return
    // The subscription delivers the updated summary, so no local state change is needed.
    const target = overseer.stub.getGadget(workpieceId)
    try {
      await target.setTitle(title)
    } catch {
      toasts.add({ title: 'Failed to rename gadget', variant: 'error' })
    } finally {
      target[Symbol.dispose]()
    }
  }, [overseer, toasts])

  // ── console log subscription ──────────────────────────────────────────────────
  useEffect(() => {
    if (!overseer) return
    let sub: RpcStub<{}> | null = null
    let cancelled = false
    overseer.stub
      .subscribeToConsoleLogs(consoleLogSubscriberRef.current)
      .then(s => {
        if (cancelled) { s[Symbol.dispose](); return }
        sub = s
      })
      .catch(err => console.error('Failed to subscribe to console logs:', err))
    return () => { cancelled = true; sub?.[Symbol.dispose]() }
  }, [overseer])

  // ── reload UI when preview branch/code changes ────────────────────────────────
  useEffect(() => { setUiReloadTrigger(t => t + 1) }, [previewChatId, proposedChanges])

  // ── user info ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    authenticatedApi.whoami().then(setUserInfo).catch(() => {})
  }, [authenticatedApi])

  // ── title save/cancel ─────────────────────────────────────────────────────────
  const handleSaveTitle = async () => {
    if (!overseer || !titleInput.trim()) return
    try {
      await overseer.stub.setTitle(titleInput.trim())
      updateTitle(titleInput.trim())
      setIsEditingTitle(false)
    } catch { toasts.add({ title: 'Failed to update title', variant: 'error' }) }
  }
  const handleCancelEdit = () => {
    setTitleInput(metadata?.title || '')
    setIsEditingTitle(false)
  }

  // ── back ──────────────────────────────────────────────────────────────────────
  const handleGoToWorkspaces = () => {
    navigate({ to: '/workspaces' })
  }

  // ── delete ────────────────────────────────────────────────────────────────────
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDeleteConfirm = async () => {
    if (!overseer) return
    setIsDeleting(true)
    try {
      await overseer.stub.deleteSelf()
      navigate({ to: '/' })
    } catch {
      toasts.add({ title: 'Failed to delete workspace', variant: 'error' })
      setIsDeleting(false)
      setDeleteDialogOpen(false)
    }
  }

  // ── shared height tokens ──────────────────────────────────────────────────────
  const TOPBAR_H = 56   // h-14 (matches home page Header)
  const TABBAR_H = 48   // h-12
  const RIGHT_CONTENT_H = `calc(100vh - ${TOPBAR_H}px - ${TABBAR_H}px)`

  // ── error / loading states ────────────────────────────────────────────────────
  if (error?.kind === 'open') {
    return (
      <WorkspaceOpenErrorPage
        kind={error.failure}
        onGoToWorkspaces={handleGoToWorkspaces}
        onRetry={retryOpen}
      />
    )
  }

  if (error?.kind === 'message') {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base">
        {/* Observer-verification denials list one line per failed connection, so preserve newlines. */}
        <p className="text-sm text-kumo-danger whitespace-pre-line text-center max-w-lg">
          {error.message}
        </p>
        <div className="flex items-center gap-2">
          <WorkshopButton tone="secondary" onClick={handleGoToWorkspaces}>
            Go to workspaces
          </WorkshopButton>
          <WorkshopButton tone="primary" onClick={retryOpen}>
            Try again
          </WorkshopButton>
        </div>
      </div>
    )
  }

  // Wait for the workpiece list (and the first selected-gadget stub, which follows it by one
  // effect pass) before rendering; a workspace with no gadgets renders with `gadget` null.
  if (!metadata || !overseer || !workpiecesReady ||
      (selectedGadgetId !== null && gadget === null)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-kumo-base">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-kumo-subtle">Loading workspace…</p>
        </div>
        {observerConfig && (
          <ObserverConfigModal
            needs={observerConfig.needs}
            authenticatedApi={authenticatedApi}
            onConfirm={observerConfig.resolve}
            onCancel={cancelObserverConfig}
          />
        )}
      </div>
    )
  }

  // ── "use"-role collaborators get the minimal UI: top bar + gadget iframe only ──
  if (isUseOnly) {
    return (
      <GadgetUseView
        overseer={overseer.stub}
        gadget={selectedGadgetStub}
        selectedGadgetId={selectedGadgetId}
        gadgets={visibleGadgets}
        onSelectGadget={handleSelectWorkpiece}
        metadata={metadata}
        authenticatedApi={authenticatedApi}
        currentUserId={userInfo?.id ?? null}
      />
    )
  }

  // ── always render the full two-pane edit layout; preview overlays on top ──────
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-kumo-base relative">
      {/* ═══ SHARED TOP BAR (visible in both modes) ════════════════════════════ */}
      <div
        className="relative flex items-center justify-between px-4 sm:px-6 backdrop-blur-md border-b border-kumo-line flex-shrink-0 gap-3"
        style={{ height: TOPBAR_H, backgroundColor: 'color-mix(in srgb, var(--color-kumo-base) 80%, transparent)' }}
      >
        <TopBarNotice />
        {/* Left: logo / title */}
        <div className="flex items-center gap-2 min-w-0">
          <Link
            to="/"
            aria-label="Home"
            className="flex-shrink-0 hover:opacity-80 transition-opacity"
          >
            <SiteLogo size={22}>
              <Hexagon size={22} className="text-kumo-brand" weight="bold" />
            </SiteLogo>
          </Link>

          <span className="text-kumo-inactive flex-shrink-0">/</span>

          {isEditingTitle ? (
            <div className="flex items-center gap-1">
              <WorkshopInput
                type="text"
                value={titleInput}
                onChange={e => setTitleInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveTitle()
                  if (e.key === 'Escape') handleCancelEdit()
                }}
                autoFocus
                className="!h-7 w-56 bg-kumo-tint text-[14px] leading-5 font-medium tracking-[-0.25px]"
              />
              <WorkshopIconButton
                onClick={handleSaveTitle}
                disabled={!titleInput.trim()}
                className="!h-7 !w-7 hover:text-kumo-brand disabled:opacity-30"
                aria-label="Save workspace title"
              >
                <Check size={14} />
              </WorkshopIconButton>
              <WorkshopIconButton
                onClick={handleCancelEdit}
                className="!h-7 !w-7"
                aria-label="Cancel title edit"
              >
                <X size={14} />
              </WorkshopIconButton>
            </div>
          ) : (
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default truncate">
                {metadata.title}
              </span>
              <WorkshopIconButton
                onClick={() => setIsEditingTitle(true)}
                className="!h-7 !w-7 flex-shrink-0"
                title="Rename workspace"
                aria-label="Rename workspace"
              >
                <Pencil size={16} />
              </WorkshopIconButton>
            </div>
          )}

          {metadata.owner && (
            <span className="text-xs text-kumo-inactive flex-shrink-0">
              by {metadata.owner.name}
            </span>
          )}
        </div>

        {/* Right: presence, cost, workspace, share, blueprints */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <GadgetPresence
            overseer={overseer.stub}
            authenticatedApi={authenticatedApi}
            currentUserId={userInfo?.id ?? null}
          />

          {metadata.totalCost != null && (
            <span className="mr-2 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              {formatHeaderCost(metadata.totalCost)}
            </span>
          )}

          <ActivityNotifications
            overseer={overseer.stub}
            pendingActions={pendingActions}
            onViewActivity={openActivity}
          />

          {connectionLost && <ReconnectingChip />}

          <WorkshopIconButton
            onClick={() => setShareModalOpen(true)}
            title="Share workspace"
            aria-label="Share workspace"
          >
            <ShareNetwork size={15} />
          </WorkshopIconButton>

          <WorkshopIconButton
            onClick={() => setBlueprintModalOpen(true)}
            disabled={!selectedGadgetStub}
            title="Blueprints"
            aria-label="Blueprints"
          >
            <Blueprint size={16} />
          </WorkshopIconButton>

          {!metadata.owner && (
            <WorkshopIconButton
              danger
              onClick={() => setDeleteDialogOpen(true)}
              title="Delete workspace"
              aria-label="Delete workspace"
            >
              <Trash size={16} />
            </WorkshopIconButton>
          )}

          {/* User menu */}
          <div className="ml-2">
            <UserMenu />
          </div>
        </div>
      </div>

      {/* ═══ BODY ═════════════════════════════════════════════════════════════ */}
      <div className="flex flex-1 min-h-0 relative overflow-hidden">

        {isAgentActive && (
          <div
            className="absolute left-0 h-0 z-10"
            style={{ top: simpleMode ? 0 : TABBAR_H, right: outputRailWidth }}
          >
            <div className="absolute left-0 right-0 h-0.5 bg-kumo-fill overflow-hidden">
              <div className="absolute inset-y-0 w-1/3 bg-kumo-brand animate-[thinking_1.5s_ease-in-out_infinite]" />
            </div>
          </div>
        )}

        {/* ── LEFT: Chat pane ──────────────────────────────────────────────────── */}
        <div
          className={`flex flex-col flex-shrink-0 ${workspaceTransitionClass} ${showFullEditor ? 'border-r border-kumo-line' : ''}`}
          style={{
            width: showFullEditor
              ? chatWidth
              : `calc(100% - ${outputRailWidth}px)`,
          }}
        >
          {overseer ? (
            <div className="flex-1 min-h-0 relative">
              <div className={layoutModeReady ? 'h-full' : 'h-full invisible'}>
                <ChatInterface
                  key={id}
                  overseer={overseer.stub}
                  selectedChatId={effectiveSelectedChatId}
                  onNavigateToChat={navigateToChat}
                  onProposedChangesChange={setProposedChanges}
                  onDraftProposedChangesChange={setDraftProposedChanges}
                  onStreamingProposedChangesChange={updates => setStreamingProposedChanges(updates)}
                  onStreamingActiveFileChange={handleStreamingActiveFileChange}
                  pendingConsoleLogCount={consoleLogCount}
                  consoleLogPreview={
                    consoleLogCount > 0 ? formatConsoleLogs(consoleLogBufferRef.current) : ''
                  }
                  consoleLogSeverity={
                    consoleLogBufferRef.current.some(l => l.level === 'error')
                      ? 'error'
                      : consoleLogBufferRef.current.some(l => l.level === 'warn')
                      ? 'warn'
                      : 'info'
                  }
                  onConsumeConsoleLogs={consumeConsoleLogs}
                  onDiscardConsoleLogs={discardConsoleLogs}
                  constrainChatWidth
                  onChatCountChange={handleChatCountChange}
                  onAgentActiveChange={handleAgentActiveChange}
                  onAutoApproveChange={() => setAutoApproveReloadTrigger(t => t + 1)}
                  onHasAnyCodeChange={setHasAnyProposedChanges}
                  onSelectedChatHasProposedChangesChange={setSelectedChatHasProposedChanges}
                  onOpenGadget={handleSelectWorkpiece}
                  outputOfWorkpiece={outputOfWorkpiece}
                />
              </div>

              {!layoutModeReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-kumo-base">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-6 h-6 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-kumo-subtle">Loading conversation…</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>

        {/* ── Resize handle ───────────────────────────────────────────────────── */}
        <div
          className={`flex-shrink-0 overflow-visible bg-kumo-line cursor-col-resize relative touch-none ${workspaceTransitionClass}`}
          style={{ width: showFullEditor ? 1 : 0 }}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
        >
          <div className="absolute inset-y-0 -left-2 -right-2" />
        </div>

        {/* ── RIGHT: App / Code / Connections tabs ───────────────────────────── */}
        <div
          className={`flex flex-shrink-0 min-w-0 overflow-hidden bg-kumo-base ${workspaceTransitionClass}`}
          style={{
            width: showFullEditor ? `calc(100% - ${chatWidth}px - 1px)` : 0,
            opacity: showFullEditor ? 1 : 0,
          }}
        >
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <div
            className="flex items-center gap-2 border-b border-kumo-line px-3 flex-shrink-0"
            style={{ height: TABBAR_H }}
          >
            <div className="flex min-w-0 flex-1 items-center overflow-hidden">
              {paneShowsActivity ? (
                <PaneLabel icon={Pulse} title="Activity" />
              ) : visibleGadgets.length > 1 ? (
                <PaneWorkpieceTabs
                  gadgets={visibleGadgets}
                  activeId={selectedGadgetId}
                  onSelect={handleSelectWorkpiece}
                />
              ) : selectedGadgetSummary && (
                <PaneLabel
                  output={selectedGadgetSummary.output}
                  title={selectedGadgetSummary.title}
                  badge={selectedGadgetSummary.chatId !== undefined ? 'Draft' : undefined}
                />
              )}
            </div>

            <div className="flex flex-shrink-0 items-center gap-1.5">
              <div className="flex items-center rounded-lg border border-kumo-line p-0.5">
                {paneShowsActivity
                  ? ACTIVITY_TABS.map(tab => (
                    <PaneTab
                      key={tab.value}
                      active={activityView === tab.value}
                      label={tab.label}
                      count={tab.value === 'review' ? pendingActionsCount : undefined}
                      onClick={() => setActivityView(tab.value)}
                    />
                  ))
                  : rightTabs(selectedGadgetSummary?.output).map(tab => (
                    <PaneTab
                      key={tab.value}
                      active={activeTab === tab.value}
                      label={tab.label}
                      onClick={() => handleTabSelect(tab.value)}
                    />
                  ))}
              </div>

              {!paneShowsActivity && (
                <GadgetExportMenu
                  gadget={selectedGadgetStub}
                  gadgetTitle={selectedGadgetSummary?.title ?? 'Gadget'}
                  chatId={previewChatId}
                  disabled={activeTab !== 'app' || previewMode}
                />
              )}

              {!paneShowsActivity && (
                <WorkshopIconButton
                  aria-label="Enter full screen"
                  title={activeTab === 'app' && !previewMode
                    ? 'Full screen'
                    : `Full screen is available in ${formatOf(selectedGadgetSummary?.output).noun} view`}
                  onClick={enterGadgetFullscreen}
                  disabled={activeTab !== 'app' || previewMode}
                >
                  <ArrowsOutSimple size={17} />
                </WorkshopIconButton>
              )}

              <WorkshopIconButton
                aria-label={paneShowsActivity ? 'Close activity' : 'Close gadget pane'}
                title="Close"
                onClick={closeWorkspacePane}
              >
                <X size={16} />
              </WorkshopIconButton>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden">
            {paneShowsActivity && (
              <Activity
                overseer={overseer.stub}
                view={activityView}
                onViewChange={setActivityView}
                onAutoApproveChange={() => setAutoApproveReloadTrigger(t => t + 1)}
                autoApproveReloadTrigger={autoApproveReloadTrigger}
              />
            )}
            <div className={paneShowsActivity ? 'hidden' : 'contents'}>
            <div
              ref={fullscreenOverlayRef}
              tabIndex={isGadgetFullscreen ? -1 : undefined}
              role={isGadgetFullscreen ? 'dialog' : undefined}
              aria-modal={isGadgetFullscreen ? true : undefined}
              aria-label={isGadgetFullscreen ? 'Gadget full screen' : undefined}
              className={
                activeTab !== 'app' || previewMode
                  ? 'hidden'
                  : isGadgetFullscreen
                    ? 'fixed inset-0 z-20 bg-kumo-base outline-none'
                    : 'h-full'
              }
            >
              {selectedGadgetStub && !previewMode ? (
                <GadgetUI
                  key={selectedGadgetId}
                  gadget={selectedGadgetStub}
                  height={isGadgetFullscreen ? '100%' : RIGHT_CONTENT_H}
                  reloadTrigger={uiReloadTrigger}
                  isVisible={activeTab === 'app' && !previewMode}
                  chatId={previewChatId}
                  onConsoleLog={handleClientConsoleLog}
                  onIframeEscape={isGadgetFullscreen ? exitGadgetFullscreen : undefined}
                />
              ) : !previewMode && (
                <NoGadgetPlaceholder height={RIGHT_CONTENT_H} />
              )}
              {isGadgetFullscreen && showFullscreenHint && (
                <div
                  role="status"
                  aria-live="polite"
                  className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 transform"
                >
                  <div className="rounded-full border border-kumo-line bg-kumo-base/90 px-4 py-1.5 text-[13px] leading-[18px] text-kumo-default shadow-md backdrop-blur-sm">
                    Press <kbd className="rounded border border-kumo-line bg-kumo-elevated px-1.5 py-0.5 text-[11px] font-medium">Esc</kbd> to exit full screen
                  </div>
                </div>
              )}
            </div>

            <div className={activeTab === 'code' ? 'h-full' : 'hidden'}>
              {overseer && selectedFilesRoot !== undefined ? (
                <GadgetCodeInterface
                  overseer={overseer.stub}
                  filesRoot={selectedFilesRoot}
                  height={RIGHT_CONTENT_H}
                  onCodeChange={() => setUiReloadTrigger(t => t + 1)}
                  selectedChatId={effectiveSelectedChatId}
                  proposedChanges={proposedChanges}
                  draftProposedChanges={draftProposedChanges}
                  streamingProposedChanges={streamingProposedChanges}
                  streamingActiveFile={streamingActiveFileForSelected}
                  isAgentActive={isAgentActive}
                  isVisible={activeTab === 'code'}
                  onHasCodeChange={setHasCode}
                />
              ) : (
                <NoGadgetPlaceholder height={RIGHT_CONTENT_H} />
              )}
            </div>

            <div className={activeTab === 'connections' ? 'h-full overflow-auto' : 'hidden'}>
              {overseer && selectedGadgetStub ? (
                <Connections
                  key={selectedGadgetId}
                  overseer={overseer.stub}
                  gadget={selectedGadgetStub}
                  chatId={effectiveSelectedChatId ?? undefined}
                  authenticatedApi={authenticatedApi}
                  onConnectionsChange={() => setUiReloadTrigger(t => t + 1)}
                  isVisible={activeTab === 'connections'}
                  onHasGatekeepersChange={setHasBindings}
                />
              ) : (
                <NoGadgetPlaceholder height={RIGHT_CONTENT_H} />
              )}
            </div>

            </div>
          </div>
          </div>
        </div>

        {showOutputRail && (
          <WorkpiecePicker
            gadgets={allGadgets}
            selectedId={null}
            agentEditingId={streamingActiveFile?.workpieceId ?? null}
            hookedGadgetIds={hookedGadgetIds}
            expanded={workpieceRailExpanded}
            onExpandedChange={handleWorkpieceRailExpandedChange}
            onSelect={handleSelectWorkpiece}
            onRename={handleRenameWorkpiece}
            pendingActivityCount={pendingActionsCount}
            onOpenActivity={() => openActivity(pendingActionsCount > 0 ? 'review' : 'history')}
          />
        )}
      </div>

      {/* ═══ PREVIEW OVERLAY ══════════════════════════════════════════════════ */}
      {previewMode && (
        <div className="absolute inset-x-0 bottom-0 bg-kumo-base z-10" style={{ top: TOPBAR_H }}>
          {selectedGadgetStub && (
            <GadgetUI
              key={selectedGadgetId}
              gadget={selectedGadgetStub}
              height="100%"
              reloadTrigger={uiReloadTrigger}
              isVisible={true}
              chatId={previewChatId}
              onConsoleLog={handleClientConsoleLog}
            />
          )}
        </div>
      )}

      {/* Share modal */}
      {overseer && metadata && (
        <>
          <ShareModal
            open={shareModalOpen}
            onClose={() => setShareModalOpen(false)}
            overseer={overseer.stub}
            metadata={metadata}
            currentUser={userInfo}
            authenticatedApi={authenticatedApi}
          />
          {selectedGadgetStub && (
            <BlueprintModal
              open={blueprintModalOpen}
              onClose={() => setBlueprintModalOpen(false)}
              overseer={overseer.stub}
              gadget={selectedGadgetStub}
              metadata={metadata}
            />
          )}
        </>
      )}

      <DeleteConfirmationDialog
        open={deleteDialogOpen}
        title="Delete workspace?"
        description={<>This removes <span className="font-medium text-kumo-default">{metadata.title}</span>. You can&apos;t undo this.</>}
        isDeleting={isDeleting}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
      />

    </div>
  )
}
