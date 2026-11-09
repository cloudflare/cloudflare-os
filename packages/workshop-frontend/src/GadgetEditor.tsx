import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useParams, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { backToOriginLabel, type AppPageOrigin } from './features/gadget-page/appPageOrigin'
import { logRpcFailure } from './rpcErrors'
import { DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import {
  Check,
  GitBranch,
  Pulse,
} from '@phosphor-icons/react'
import { RpcStub, RpcTarget } from 'capnweb'
import { useAuthenticatedApi } from './AuthContext'
import { useConnectionLost, useRpcStub } from './RpcContext'

import {
  GadgetClient,
  GadgetAccessMode,
  ObserverConfigCallback,
  AiChatAuthorInfo,
  AiChatMetadata,
  ConsoleLogSubscriber,
  ConsoleLogEvent,
  WorkpieceId,
  WorkpieceSummary,
  GadgetSummary,
  WorktreeSummary,
  BlueprintOutput,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import ObserverConfigModal from './ObserverConfigModal'
import WorkpieceCodeInterface from './features/code/WorkpieceCodeInterface'
import type { ChatContentReader } from './features/code/otClient'
import GadgetUI from './GadgetUI'
import GadgetUseView from './GadgetUseView'
import Connections from './Connections'
import Activity, { type ActivityView } from './Activity'
import { CountBadge } from './components/CountBadge'
import { DraftFileIcon } from './features/drafts/DraftFileIcon'
import { DraftReviewPane } from './features/drafts/DraftReviewPane'
import { allDrafts, gadgetDraftGroups, OPEN_LABEL, type DraftGroup } from './features/drafts/drafts'
import { GadgetApprovalMode, GadgetDraftsTray } from './features/drafts/GadgetDrafts'
import { safeExternalUrl } from './utils/safeExternalUrl'
import ChatInterface, {
  type ActiveFileTarget,
  type ChatCodeChanges,
  type ChatLiveChangeRows,
  type ChatLiveEditPreviews,
  type ChatHead,
} from './ChatInterface'
import { formatOf } from './components/format/formats'
import { FormatGlyph } from './components/format/FormatVisuals'
import { WorkspaceInviteModal } from './features/sharing/WorkspaceInviteModal'
import { GadgetShareModal } from './features/sharing/GadgetShareModal'
import { GadgetPresence } from './components/GadgetPresence'
import BlueprintModal from './BlueprintModal'
import { UpdateFromBlueprintDialog } from './features/blueprint-updates/UpdateFromBlueprintDialog'
import { useBlueprintUpdateAvailable } from './features/blueprint-updates/useBlueprintUpdateAvailable'
import { reportVisibleChat } from './features/notifications/visibleChat'
import { WorkshopButton } from './components/WorkshopControls'
import { useActions } from './useActions'
import WorkspaceOpenErrorPage from './components/WorkspaceOpenErrorPage'
import { ObserverConfigTarget, observerOpenFailureMessage, useWorkspaceOpen } from './useWorkspaceOpen'
import { answerFromMemory, readExploreMemory, writeExploreMemory } from './features/shared-view/exploreMemory'
import GadgetExportMenu from './GadgetExportMenu'
import { ChatHeader, PaneHeader, PaneSheet, type PaneChoice } from './features/chat-page/ChatPageChrome'
import { CONTENT_CARD_CLASS, useBareShell } from './components/AppShell/shellChrome'
import { MENU_CONTENT, MENU_ITEM } from './components/menuStyles'
import { WorkspacePage, type WorkspaceTab } from './pages/workspace/WorkspacePage'
import { ChatDetailsPage, type ChatDetailsTab } from './pages/chat-details/ChatDetailsPage'
import { AutomationList } from './features/automations/AutomationList'
import { ChatAutomationsLink } from './features/automations/ChatAutomationsLink'
import { BackgroundAppOverview } from './features/apps/BackgroundAppOverview'
import { AgentList } from './features/automations/AgentList'
import { AppSettingsPage } from './pages/app-settings/AppSettingsPage'
import { NoAccessApp, SharedAppFrame } from './pages/shared-app/SharedAppPage'

// The canvas between the chat card and the pane card, which is also the handle that resizes them.
const PANE_GUTTER = 12

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

/** Whether a gadget file draws its UI: its client.js, or a module beside it. */
const isUiFile = (filename: string) => /(^|\/)client(\/|\.)/.test(filename)
// An upstream that names no blueprint records that the gadget was built from scratch. No upstream
// at all is different: a blueprint's draft has none until its creation is accepted, an older
// gadget's origin is unknown, and a "use" collaborator is not told.
const isScratchBuild = (gadget: GadgetSummary) =>
  gadget.upstream !== undefined && gadget.upstream.blueprintId === undefined

type RightTab = 'app' | 'code' | 'connections'

type WorkspaceView =
  | { mode: 'chat' }
  // `appId` is absent only while lazily migrating the legacy "open" value.
  | { mode: 'app'; appId?: WorkpieceId }
  | { mode: 'activity' }

// The first tab is named after what the selected workpiece is ("Document" for a gadget built from
// a document blueprint), falling back to "App" when it declares no format. A worktree has no app
// and no bindings, so it gets only Code.
function rightTabs(summary: WorkpieceSummary | undefined): { value: RightTab; label: string }[] {
  if (summary?.type === 'worktree') return [{ value: 'code', label: 'Code' }]
  return [
    { value: 'app', label: formatOf(summary?.output).noun },
    { value: 'code', label: 'Code' },
    { value: 'connections', label: 'Connections' },
  ]
}

// How a workpiece is drawn in tabs and labels: a gadget by its format, a worktree as a branch.
function WorkpieceGlyph({ summary, className }: { summary: WorkpieceSummary; className?: string }) {
  if (summary.type === 'worktree') {
    return <GitBranch size={11} className={className} weight="regular" />
  }
  return <FormatGlyph output={summary.output} size="sm" className={className} weight="regular" />
}

const ACTIVITY_TABS: { value: ActivityView; label: string }[] = [
  { value: 'review', label: 'Needs review' },
  { value: 'auto', label: 'Auto-approval' },
  { value: 'history', label: 'History' },
]

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
const MIN_CHAT_WIDTH = 280
const MIN_WORKSPACE_WIDTH = 400
// The design splits a 14" screen evenly: a 608px chat beside a 608px pane.
const DEFAULT_CHAT_WIDTH = 608
const WORKSPACE_TRANSITION_MS = 200

const isBrowser = typeof window !== 'undefined'

// Below Tailwind's `md` breakpoint the chat and the workspace pane take turns filling the screen
// (the `max-md:` classes in the layout below), where above it they sit side by side. The query is
// the one `max-md:` compiles to, so the two agree at fractional widths and at any root font size.
const isSinglePaneLayout = () => window.matchMedia?.('(width < 48rem)').matches ?? false

// `available` is the width of the row the chat and the pane share, which the sidebar leaves short
// of the window's.
function clampChatWidth(width: number, available?: number) {
  if (!isBrowser) return Math.max(MIN_CHAT_WIDTH, Math.min(DEFAULT_CHAT_WIDTH, width))
  const max = Math.max(MIN_CHAT_WIDTH, (available ?? window.innerWidth) - PANE_GUTTER - MIN_WORKSPACE_WIDTH)
  return Math.max(MIN_CHAT_WIDTH, Math.min(max, width))
}

// The chat width that puts the gutter's grabbed point (`grab` px right of the chat's edge) under
// the pointer, measured from the left of the row the gutter sits in.
function chatWidthAt(e: ReactPointerEvent<HTMLDivElement>, grab: number) {
  const row = e.currentTarget.parentElement?.getBoundingClientRect()
  return clampChatWidth(e.clientX - (row?.left ?? 0) - grab, row?.width)
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

// The menu item that opens the "Update from blueprint" dialog, in the desktop and mobile menus.
const UpdateFromBlueprintLabel = ({ updateAvailable }: { updateAvailable: boolean }) => (
  <>
    <span className="min-w-0 flex-1">Update from blueprint…</span>
    {updateAvailable && (
      <span className="ml-3 flex-shrink-0 text-[11px] leading-4 font-medium text-kumo-brand">
        Update available
      </span>
    )}
  </>
)

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

/**
 * A page of one app the editor shows instead of the workspace: the app full screen at its own
 * address, or its settings.
 */
export type EditorAppPage = { kind: 'app' | 'settings'; appId: WorkpieceId; from?: AppPageOrigin }

export default function GadgetEditor({ page }: { page?: EditorAppPage } = {}) {
  const params = useParams({ strict: false }) as { id?: string }
  const id = params.id
  const navigate = useNavigate()
  const router = useRouter()
  const { authenticatedApi } = useAuthenticatedApi()
  const publicApi = useRpcStub()

  const { chat: chatParam, w: workpieceParam, showChat: showChatParam, tab: workspaceTab = 'chats', details: detailsTab } =
    useSearch({ strict: false }) as {
      chat?: number; w?: number; showChat?: true; tab?: WorkspaceTab; details?: ChatDetailsTab
    }
  const urlChatId = chatParam !== undefined ? chatParam : null
  const urlWorkpieceId = page ? page.appId : workpieceParam !== undefined ? workpieceParam : null

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
  // has no (visible) gadgets, and while a use-only collaborator's gadget is being admitted.
  // `mode` is set for a use-only collaborator, who may be shown the owner's view instead.
  const [gadget, setGadget] = useState<
    { id: WorkpieceId; stub: RpcStub<GadgetClient>; mode?: GadgetAccessMode } | null>(null)

  // The selected chat's title and whether an agent started it, reported by the chat, for the header.
  const [chatHead, setChatHead] = useState<ChatHead | null>(null)
  // The workspace's chats as the chat reports them, for the workspace page shown when none is open.
  const [chatList, setChatList] = useState<readonly AiChatMetadata[] | null>(null)

  const rpcConnectionLost = useConnectionLost()
  const {
    overseer,
    metadata,
    error,
    connectionLost,
    observerConfig,
    createObserverConfigCallback,
    retry: retryOpen,
    cancelObserverConfig,
  } = useWorkspaceOpen({
    id,
    authenticatedApi,
    onMetadata: () => {},
    onShareKeyConsumed: () => {
      // Keep the gadget a link to one gadget opens on; drop the rest of the address.
      if (id && page) navigate({
        to: page.kind === 'app' ? '/workspace/$id/app/$appId' : '/workspace/$id/app/$appId/settings',
        params: { id, appId: String(page.appId) },
        replace: true,
      })
      else if (id) navigate({
        to: '/workspace/$id',
        params: { id },
        search: urlWorkpieceId === null ? {} : { w: urlWorkpieceId },
        replace: true,
      })
    },
    onInvalidShareKey: () => {
      toasts.add({ title: 'Invalid or expired share link.', variant: 'error' })
    },
  })
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)

  // The workspace-level flag covers reopen failures; the socket-level flag covers the outage
  // window itself, during which the dead stub stays published and no reopen is attempted yet.
  const showReconnecting = connectionLost || rpcConnectionLost

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
  const [chosenTab, setActiveTab] = useState<RightTab>('app')
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(() =>
    getStoredWorkspaceView(id)
  )
  const [workspaceTransitionEnabled, setWorkspaceTransitionEnabled] = useState(false)
  const activityReturnViewRef = useRef<WorkspaceView | null>(null)
  const [activityView, setActivityView] = useState<ActivityView>('history')
  const [activityClosing, setActivityClosing] = useState(false)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  // The gadget the share dialog shares, or null when it invites people to the whole workspace.
  const [sharedGadgetId, setSharedGadgetId] = useState<WorkpieceId | null>(null)
  const openShareModal = (gadgetId: WorkpieceId | null) => {
    setSharedGadgetId(gadgetId)
    setShareModalOpen(true)
  }
  const [blueprintModalOpen, setBlueprintModalOpen] = useState(false)
  const [blueprintUpdateDialogOpen, setBlueprintUpdateDialogOpen] = useState(false)
  const [previewMode, _setPreviewMode] = useState(false)
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
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)

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
      if (focusBeforeFullscreenRef.current.isConnected) {
        focusBeforeFullscreenRef.current.focus()
      } else {
        mobileMenuButtonRef.current?.focus()
      }
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
  // The selected chat's code-branch snapshot (see ChatCodeChanges in ChatInterface): its code
  // base and the current epoch's recorded changes, plumbed from the chat subscription into the
  // code view, which layers them over the per-pin commit-derived doc base.
  const [chatChanges, setChatChanges] = useState<ChatCodeChanges | undefined>(undefined)
  // The selected chat's live (unmaterialized) change row stream, stable per chat; the code view
  // subscribes to it rather than reading rows through renders (see ChatLiveChangeRows).
  const [liveRows, setLiveRows] = useState<ChatLiveChangeRows | undefined>(undefined)
  const [chatDrafts, setChatDrafts] = useState<readonly DraftGroup[]>([])
  // The drafts the pane reviews, kept once they are all decided so the pane can say how it went.
  const [reviewedDrafts, setReviewedDrafts] = useState<DraftGroup | null>(null)
  // The selected chat's live edit-preview stream (the agent's in-progress writeFile/editFile
  // content), likewise subscription-shaped (see ChatLiveEditPreviews).
  const [liveEditPreviews, setLiveEditPreviews] =
    useState<ChatLiveEditPreviews | undefined>(undefined)
  // The selected chat's uncommitted content as the code view holds it, plumbed the other way:
  // the chat reads it to look for unresolved merge conflicts before accepting.
  const [chatContent, setChatContent] = useState<ChatContentReader | undefined>(undefined)
  const [streamingActiveFileState, setStreamingActiveFileState] = useState<{
    chatId: number
    file: ActiveFileTarget | null | undefined
  } | null>(null)
  const [hasCode, setHasCode] = useState<boolean | null>(null)
  const [chatCount, setChatCount] = useState<number | null>(null)
  const [hasChatZero, setHasChatZero] = useState(false)
  const [_hasBindings, setHasBindings] = useState(false)
  const [isAgentActive, setIsAgentActive] = useState(false)
  // The workpieces any chat proposes changes to (see AiChatMetadata.proposedChangeWorkpieces).
  const [anyChatProposedWorkpieces, setAnyChatProposedWorkpieces] =
    useState<readonly WorkpieceId[]>([])
  // The workpieces the selected chat proposes changes to (see
  // AiChatMetadata.proposedChangeWorkpieces): drives per-gadget draft previews below.
  const [selectedChatProposedWorkpieces, setSelectedChatProposedWorkpieces] =
    useState<readonly WorkpieceId[]>([])
  const selectedChatId = urlChatId
  const chatListReady = chatCount !== null
  const singleInitialChat = chatCount === 1 && hasChatZero
  const [userNavigatedToList, setUserNavigatedToList] = useState(false)

  // Gadgets are the workspace's apps: the ones that can be the open app, be previewed, hold
  // bindings, and be persisted as the workspace's view. Worktrees are chat-private repositories
  // with only code to show; they ride alongside as pending gadgets do, and never affect the
  // workspace's layout mode: a second chat shares nothing with the first until an accepted gadget
  // exists.
  const allGadgets = useMemo(() => {
    return [...workpieces.values()]
      .filter((w): w is GadgetSummary => w.type === 'gadget')
      .toSorted((a, b) => a.id - b.id)
  }, [workpieces])
  const allWorktrees = useMemo(() => {
    return [...workpieces.values()]
      .filter((w): w is WorktreeSummary => w.type === 'worktree')
      .toSorted((a, b) => a.id - b.id)
  }, [workpieces])
  const isWorktreeId = (workpieceId: WorkpieceId) => workpieces.get(workpieceId)?.type === 'worktree'

  // Whether an accepted gadget exists, known synchronously from the workpiece summaries (every
  // permanent gadget has a head commit; a draft has none). Not the code view's `hasCode`, which
  // reflects whichever workpiece is selected -- a worktree included -- and on the first accept
  // arrives only after the new head's tree loads.
  const hasCommittedCode = allGadgets.some(g => g.commitId !== undefined)

  // Before any gadget has been accepted, a single-thread workspace conceptually only has one
  // useful conversation, so keep chat 0 selected even if the URL has not caught up yet. As soon as
  // an accepted gadget exists, dropping back to the chat list should become possible.
  // A named workspace has a page of its own to land on, so only a lone chat is pinned this way.
  // A chat started outside any workspace stays its own chat for good: the workspace made to hold
  // it is never shown, however many apps it builds or agent conversations it starts.
  const namedWorkspace = metadata?.kind === 'workspace'
  const chatsOwnWorkspace = !!metadata && !namedWorkspace
  const pinInitialChatSelection = chatsOwnWorkspace ||
    (singleInitialChat && !hasCommittedCode && !userNavigatedToList && !namedWorkspace)
  const effectiveSelectedChatId = selectedChatId ?? (pinInitialChatSelection ? 0 : null)

  // ── workpiece selection ──────────────────────────────────────────────────────

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
      if (workpiece.type === 'gadget' && workpiece.output) outputs.set(workpiece.id, workpiece.output)
    }
    workpieceOutputsRef.current = outputs
    return JSON.stringify([...outputs])
  }, [workpieces])
  const gadgetTitles = useMemo(() => new Map(allGadgets.map(g => [g.id, g.title])), [allGadgets])
  // The apps the selected chat built, whose automations are the chat's too.
  const selectedChatAppIds = useMemo(() => allGadgets
    .filter(g => effectiveSelectedChatId !== null
      && (g.chatId === effectiveSelectedChatId || g.madeInChatId === effectiveSelectedChatId))
    .map(g => g.id), [allGadgets, effectiveSelectedChatId])
  const titleOfWorkpiece = useCallback(
    (workpieceId: WorkpieceId) => gadgetTitles.get(workpieceId),
    [gadgetTitles],
  )

  const outputOfWorkpiece = useCallback(
    (workpieceId: WorkpieceId) => workpieceOutputsRef.current.get(workpieceId),
    [outputSignature],
  )

  const visibleGadgets = useMemo(() => {
    return allGadgets.filter(w =>
      w.chatId === undefined || w.chatId === effectiveSelectedChatId)
  }, [allGadgets, effectiveSelectedChatId])

  // Everything the pane can show for the selected chat: the visible gadgets, then the chat's own
  // worktrees (a worktree is chat-scoped for its whole life, exactly as a pending gadget is
  // until accepted).
  const visibleWorkpieces: WorkpieceSummary[] = useMemo(() => [
    ...visibleGadgets,
    ...allWorktrees.filter(w => w.chatId === effectiveSelectedChatId),
  ], [visibleGadgets, allWorktrees, effectiveSelectedChatId])

  // Gadgets still pending (created within) the selected chat: their chat content builds up from
  // nothing rather than from a pinned commit (see WorkpieceCodeInterface's pendingGadgetIds).
  const pendingGadgetIds = useMemo(() => new Set(
    allGadgets.filter(w => w.chatId !== undefined && w.chatId === effectiveSelectedChatId)
      .map(w => w.id)
  ), [allGadgets, effectiveSelectedChatId])

  // The selected workpiece: explicit URL state wins, followed by the one open in this session
  // (only accepted apps are persisted), then the one last shown, then the workspace default and
  // the first visible one. Closing the pane forgets the first two while it is still sliding shut,
  // so without the last-shown step another app would flash into it on the way out.
  // Keyed by workspace: workpiece ids repeat across workspaces.
  const lastSelectedWorkpieceRef = useRef<{ workspaceId?: string; id: WorkpieceId | null }>({ id: null })
  const selectedWorkpieceId = useMemo(() => {
    if (urlWorkpieceId !== null && visibleWorkpieces.some(g => g.id === urlWorkpieceId)) {
      return urlWorkpieceId
    }
    const storedId = workspaceView?.mode === 'app' ? workspaceView.appId : undefined
    if (storedId !== undefined && visibleWorkpieces.some(g => g.id === storedId)) {
      return storedId
    }
    const last = lastSelectedWorkpieceRef.current
    const lastId = last.workspaceId === id ? last.id : null
    if (lastId !== null && visibleWorkpieces.some(g => g.id === lastId)) {
      return lastId
    }
    const defaultId = metadata?.defaultGadgetId
    if (defaultId !== undefined && visibleGadgets.some(g => g.id === defaultId)) {
      return defaultId
    }
    return visibleWorkpieces.length > 0 ? visibleWorkpieces[0].id : null
  }, [urlWorkpieceId, workspaceView, visibleWorkpieces, visibleGadgets, metadata?.defaultGadgetId, id])
  lastSelectedWorkpieceRef.current = { workspaceId: id, id: selectedWorkpieceId }

  const selectedWorkpieceSummary = selectedWorkpieceId !== null
    ? visibleWorkpieces.find(g => g.id === selectedWorkpieceId)
    : undefined
  // The selected workpiece when it is a gadget: the app-only surfaces (preview, Connections,
  // export, blueprints) key off this and render their empty states for a worktree.
  const selectedGadgetSummary =
    selectedWorkpieceSummary?.type === 'gadget' ? selectedWorkpieceSummary : undefined
  const selectedGadgetId = selectedGadgetSummary?.id ?? null
  // A gadget still pending in a chat has no committed code for an update to be merged into.
  const canUpdateFromBlueprint = selectedGadgetSummary?.commitId !== undefined
  // A gadget built from scratch has no blueprint whose update it could sensibly take.
  const builtFromScratch = selectedGadgetSummary !== undefined && isScratchBuild(selectedGadgetSummary)
  const blueprintUpdateAvailable =
    useBlueprintUpdateAvailable(publicApi, selectedGadgetSummary?.upstream)
  // A worktree has only Code; the chosen tab is remembered for the next gadget.
  const activeTab: RightTab = selectedWorkpieceSummary?.type === 'worktree' ? 'code' : chosenTab

  // Lazily normalize legacy "open" preferences once the accepted app list is known. Draft apps
  // remain session-only until accepted; at that point this effect persists them automatically.
  // A worktree is never persisted: it is chat-scoped and has no app.
  useEffect(() => {
    if (!id || !workpiecesReady || workspaceView?.mode !== 'app') return

    if (workspaceView.appId !== undefined) {
      const chosen = workpieces.get(workspaceView.appId)
      if (chosen?.type === 'worktree' || chosen?.chatId !== undefined) return
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
  }, [id, workpiecesReady, workspaceView, workpieces, allGadgets, metadata?.defaultGadgetId])

  // The stub for the selected gadget arrives via an effect; during a switch it briefly lags the
  // selection, in which case gadget-dependent views render their empty states for a frame.
  const selectedGadgetStub =
    gadget !== null && gadget.id === selectedGadgetId ? gadget.stub : null
  // Only the selected chat's streaming drives this editor. Everything downstream then narrows it
  // further to the selected workpiece.
  const streamingActiveFile = streamingActiveFileState?.chatId === effectiveSelectedChatId
    ? streamingActiveFileState.file
    : undefined
  // The file the agent is streaming edits into, when it is in the selected workpiece. (Edits
  // going to a different one instead auto-switch the picker; see the effect below.)
  const streamingActiveFileForSelected =
    streamingActiveFile != null && streamingActiveFile.workpieceId === selectedWorkpieceId
      ? streamingActiveFile.filename
      : undefined

  const overseerStub = overseer?.stub ?? null
  const { pending: pendingActions } = useActions(overseerStub)
  const pendingActionCount = pendingActions.length

  // Whether the *selected* gadget has code. When none is selected, the code interface is either
  // unmounted or showing a worktree, whose code doesn't bear on the layout mode.
  const effectiveHasCode = selectedGadgetSummary !== undefined
    ? hasCode
    : workpiecesReady ? false : null

  const codeStateReady = effectiveHasCode !== null
  const hasCodeRelatedState = effectiveHasCode === true
    // (A chat may also propose worktrees, and edits to an agent spawner's bindings.)
    || anyChatProposedWorkpieces.some(w => workpieces.get(w)?.type === 'gadget')
    || (streamingActiveFile != null && !isWorktreeId(streamingActiveFile.workpieceId))
  const layoutModeReady = chatListReady && (codeStateReady || hasCodeRelatedState)

  // Use-only shells stay visible during gadget admission so the picker can switch away. Builders
  // wait for the first selected-gadget stub before rendering the editor.
  const workspaceLoading = !metadata || !overseer || !workpiecesReady ||
    (!isUseOnly && selectedGadgetId !== null && gadget === null)
  // layoutModeReady survives a failed reopen and its retry, which show error and loading pages.
  const chatRendered = layoutModeReady && !error && !workspaceLoading

  // Wait for all initial subscriptions before choosing the new-workspace chat-only layout.
  // `hasCommittedCode` matters here too: on the first accept the proposed changes clear before the
  // new head's tree arrives, and simple mode must not flash on during that window -- the
  // URL-alignment effect below would strip the chat from the URL. (Kept out of layoutModeReady /
  // hasCodeRelatedState so initial-load sequencing is unchanged.)
  const simpleMode = layoutModeReady && !hasCodeRelatedState && !hasCommittedCode
    && singleInitialChat && visibleGadgets.length <= 1
  // The pane can only show a workpiece visible for the selected chat, so it opens for an app only
  // when there is one: with no chat selected in a workspace of drafts and worktrees alone, an open
  // pane would be empty.
  const hasVisibleWorkpieces = visibleWorkpieces.length > 0
  const showingActivity = workspaceView?.mode === 'activity'
  // With no view chosen yet, the pane opens for an app that may have something to show. One the
  // agent is building from scratch waits until it writes a UI, which opens the pane then (see
  // the effect that follows the agent), so an app that only runs in the background leaves the
  // chat as it is.
  const hasViewableWorkpiece = visibleWorkpieces.some(w => w.type !== 'gadget' || !isScratchBuild(w))
  const showFullEditor = layoutModeReady && (
    showingActivity || (hasVisibleWorkpieces && (workspaceView === null
      ? !simpleMode && hasViewableWorkpiece
      : workspaceView.mode === 'app'))
  )
  const paneShowsActivity = showingActivity || activityClosing
  useEffect(() => {
    if (!activityClosing) return
    const timeout = window.setTimeout(() => setActivityClosing(false), WORKSPACE_TRANSITION_MS)
    return () => window.clearTimeout(timeout)
  }, [activityClosing])
  const workspaceTransitionClass = workspaceTransitionEnabled && !isResizing
    ? 'transition-[width,opacity] duration-200 ease-out'
    : ''

  // Show the selected chat's draft only when it proposes changes to the *selected* gadget: a
  // chat that touched some other gadget would otherwise run this one as a needlessly separate
  // chat-scoped instance with identical code (the backend applies the same per-gadget rule in
  // getGadgetFacetFetcher).
  const previewChatId =
    effectiveSelectedChatId !== null && selectedGadgetId !== null &&
        selectedChatProposedWorkpieces.includes(selectedGadgetId)
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
    if (!visibleWorkpieces.some(g => g.id === urlWorkpieceId)) return
    openedWorkpieceParamRef.current = urlWorkpieceId
    setWorkspaceVisibility('open', urlWorkpieceId)
  }, [workpiecesReady, urlWorkpieceId, visibleWorkpieces, setWorkspaceVisibility])

  const openActivity = useCallback((initialView: ActivityView) => {
    setReviewedDrafts(null)
    setWorkspaceTransitionEnabled(true)
    setActivityClosing(false)
    if (workspaceView?.mode !== 'activity') activityReturnViewRef.current = workspaceView
    setActivityView(initialView)
    setWorkspaceView({ mode: 'activity' })
  }, [workspaceView])

  const openDraftReview = useCallback((group: DraftGroup) => {
    openActivity(activityView)
    setReviewedDrafts(group)
  }, [openActivity, activityView])

  const closeWorkspacePane = useCallback(() => {
    if (workspaceView?.mode === 'activity') setReviewedDrafts(null)
    if (workspaceView?.mode !== 'activity') {
      setWorkspaceVisibility('closed')
      // The closed view is what this workspace reopens with, so the address must stop naming the
      // app: otherwise a reload reads it as a link to that app and opens the pane again.
      if (page === undefined && urlWorkpieceId !== null) {
        navigate({
          to: '/workspace/$id',
          params: { id: id! },
          search: (prev: Record<string, unknown>) => ({ ...prev, w: undefined }),
          replace: true,
        })
      }
      return
    }
    setWorkspaceTransitionEnabled(true)
    const returnView = activityReturnViewRef.current
    const returnShowsPane = hasVisibleWorkpieces && (returnView?.mode === 'app'
      || (returnView === null && !simpleMode))
    setActivityClosing(!returnShowsPane)
    setWorkspaceView(returnView)
    activityReturnViewRef.current = null
  }, [workspaceView, setWorkspaceVisibility, hasVisibleWorkpieces, simpleMode, page, urlWorkpieceId, navigate, id])

  // Ignore the initial listing, then open apps the active chat makes from a blueprint. An app
  // built from scratch opens instead when the agent first writes its UI (see the effect that
  // follows the agent), so one that only runs in the background never takes over the screen.
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
      app.chatId !== undefined && app.chatId === effectiveSelectedChatId
        && !isScratchBuild(app))
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
      setChatWidth(width => clampChatWidth(width, resizeHandleRef.current?.parentElement?.clientWidth))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // ── chat count / auto-switch ─────────────────────────────────────────────────
  const handleChatCountChange = useCallback((count: number, chatZeroExists: boolean) => {
    setChatCount(count)
    setHasChatZero(chatZeroExists)
  }, [])

  // The tab auto-switch exists only to show a user building their first gadget what the agent is
  // doing: while the app tab shows the "No gadget UI yet" placeholder, the turn's edits are shown
  // in the code tab, and the end of the turn returns to the app. It never navigates away from a
  // gadget that has a UI, and any tab choice by the user ends it for the turn.
  const turnOutputRef = useRef<{
    chatId: number
    wroteFile: boolean
    showedCode: boolean
    userSelectedTab: boolean
  } | null>(null)
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab
  const appShowsNoUiRef = useRef(false)

  // Called both when the agent writes and when the placeholder appears, since a freshly created
  // gadget's first UI load can finish after the agent has started writing.
  const showCodeIfNoUi = useCallback(() => {
    const output = turnOutputRef.current
    if (!output?.wroteFile || output.userSelectedTab) return
    if (output.chatId !== selectedChatIdRef.current) return
    if (activeTabRef.current !== 'app' || !appShowsNoUiRef.current) return
    output.showedCode = true
    setActiveTab('code')
  }, [])

  const handleNoUiChange = useCallback((showsNoUi: boolean) => {
    appShowsNoUiRef.current = showsNoUi
    if (showsNoUi) showCodeIfNoUi()
  }, [showCodeIfNoUi])

  const handleAgentActiveChange = useCallback((chatId: number, isActive: boolean) => {
    if (chatId !== selectedChatIdRef.current) return
    setIsAgentActive(isActive)
    if (isActive) {
      turnOutputRef.current = {
        chatId,
        wroteFile: false,
        showedCode: false,
        userSelectedTab: false,
      }
      return
    }

    let output = turnOutputRef.current
    turnOutputRef.current = null
    if (!output || output.chatId !== chatId || output.userSelectedTab) return
    if (output.showedCode) setActiveTab('app')
  }, [])

  const handleStreamingActiveFileChange = useCallback(
      (chatId: number, file: ActiveFileTarget | null | undefined) => {
    if (file && chatId === selectedChatIdRef.current) {
      let output = turnOutputRef.current
      if (!output || output.chatId !== chatId) {
        output = {chatId, wroteFile: false, showedCode: false, userSelectedTab: false}
        turnOutputRef.current = output
      }
      output.wroteFile = true
      showCodeIfNoUi()
    }
    setStreamingActiveFileState({chatId, file})
  }, [showCodeIfNoUi])

  const handleTabSelect = useCallback((tab: RightTab) => {
    let output = turnOutputRef.current
    if (output?.chatId === selectedChatIdRef.current) output.userSelectedTab = true
    setActiveTab(tab)
  }, [])

  useEffect(() => {
    setChatChanges(undefined)
    setLiveRows(undefined)
    setStreamingActiveFileState(null)
    setHasCode(null)
    setChatCount(null)
    setHasChatZero(false)
    setAnyChatProposedWorkpieces([])
    setSelectedChatProposedWorkpieces([])
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

  // ?showChat (a notification's "Open task") asks to see the chat, not merely select it: full-screen
  // preview covers it, and on a phone so does the pane. Declared after the reset above, so arriving
  // from another workspace beats its stored view; dropped once honoured, so the next request for
  // the same chat works too.
  useEffect(() => {
    if (!showChatParam) return
    exitGadgetFullscreen()
    if (isSinglePaneLayout()) setWorkspaceVisibility('closed')
    navigate({
      to: '/workspace/$id',
      params: { id: id! },
      search: (prev: Record<string, unknown>) => ({ ...prev, showChat: undefined }),
      replace: true,
    })
  }, [showChatParam, id, navigate, setWorkspaceVisibility, exitGadgetFullscreen])

  // Notifications and read receipts apply only to the chat on screen, not one covered by a
  // full-screen preview or, on a phone, by the workspace pane.
  useEffect(() => {
    if (!chatRendered || isGadgetFullscreen || effectiveSelectedChatId === null) return
    const chat = { workspaceId: id!, chatId: effectiveSelectedChatId }
    return reportVisibleChat(() => showFullEditor && isSinglePaneLayout() ? null : chat)
  }, [chatRendered, isGadgetFullscreen, effectiveSelectedChatId, id, showFullEditor])

  // ── navigation helper ────────────────────────────────────────────────────────
  const navigateToChat = useCallback(
    (chatId: number | null, options?: { replace?: boolean }) => {
      setUserNavigatedToList(chatId === null)
      // Draft apps can only be previewed from their creating conversation; worktrees are theirs
      // for life.
      const pendingChatId = selectedWorkpieceSummary?.chatId
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
          tab: chatId !== null ? undefined : prev.tab as WorkspaceTab | undefined,
          details: undefined,
          w: leavingPendingApp
            ? undefined
            : typeof prev.w === 'number' ? prev.w : undefined,
        }),
        replace: options?.replace,
      })
    },
    [id, navigate, selectedWorkpieceSummary?.chatId, workspaceView?.mode]
  )

  // ── keep single-chat routing aligned with the current mode ──────────────────
  // Keep the URL aligned with simple mode's implied chat-0 selection.
  useEffect(() => {
    if (!layoutModeReady) return

    if (simpleMode) {
      // A named workspace keeps the chat in its address, or it would show the workspace's page.
      if (urlChatId === 0 && !namedWorkspace) {
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
  }, [layoutModeReady, simpleMode, pinInitialChatSelection, urlChatId, navigateToChat, navigate, id, namedWorkspace])

  // ── resize handle ─────────────────────────────────────────────────────────────
  //
  // Pointer capture keeps resizing reliable when dragging across the gadget iframe. The width is
  // measured from the row the chat starts, not the window, since the sidebar sits to its left; and
  // the point grabbed on the gutter stays under the pointer, so pressing it moves nothing.
  const resizeHandleRef = useRef<HTMLDivElement>(null)
  const resizeGrabRef = useRef(0)
  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!showFullEditor) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      const row = e.currentTarget.parentElement?.getBoundingClientRect()
      resizeGrabRef.current = e.clientX - (row?.left ?? 0) - chatWidthRef.current
      setIsResizing(true)
    },
    [showFullEditor],
  )
  const handleResizePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      setChatWidth(chatWidthAt(e, resizeGrabRef.current))
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
        : chatWidthAt(e, resizeGrabRef.current)
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
  // Open a GadgetClient for the selected workpiece when it is a gadget. (A worktree has no
  // GadgetClient -- getGadget() would throw -- so `selectedGadgetId` is null for one.) Waits for
  // metadata, whose role decides how:
  //
  // - Opening the workspace verified everyone but use-only collaborators, so getGadget()
  //   pipelines on the overseer stub, which is usable immediately with no extra round trip.
  // - A use-only collaborator is verified as each gadget opens, so its account prompts (and
  //   repairs of failed choices) are routed to the picker, and its UI mounts only once admission
  //   succeeds: the bundle timeout must not include time spent choosing accounts. A refusal is
  //   kept per gadget, since failing one leaves the others open. Re-admitting the gadget on screen
  //   (after a reconnect) leaves its UI mounted until the new stub arrives; anything else that
  //   holds a stub disposed below is cleared, so no UI can mount on one.
  const [gadgetOpenFailure, setGadgetOpenFailure] =
    useState<{ id: WorkpieceId; message: string } | null>(null)
  const [gadgetOpenAttempt, setGadgetOpenAttempt] = useState(0)
  // Read through a ref: the toast manager is a new object each render, and the admission below
  // must not rerun (and reopen the gadget) on every render.
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const metadataLoaded = metadata !== null
  useEffect(() => {
    if (!overseer || !metadataLoaded || selectedGadgetId === null) {
      setGadget(null)
      return
    }
    if (!isUseOnly) {
      const stub = overseer.stub.getGadget(selectedGadgetId)
      setGadget({ id: selectedGadgetId, stub })
      return () => {
        stub[Symbol.dispose]()
        // The next run sets its stub in the same effect flush, so this never unmounts a builder's
        // UI; it keeps the admission below from retaining this stub if the role narrows.
        setGadget(null)
      }
    }

    // Silent first: without a prompt, the gadget opens live when the collaborator's remembered
    // accounts can read it, or as the owner's view when there is one; only when neither holds is
    // the collaborator asked to choose accounts. A check this browser saw refused is retried with
    // the same accounts, still silently, so access granted since takes effect unasked.
    const abort = new AbortController()
    const remembered = id ? readExploreMemory(id, selectedGadgetId) : null
    const retry = remembered?.refusedChoices
    const silentCallback = retry
      ? new RpcStub(new ObserverConfigTarget(async needs => answerFromMemory(needs, retry)))
      : undefined
    const silent = overseer.stub.getGadget(selectedGadgetId, silentCallback)
    let interactive: { admission: Disposable; callback: RpcStub<ObserverConfigCallback> } | null = null
    let stub: RpcStub<GadgetClient> | null = null
    setGadget(previous => previous?.id === selectedGadgetId ? previous : null)
    setGadgetOpenFailure(null)

    const admit = async (opened: RpcStub<GadgetClient>) => {
      try {
        const mode = await opened.getAccessMode()
        // Kept through a duplicate, which outlives disposing what the admission resolved to.
        if (abort.signal.aborted) return
        stub = opened.dup()
        setGadget({ id: selectedGadgetId, stub, mode })
        if (mode === 'live' && remembered?.mode === 'view') {
          toastsRef.current.add({ title: 'You have access now, so you can use it yourself' })
        }
        if (id) {
          writeExploreMemory(id, selectedGadgetId,
            mode === 'view' ? { mode, ...(retry && { refusedChoices: retry }) } : { mode })
        }
      } finally {
        opened[Symbol.dispose]()
      }
    }
    const refuse = (caught: unknown) => {
      if (abort.signal.aborted) return
      setGadget(null)
      setGadgetOpenFailure({
        id: selectedGadgetId,
        message: observerOpenFailureMessage(caught, 'gadget') ?? 'This gadget couldn’t be opened.',
      })
    }
    silent.then(admit, () => {
      if (abort.signal.aborted) return
      // Neither live nor a view: ask for accounts, as an unshared gadget always has.
      const callback = createObserverConfigCallback(abort.signal)
      const admission = overseer.stub.getGadget(selectedGadgetId, callback)
      interactive = { admission, callback }
      admission.then(admit, refuse)
    }).catch(refuse)
    return () => {
      abort.abort()
      silent[Symbol.dispose]()
      silentCallback?.[Symbol.dispose]()
      interactive?.admission[Symbol.dispose]()
      interactive?.callback[Symbol.dispose]()
      stub?.[Symbol.dispose]()
    }
  }, [overseer, metadataLoaded, selectedGadgetId, isUseOnly, createObserverConfigCallback,
      gadgetOpenAttempt, id])

  // ── follow the agent across gadgets ─────────────────────────────────────────────
  // When the agent starts editing a gadget other than the selected one, switch the picker to it,
  // unless the user picked a workpiece themselves during this turn. A worktree is followed only
  // while the pane already shows a workpiece: selecting via `?w=` opens the pane, and a worktree
  // is never opened automatically.
  const userPickedWorkpieceThisTurnRef = useRef(false)
  useEffect(() => {
    userPickedWorkpieceThisTurnRef.current = false
  }, [isAgentActive])

  useEffect(() => {
    const target = streamingActiveFile
    if (target == null || target.workpieceId === selectedWorkpieceId) return
    if (userPickedWorkpieceThisTurnRef.current) return
    const targetSummary = visibleWorkpieces.find(g => g.id === target.workpieceId)
    if (!targetSummary) return
    if (targetSummary.type === 'worktree' && (!showFullEditor || showingActivity)) return
    // A closed pane opens only for something to see: an app's UI (client.js). An app that only
    // runs in the background (a schedule's or a hook's code) has none, so building it leaves the
    // chat as it is, and it stays one click away in the chat's Library.
    if (!showFullEditor && !isUiFile(target.filename)) return
    navigate({
      to: '/workspace/$id',
      params: { id: id! },
      search: (prev: Record<string, unknown>) => ({ ...prev, w: target.workpieceId }),
      replace: true,
    })
  }, [streamingActiveFile, selectedWorkpieceId, visibleWorkpieces, showFullEditor, showingActivity,
      navigate, id])

  // ── workpiece picker handlers ───────────────────────────────────────────────────
  const handleSelectWorkpiece = useCallback((workpieceId: WorkpieceId) => {
    if (isAgentActive) userPickedWorkpieceThisTurnRef.current = true
    const picked = workpieces.get(workpieceId)
    // Picking a workpiece is a deliberate move to its view, so the turn must not pull the tab
    // back. A worktree has only Code.
    handleTabSelect(picked?.type === 'worktree' ? 'code' : 'app')
    setWorkspaceVisibility('open', workpieceId)
    const pendingChatId = picked?.chatId
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
  useEffect(() => {
    // Every loaded chat has a code snapshot, even when it has no proposed changes. Only a chat
    // that actually owns the preview should invalidate the iframe; chatId changes themselves
    // remount GadgetUISession when entering or leaving a preview.
    if (previewChatId !== undefined && chatChanges?.chatId === previewChatId) {
      setUiReloadTrigger(t => t + 1)
    }
  }, [previewChatId, chatChanges])

  // ── user info ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    authenticatedApi.whoami().then(setUserInfo).catch(() => {})
  }, [authenticatedApi])

  // ── back ──────────────────────────────────────────────────────────────────────
  const handleGoToWorkspaces = () => {
    navigate({ to: '/workspaces' })
  }

  // ── shared height tokens ──────────────────────────────────────────────────────
  const TOPBAR_H = 0

  // Account prompts can arrive whenever something is opened: the workspace while it loads, or a
  // gadget once it has, for a collaborator given individual gadgets.
  const observerConfigModal = observerConfig && (
    <ObserverConfigModal
      needs={observerConfig.needs}
      authenticatedApi={authenticatedApi}
      onConfirm={observerConfig.resolve}
      onCancel={cancelObserverConfig}
    />
  )
  // Gone if it was deleted while shared, which closes its dialog.
  const sharedGadget = sharedGadgetId === null ? undefined : allGadgets.find(g => g.id === sharedGadgetId)

  // An app's settings say what it is for in its template's words, when it came from one.
  const [appDescription, setAppDescription] = useState<string | undefined>(undefined)
  const settingsBlueprintId = page?.kind === 'settings' ? selectedGadgetSummary?.upstream?.blueprintId : undefined
  useEffect(() => {
    setAppDescription(undefined)
    if (!settingsBlueprintId) return
    let cancelled = false
    publicApi.getBlueprint(settingsBlueprintId).then(
      info => { if (!cancelled) setAppDescription(info?.metadata.description || undefined) },
      err => console.error('Failed to read the gadget\'s blueprint:', err))
    return () => { cancelled = true }
  }, [publicApi, settingsBlueprintId])

  // The chat and its pane are cards of their own on the canvas; the states below sit in the
  // shell's single card.
  useBareShell(!error && !workspaceLoading && !isUseOnly && page === undefined)

  // What the app pages need: the app's address, the way back to its workspace, and what it's for.
  const appLink = page && `${window.location.origin}/workspace/${id}/app/${page.appId}`
  const openAppPage = (kind: EditorAppPage['kind'], appId: WorkpieceId) => navigate(kind === 'app'
    ? { to: '/workspace/$id/app/$appId', params: { id: id!, appId: String(appId) } }
    : {
        to: '/workspace/$id/app/$appId/settings', params: { id: id!, appId: String(appId) },
        search: { from: namedWorkspace ? 'workspace' : 'chat' },
      })
  // Back from an app's own page to the workspace, with the app open in the pane. A chat started
  // outside any workspace has no workspace page to show, so that returns to the chat, the one
  // that built the app if it is known.
  const leaveAppPage = () => {
    if (page) setWorkspaceVisibility('open', page.appId)
    const chat = namedWorkspace ? undefined : selectedGadgetSummary?.madeInChatId ?? 0
    navigate({
      to: '/workspace/$id',
      params: { id: id! },
      search: { ...(page ? { w: page.appId } : {}), ...(chat === undefined ? {} : { chat }) },
    })
  }
  // Back from an app's own page to where it was opened from: the page before it when there is
  // one, so a list keeps its tab and scroll; otherwise that page afresh, or for a link followed
  // from elsewhere, the app's workspace (or chat).
  const returnToOrigin = () => {
    if (page?.from && router.history.canGoBack()) router.history.back()
    else if (page?.from === 'library') navigate({ to: '/library', search: { tab: 'gadgets' } })
    else if (page?.from === 'gadget') openAppPage('app', page.appId)
    else leaveAppPage()
  }
  // Renames the gadget on screen from its title pill; the new name arrives through the workpiece
  // list, as any rename does.
  const renameSelectedGadget = (title: string) => {
    selectedGadgetStub?.setTitle(title).catch(err => {
      logRpcFailure('Failed to rename gadget:', err)
      toasts.add({ title: "Couldn't rename the gadget", variant: 'error' })
    })
  }
  const originLabel = backToOriginLabel(page?.from ?? (namedWorkspace ? 'workspace' : 'chat'))

  // ── error / loading states ────────────────────────────────────────────────────
  if (page?.kind === 'app' && error?.kind === 'open' &&
      (error.failure === 'access-denied' || error.failure === 'share-links-disabled')) {
    return (
      <SharedAppFrame title="Gadget" link={appLink}>
        <NoAccessApp link={appLink!} />
      </SharedAppFrame>
    )
  }

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
      <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base">
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

  if (workspaceLoading) {
    return (
      <div className="flex min-h-full items-center justify-center bg-kumo-base">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-kumo-subtle">Loading workspace…</p>
        </div>
        {observerConfigModal}
      </div>
    )
  }

  // The dialogs the workspace's menus and the app's settings open.
  const editorDialogs = (
    <>
      {/* Share modal. Kept mounted while closed, so an invite still in flight reports back when
          it is reopened; keyed by what it shares, so nothing carries over between targets. */}
      {overseer && metadata && (
        <>
          {sharedGadgetId === null ? (
            <WorkspaceInviteModal
              key={metadata.id}
              open={shareModalOpen}
              onClose={() => setShareModalOpen(false)}
              overseer={overseer.stub}
              metadata={metadata}
              currentUser={userInfo}
              authenticatedApi={authenticatedApi}
            />
          ) : sharedGadget && (
            <GadgetShareModal
              key={`${metadata.id}:${sharedGadget.id}`}
              open={shareModalOpen}
              onClose={() => setShareModalOpen(false)}
              overseer={overseer.stub}
              metadata={metadata}
              gadget={sharedGadget}
              currentUser={userInfo}
              authenticatedApi={authenticatedApi}
            />
          )}
          {selectedGadgetStub && (
            <BlueprintModal
              open={blueprintModalOpen}
              onClose={() => setBlueprintModalOpen(false)}
              overseer={overseer.stub}
              gadget={selectedGadgetStub}
              metadata={metadata}
            />
          )}
          {blueprintUpdateDialogOpen && selectedGadgetStub && selectedGadgetSummary && (
            <UpdateFromBlueprintDialog
              gadget={{
                title: selectedGadgetSummary.title,
                upstream: selectedGadgetSummary.upstream,
                client: selectedGadgetStub,
              }}
              overseer={overseer.stub}
              publicApi={publicApi}
              onClose={() => setBlueprintUpdateDialogOpen(false)}
              onProposed={chatId => {
                setBlueprintUpdateDialogOpen(false)
                navigateToChat(chatId)
                // The proposal is in the chat, with whatever the agent says of it, and so is the
                // way to accept it. Where a pane hides the chat, selecting it is not showing it.
                if (isSinglePaneLayout()) setWorkspaceVisibility('closed')
              }}
            />
          )}
        </>
      )}

    </>
  )

  // ── an app full screen, which is all a "use"-role collaborator gets ──────────
  if (isUseOnly || page?.kind === 'app') {
    return (
      <>
        <GadgetUseView
          overseer={overseer.stub}
          gadget={selectedGadgetStub}
          // A builder's own stub carries no mode: it is always live.
          gadgetMode={gadget?.id === selectedGadgetId ? gadget.mode ?? 'live' : null}
          workspaceId={id!}
          // An explore passed; the server kept its accounts, so reopening admits live.
          onGadgetLive={() => setGadgetOpenAttempt(attempt => attempt + 1)}
          selectedGadgetId={selectedGadgetId}
          // Drafts belong to their chat; full screen shows the workspace's apps.
          gadgets={visibleGadgets.filter(g => g.chatId === undefined)}
          // Opened from a list, it goes back there to open another.
          switchable={!page?.from}
          onRename={!isUseOnly && selectedGadgetStub ? renameSelectedGadget : undefined}
          // What the gadget's pane offers, so it reads the same full screen.
          menu={!isUseOnly && selectedGadgetSummary && (
            <>
              <GadgetExportMenu
                gadget={selectedGadgetStub}
                gadgetTitle={selectedGadgetSummary.title}
                asSubmenu={{ itemClassName: MENU_ITEM, contentClassName: MENU_CONTENT }}
              />
              <DropdownMenu.Item
                onClick={() => navigate({
                  to: '/workspace/$id/app/$appId/settings',
                  params: { id: id!, appId: String(selectedGadgetSummary.id) },
                  search: { from: 'gadget' },
                })}
                className={MENU_ITEM}
              >
                Gadget settings
              </DropdownMenu.Item>
            </>
          )}
          onSelectGadget={page ? appId => openAppPage('app', appId) : handleSelectWorkpiece}
          link={appLink ?? (selectedGadgetId !== null ? `${window.location.origin}/workspace/${id}/app/${selectedGadgetId}` : undefined)}
          onCollapse={isUseOnly ? undefined : returnToOrigin}
          collapseLabel={page?.from ? originLabel : undefined}
          // A lost connection breaks the stub too; reconnecting reopens the gadget.
          gadgetOpenFailure={!showReconnecting && gadgetOpenFailure?.id === selectedGadgetId
            ? gadgetOpenFailure.message
            : null}
          onRetryGadget={() => setGadgetOpenAttempt(attempt => attempt + 1)}
          authenticatedApi={authenticatedApi}
          currentUserId={userInfo?.id ?? null}
        />
        {observerConfigModal}
      </>
    )
  }

  // ── an app's settings ─────────────────────────────────────────────────────────
  if (page?.kind === 'settings') {
    return (
      <>
        {selectedGadgetSummary ? (
          <AppSettingsPage
            title={selectedGadgetSummary.title}
            output={selectedGadgetSummary.output}
            description={appDescription}
            canPublish={selectedGadgetStub !== null}
            onBack={returnToOrigin}
            backLabel={originLabel}
            onManageAccess={() => openShareModal(selectedGadgetSummary.id)}
            onPublish={() => setBlueprintModalOpen(true)}
            onDelete={async () => {
              if (!selectedGadgetStub) return
              try {
                await selectedGadgetStub.remove()
                if (page.from === 'library') navigate({ to: '/library', search: { tab: 'gadgets' } })
                else navigate({ to: '/workspace/$id', params: { id: id! }, search: {} })
              } catch (err) {
                console.error('Failed to delete app:', err)
                toasts.add({ title: "Couldn't delete the app", variant: 'error' })
                throw err
              }
            }}
            automations={
              <div className="flex flex-col gap-2">
                <AutomationList
                  overseer={overseer.stub}
                  scope={{ gadgetId: selectedGadgetSummary.id }}
                  empty="Ask a chat to run this gadget on a schedule or when something happens, and it shows up here."
                />
                <AgentList overseer={overseer.stub} workspaceId={id!} gadgetIds={[selectedGadgetSummary.id]} />
              </div>
            }
            connections={selectedGadgetStub && (
              <Connections
                key={selectedGadgetId}
                overseer={overseer.stub}
                gadget={selectedGadgetStub}
                authenticatedApi={authenticatedApi}
                onConnectionsChange={() => setUiReloadTrigger(t => t + 1)}
                isVisible
                onHasGatekeepersChange={setHasBindings}
              />
            )}
          />
        ) : (
          <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-kumo-base">
            <p className="text-sm text-kumo-subtle">This gadget no longer exists.</p>
            <WorkshopButton tone="secondary" onClick={() => leaveAppPage()}>Go to its workspace</WorkshopButton>
          </div>
        )}
        {editorDialogs}
        {observerConfigModal}
      </>
    )
  }

  // ── always render the full two-pane edit layout; preview overlays on top ──────
  const chatHeaderTitle = chatHead?.title ?? (effectiveSelectedChatId === 0 ? metadata.title : 'Chat')
  const chatSpawned = chatHead?.agentStarted ?? false
  // The live drafts of the group the pane reviews; none once every one of them is decided.
  const selectedGadgetDrafts = selectedGadgetSummary && selectedGadgetSummary.chatId === undefined
    ? gadgetDraftGroups(pendingActions, selectedGadgetSummary.id) : []
  const reviewedGroup = reviewedDrafts && (
    [...chatDrafts, ...(reviewedDrafts.key.startsWith('gadget')
      ? gadgetDraftGroups(pendingActions, Number(/^gadget(\d+):/.exec(reviewedDrafts.key)?.[1])) : [])]
      .find(group => group.key === reviewedDrafts.key) ?? { ...reviewedDrafts, drafts: [], holdsAgent: false })
  const reviewedUrl = reviewedGroup ? safeExternalUrl(reviewedGroup.url) : undefined
  const selectedWorkpieceGlyph = selectedWorkpieceSummary
    ? <WorkpieceGlyph summary={selectedWorkpieceSummary} />
    : null
  const paneChoices: PaneChoice[] = visibleWorkpieces.map(workpiece => ({
    id: workpiece.id,
    title: workpiece.title,
    glyph: <WorkpieceGlyph summary={workpiece} />,
    draft: workpiece.type === 'gadget' && workpiece.chatId !== undefined,
  }))
  const viewTabs = rightTabs(selectedWorkpieceSummary)
  // With no chat open the workspace shows its own page in place of the chat and pane. The chat
  // stays mounted beneath it, since it is what keeps the list of chats live.
  const showingOverview = layoutModeReady && effectiveSelectedChatId === null
  const showingDetails = layoutModeReady && effectiveSelectedChatId !== null && detailsTab !== undefined
  const showingPage = showingOverview || showingDetails
  const paneShown = showFullEditor && !showingPage
  const setDetailsTab = (tab: ChatDetailsTab | undefined) => navigate({
    to: '/workspace/$id',
    params: { id: id! },
    search: (prev: Record<string, unknown>) => ({ ...prev, details: tab }),
    replace: tab !== undefined && detailsTab !== undefined,
  })
  const activityPanel = (
    <Activity
      overseer={overseer.stub}
      restricted={metadata?.containsRestrictedData === true}
      view={activityView}
      onViewChange={setActivityView}
      onAutoApproveChange={() => setAutoApproveReloadTrigger(t => t + 1)}
      autoApproveReloadTrigger={autoApproveReloadTrigger}
    />
  )

  return (
    <div className="relative flex h-full overflow-hidden">
      {showingOverview && (
        <div className={`min-w-0 flex-1 overflow-y-auto ${CONTENT_CARD_CLASS}`}>
          <WorkspacePage
            metadata={metadata}
            overseer={overseer.stub}
            chats={chatList}
            gadgets={allGadgets}
            tab={workspaceTab}
            onTabChange={tab => navigate({
              to: '/workspace/$id',
              params: { id: id! },
              search: (prev: Record<string, unknown>) => ({ ...prev, tab: tab === 'chats' ? undefined : tab }),
              replace: true,
            })}
            onOpenChat={chatId => navigateToChat(chatId)}
            onInvite={() => openShareModal(null)}
            activity={activityPanel}
          />
        </div>
      )}
      {showingDetails && (
        <div className={`min-w-0 flex-1 overflow-y-auto ${CONTENT_CARD_CLASS}`}>
          <ChatDetailsPage
            metadata={metadata}
            overseer={overseer.stub}
            chat={chatList?.find(chat => chat.id === effectiveSelectedChatId)}
            gadgets={allGadgets}
            tab={detailsTab}
            onTabChange={setDetailsTab}
            onBack={() => setDetailsTab(undefined)}
            onShare={() => openShareModal(null)}
            onOpenApp={workpieceId => {
              setDetailsTab(undefined)
              handleSelectWorkpiece(workpieceId)
            }}
            onDeleted={() => metadata.kind === 'workspace' ? navigateToChat(null) : navigate({ to: '/' })}
            activity={activityPanel}
          />
        </div>
      )}
      {/* ── Chat card ──────────────────────────────────────────────────────── */}
      <div
        data-card="chat"
        className={`relative flex flex-shrink-0 flex-col overflow-hidden ${CONTENT_CARD_CLASS} max-md:!w-full ${paneShown ? 'max-md:hidden' : ''} ${showingPage ? 'hidden' : ''} ${workspaceTransitionClass}`}
        style={{ width: paneShown ? chatWidth : '100%' }}
      >
        {effectiveSelectedChatId !== null && (
          <ChatHeader
            workspace={{ id: id!, title: metadata.title, named: metadata.kind === 'workspace' }}
            chatId={effectiveSelectedChatId}
            chatTitle={chatHeaderTitle}
            agentStarted={chatSpawned}
            onOpenWorkspace={() => navigateToChat(null)}
            onShare={() => openShareModal(null)}
            automations={<ChatAutomationsLink overseer={overseer.stub} workspaceId={id!} chatId={effectiveSelectedChatId} gadgetIds={selectedChatAppIds} />}
            trailing={<>
              <GadgetPresence
                overseer={overseer.stub}
                authenticatedApi={authenticatedApi}
                currentUserId={userInfo?.id ?? null}
              />
            </>}
          />
        )}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {overseer ? (
            <div className="flex-1 min-h-0 relative">
              <div className={layoutModeReady ? 'h-full' : 'h-full invisible'}>
                <ChatInterface
                  key={id}
                  workspaceId={id}
                  overseer={overseer.stub}
                  restricted={metadata?.containsRestrictedData === true}
                  selectedChatId={effectiveSelectedChatId}
                  onNavigateToChat={navigateToChat}
                  onChatChangesChange={setChatChanges}
                  onLiveRowsChange={setLiveRows}
                  onLiveEditPreviewsChange={setLiveEditPreviews}
                  chatContent={chatContent}
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
                  hideChatHeader
                  onChatHeadChange={setChatHead}
                  hideChatList
                  onChatListChange={setChatList}
                  onChatCountChange={handleChatCountChange}
                  onAgentActiveChange={handleAgentActiveChange}
                  onDraftsChange={setChatDrafts}
                  onReviewDrafts={openDraftReview}
                  onAnyChatProposedChangesChange={setAnyChatProposedWorkpieces}
                  onSelectedChatProposedChangesChange={setSelectedChatProposedWorkpieces}
                  onOpenGadget={handleSelectWorkpiece}
                  outputOfWorkpiece={outputOfWorkpiece}
                  titleOfWorkpiece={titleOfWorkpiece}
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
      </div>

      {/* ── The gutter between the cards, which resizes them ───────────────── */}
      <div
        ref={resizeHandleRef}
        className={`relative z-10 flex-shrink-0 touch-none cursor-col-resize max-md:hidden ${workspaceTransitionClass}`}
        style={{ width: paneShown ? PANE_GUTTER : 0 }}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat"
      />

      {/* ── Pane card: an app, its code or connections, or the activity ────── */}
      <div
        data-card="pane"
        className={`flex flex-shrink-0 min-w-0 flex-col overflow-hidden ${CONTENT_CARD_CLASS} max-md:!w-full max-md:!opacity-100 ${!paneShown ? 'max-md:hidden' : ''} ${showingPage ? 'hidden' : ''} ${workspaceTransitionClass}`}
        style={{
          width: paneShown ? `calc(100% - ${chatWidth}px - ${PANE_GUTTER}px)` : 0,
          opacity: paneShown ? 1 : 0,
        }}
      >
        {paneShowsActivity && reviewedGroup ? (
          <PaneHeader
            glyph={<DraftFileIcon kind={reviewedGroup.kind} size={14} />}
            title={reviewedGroup.title}
            badge={reviewedGroup.drafts.length > 0 ? 'Draft' : undefined}
            actions={reviewedUrl && (
              <a href={reviewedUrl} target="_blank" rel="noopener noreferrer"
                className="hidden h-8 shrink-0 items-center rounded-full px-3 text-[13px] font-medium leading-4 text-kumo-default ring-1 ring-inset ring-kumo-line transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring sm:inline-flex">
                {OPEN_LABEL[reviewedGroup.kind]} ↗
              </a>
            )}
            onClose={closeWorkspacePane}
            closeLabel="Close review"
          />
        ) : paneShowsActivity ? (
          <PaneHeader
            glyph={<Pulse size={13} />}
            title="Activity"
            onClose={closeWorkspacePane}
            closeLabel="Close activity"
          />
        ) : (
          <PaneHeader
            glyph={selectedWorkpieceGlyph}
            title={selectedWorkpieceSummary?.title ?? ''}
            badge={selectedWorkpieceSummary?.type === 'gadget' &&
                selectedWorkpieceSummary.chatId !== undefined ? 'Draft' : undefined}
            choices={paneChoices}
            activeId={selectedWorkpieceId}
            onSelect={handleSelectWorkpiece}
            actions={selectedGadgetStub && selectedGadgetSummary?.chatId === undefined && metadata.role !== 'use' && (
              <GadgetApprovalMode
                key={selectedGadgetSummary!.id}
                gadget={selectedGadgetStub}
                mode={selectedGadgetSummary!.autoApprove ? 'auto' : 'review'}
                waiting={allDrafts(selectedGadgetDrafts).length}
                restricted={metadata?.containsRestrictedData === true}
              />
            )}
            onShare={!selectedGadgetSummary || metadata.role === 'use' ? undefined
              : selectedGadgetSummary.chatId === undefined ? () => openShareModal(selectedGadgetSummary.id)
              : false}
            shareLabel={selectedGadgetSummary?.chatId === undefined ? 'Share gadget' : 'Keep this draft to share it'}
            onExpand={selectedWorkpieceSummary?.type === 'worktree'
              ? undefined
              : activeTab === 'app' && !previewMode && enterGadgetFullscreen}
            expandLabel={activeTab === 'app'
              ? 'Full screen'
              : `Full screen is available in ${formatOf(selectedGadgetSummary?.output).noun} view`}
            onClose={closeWorkspacePane}
            closeLabel={selectedWorkpieceSummary?.type === 'worktree' ? 'Close worktree pane' : 'Close gadget pane'}
            onRename={selectedGadgetStub && selectedGadgetSummary?.chatId === undefined && metadata.role !== 'use'
              ? renameSelectedGadget : undefined}
            menu={<>
              {viewTabs.length > 1 && viewTabs.map(tab => (
                <DropdownMenu.Item key={tab.value} onClick={() => handleTabSelect(tab.value)} className={MENU_ITEM}>
                  <span className="flex-1">{tab.label}</span>
                  {activeTab === tab.value && <Check size={12} className="text-kumo-subtle" />}
                </DropdownMenu.Item>
              ))}
              {selectedGadgetSummary && (
                <>
                  <DropdownMenu.Separator />
                  <GadgetExportMenu
                    gadget={selectedGadgetStub}
                    gadgetTitle={selectedGadgetSummary.title}
                    chatId={previewChatId}
                    asSubmenu={{ itemClassName: MENU_ITEM, contentClassName: MENU_CONTENT }}
                  />
                  <DropdownMenu.Item
                    disabled={!selectedGadgetStub}
                    onClick={() => setBlueprintModalOpen(true)}
                    className={MENU_ITEM}
                  >
                    Publish as blueprint…
                  </DropdownMenu.Item>
                  {!builtFromScratch && (
                    <DropdownMenu.Item
                      disabled={!canUpdateFromBlueprint}
                      onClick={() => setBlueprintUpdateDialogOpen(true)}
                      className={MENU_ITEM}
                    >
                      <UpdateFromBlueprintLabel updateAvailable={blueprintUpdateAvailable} />
                    </DropdownMenu.Item>
                  )}
                  {selectedGadgetSummary.chatId === undefined && (
                    <>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        onClick={() => navigate({
                          to: '/workspace/$id/app/$appId/settings',
                          params: { id: id!, appId: String(selectedGadgetSummary.id) },
                          search: { from: namedWorkspace ? 'workspace' : 'chat' },
                        })}
                        className={MENU_ITEM}
                      >
                        Gadget settings
                      </DropdownMenu.Item>
                    </>
                  )}
                </>
              )}
            </>}
          />
        )}
        {!paneShowsActivity && overseer && (
          <GadgetDraftsTray
            key={selectedGadgetSummary?.id}
            overseer={overseer.stub}
            groups={selectedGadgetDrafts}
            restricted={metadata?.containsRestrictedData === true}
            onReview={openDraftReview}
          />
        )}
        <PaneSheet>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {paneShowsActivity && (
              <div className="flex h-11 items-center gap-1 overflow-x-auto border-b border-kumo-line px-2 md:hidden">
                {ACTIVITY_TABS.map(tab => (
                  <PaneTab
                    key={tab.value}
                    active={activityView === tab.value}
                    label={tab.label}
                    count={tab.value === 'review' ? pendingActionCount : undefined}
                    onClick={() => setActivityView(tab.value)}
                  />
                ))}
              </div>
            )}
            {paneShowsActivity && (
              <div className="min-h-0 flex-1">
                {!showingPage && (reviewedGroup ? (
                  <DraftReviewPane
                    key={reviewedGroup.key}
                    overseer={overseer.stub}
                    group={reviewedGroup}
                    restricted={metadata?.containsRestrictedData === true}
                    url={reviewedUrl}
                  />
                ) : activityPanel)}
              </div>
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
                    ? 'visual-viewport-fixed z-20 bg-kumo-base outline-none'
                    : 'h-full'
              }
            >
              {selectedGadgetStub && !previewMode ? (
                <GadgetUI
                  key={selectedGadgetId}
                  gadget={selectedGadgetStub}
                  height="100%"
                  reloadTrigger={uiReloadTrigger}
                  isVisible={activeTab === 'app' && !previewMode}
                  chatId={previewChatId}
                  onConsoleLog={handleClientConsoleLog}
                  onIframeEscape={isGadgetFullscreen ? exitGadgetFullscreen : undefined}
                  onNoUiChange={handleNoUiChange}
                  noUi={selectedGadgetSummary && (
                    <BackgroundAppOverview
                      overseer={overseer.stub}
                      workspaceId={id!}
                      gadgetId={selectedGadgetSummary.id}
                      title={selectedGadgetSummary.title}
                      onShowCode={() => handleTabSelect('code')}
                      onShowConnections={() => handleTabSelect('connections')}
                      onOpenSettings={() => openAppPage('settings', selectedGadgetSummary.id)}
                    />
                  )}
                />
              ) : !previewMode && (
                <NoGadgetPlaceholder height="100%" />
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
              {overseer && selectedWorkpieceSummary ? (
                <WorkpieceCodeInterface
                  // Per workspace, like the ChatInterface: its per-chat clients and per-workpiece
                  // memory are keyed by ids that another workspace reuses.
                  key={id}
                  overseer={overseer.stub}
                  summary={selectedWorkpieceSummary}
                  height="100%"
                  selectedChatId={effectiveSelectedChatId}
                  chatChanges={chatChanges}
                  liveRows={liveRows}
                  liveEditPreviews={liveEditPreviews}
                  pendingGadgetIds={pendingGadgetIds}
                  streamingActiveFile={streamingActiveFileForSelected}
                  isAgentActive={isAgentActive}
                  isVisible={activeTab === 'code'}
                  onHasCodeChange={setHasCode}
                  onChatContentChange={setChatContent}
                />
              ) : (
                <NoGadgetPlaceholder height="100%" />
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
                <NoGadgetPlaceholder height="100%" />
              )}
            </div>

            </div>
          </div>
        </PaneSheet>
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

      {editorDialogs}
      {observerConfigModal}

    </div>
  )
}
