import { logRpcFailure } from '../../rpcErrors'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  CaretDown,
  MagnifyingGlass,
  Star,
} from '@phosphor-icons/react'
import { openCommandPalette } from './commandPaletteBus'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  GadgetMetadataWithTimestamps,
  Overseer,
  AiChatAuthorInfo,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import ShareModal from '../../ShareModal'
import DeleteConfirmationDialog from '../DeleteConfirmationDialog'
import SidebarGadgetRow from './SidebarGadgetRow'

// Cap on items shown in the Recent list before the user clicks through to /workspaces.
const RECENT_INITIAL_LIMIT = 6

// ─────────────────────────────────────────────────────────────────────────────
// Shape of the workspaces state shared between the rail's pinned tools (search) and the scrolling
// lists (Favorites / Recent workspaces). Centralized here so both sibling components subscribe to
// the same data and the dialog state has a single owner.
// ─────────────────────────────────────────────────────────────────────────────
type WorkspacesContextValue = {
  // Search query, lifted up so the input lives in the pinned area but filters the scrolling lists.
  search: string
  setSearch: (v: string) => void

  gadgets: GadgetMetadataWithTimestamps[]
  gadgetsLoading: boolean
  favorites: GadgetMetadataWithTimestamps[]
  recent: GadgetMetadataWithTimestamps[]

  onTogglePin: (g: GadgetMetadataWithTimestamps) => void
  onRename: (g: GadgetMetadataWithTimestamps, newTitle: string) => void
  onShare: (g: GadgetMetadataWithTimestamps) => void
  onDelete: (g: GadgetMetadataWithTimestamps) => void
}

const WorkspacesContext = createContext<WorkspacesContextValue | null>(null)

function useWorkspacesContext(): WorkspacesContextValue {
  const ctx = useContext(WorkspacesContext)
  if (!ctx) throw new Error('Sidebar workspaces components must be rendered inside SidebarWorkspacesProvider')
  return ctx
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: owns all the data + mutation handlers, plus the share / delete dialogs. Renders its
// children inside its context so SidebarWorkspacesTools and SidebarWorkspacesLists can be placed
// independently in the parent layout (pinned vs. scrolling areas).
// ─────────────────────────────────────────────────────────────────────────────
export function SidebarWorkspacesProvider({ children }: { children: ReactNode }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()

  const [gadgets, setGadgets] = useState<GadgetMetadataWithTimestamps[]>([])
  const [gadgetsLoading, setGadgetsLoading] = useState(true)

  const [search, setSearch] = useState('')

  // Delete / share dialog state (workspaces).
  const [deleteTarget, setDeleteTarget] = useState<GadgetMetadataWithTimestamps | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [shareTarget, setShareTarget] = useState<GadgetMetadataWithTimestamps | null>(null)
  const [shareOverseer, setShareOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  const [currentUser, setCurrentUser] = useState<AiChatAuthorInfo | null>(null)

  useEffect(() => {
    authenticatedApi.whoami().then(setCurrentUser).catch(() => {})
  }, [authenticatedApi])

  // Load gadgets. Refresh on mount + after mutation; no live subscription yet.
  useEffect(() => {
    let cancelled = false
    setGadgetsLoading(true)
    authenticatedApi.listGadgets()
      .then((list) => {
        if (cancelled) return
        setGadgets(list)
        setGadgetsLoading(false)
      })
      .catch((err) => {
        logRpcFailure('Failed to load workspaces for sidebar:', err)
        if (!cancelled) setGadgetsLoading(false)
      })
    return () => { cancelled = true }
  }, [authenticatedApi])

  // Dispose share overseer on close / unmount.
  useEffect(() => {
    if (!shareTarget && shareOverseer) {
      shareOverseer.stub[Symbol.dispose]()
      setShareOverseer(null)
    }
  }, [shareTarget, shareOverseer])
  const shareOverseerRef = useRef(shareOverseer)
  shareOverseerRef.current = shareOverseer
  useEffect(() => () => { shareOverseerRef.current?.stub[Symbol.dispose]() }, [])

  const needle = search.trim().toLowerCase()
  const matchText = useCallback(
    (s: string | undefined) => !needle || (s || '').toLowerCase().includes(needle),
    [needle],
  )

  const { favorites, recent } = useMemo(() => {
    const favs: GadgetMetadataWithTimestamps[] = []
    const rest: GadgetMetadataWithTimestamps[] = []
    for (const g of gadgets) {
      if (!matchText(g.title)) continue
      if (g.pinned) favs.push(g)
      else rest.push(g)
    }
    const byActive = (a: GadgetMetadataWithTimestamps, b: GadgetMetadataWithTimestamps) =>
      b.lastActive.getTime() - a.lastActive.getTime()
    favs.sort(byActive)
    rest.sort(byActive)
    return { favorites: favs, recent: rest }
  }, [gadgets, matchText])

  // --- Workspace actions ---------------------------------------------------

  const onTogglePin = useCallback(async (g: GadgetMetadataWithTimestamps) => {
    const newPinned = !g.pinned
    setGadgets((prev) => prev.map((x) => (x.id === g.id ? { ...x, pinned: newPinned } : x)))
    const overseer = authenticatedApi.openGadget(g.id) // pipelining
    try {
      await overseer.setPinned(newPinned)
    } catch (err) {
      console.error('Failed to toggle pin:', err)
      setGadgets((prev) => prev.map((x) => (x.id === g.id ? { ...x, pinned: g.pinned } : x)))
      toasts.add({ title: 'Failed to update favorite', variant: 'error' })
    } finally {
      overseer[Symbol.dispose]()
    }
  }, [authenticatedApi, toasts])

  const onRename = useCallback(async (g: GadgetMetadataWithTimestamps, newTitle: string) => {
    setGadgets((prev) => prev.map((x) => (x.id === g.id ? { ...x, title: newTitle } : x)))
    const overseer = authenticatedApi.openGadget(g.id)
    try {
      await overseer.setTitle(newTitle)
    } catch (err) {
      console.error('Failed to rename:', err)
      setGadgets((prev) => prev.map((x) => (x.id === g.id ? { ...x, title: g.title } : x)))
      toasts.add({ title: 'Failed to rename workspace', variant: 'error' })
    } finally {
      overseer[Symbol.dispose]()
    }
  }, [authenticatedApi, toasts])

  const onShare = useCallback(async (g: GadgetMetadataWithTimestamps) => {
    let overseer: RpcStub<Overseer> | null = null
    try {
      overseer = authenticatedApi.openGadget(g.id)
      const metadata = await overseer.getMetadata()
      setShareOverseer({ stub: overseer })
      setShareTarget({ ...g, ...metadata })
      overseer = null
    } catch (err) {
      overseer?.[Symbol.dispose]()
      console.error('Failed to open workspace for sharing:', err)
      toasts.add({ title: 'Failed to open share settings', variant: 'error' })
    }
  }, [authenticatedApi, toasts])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      if (deleteTarget.owner) {
        await authenticatedApi.dismissSharedGadget(deleteTarget.id)
      } else {
        const overseer = authenticatedApi.openGadget(deleteTarget.id) // pipelining
        try {
          await overseer.deleteSelf()
        } finally {
          overseer[Symbol.dispose]()
        }
      }
      setGadgets((prev) => prev.filter((x) => x.id !== deleteTarget.id))
      toasts.add({
        title: deleteTarget.owner ? 'Workspace removed' : 'Workspace deleted',
        variant: 'success',
      })
    } catch (err) {
      console.error('Failed to delete workspace:', err)
      toasts.add({ title: 'Failed to delete workspace', variant: 'error' })
    } finally {
      setIsDeleting(false)
      setDeleteTarget(null)
    }
  }, [authenticatedApi, deleteTarget, toasts])

  const value: WorkspacesContextValue = {
    search,
    setSearch,
    gadgets,
    gadgetsLoading,
    favorites,
    recent,
    onTogglePin,
    onRename,
    onShare,
    onDelete: setDeleteTarget,
  }

  return (
    <WorkspacesContext.Provider value={value}>
      {children}

      {/* Delete confirm */}
      <DeleteConfirmationDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        isDeleting={isDeleting}
        title={deleteTarget?.owner ? 'Remove workspace' : 'Delete workspace'}
        description={
          deleteTarget?.owner
            ? `Remove "${deleteTarget?.title || 'Untitled workspace'}" from your list? You can still access it via its link.`
            : `Delete "${deleteTarget?.title || 'Untitled workspace'}"? This cannot be undone.`
        }
        confirmLabel={deleteTarget?.owner ? 'Remove' : 'Delete'}
        confirmingLabel={deleteTarget?.owner ? 'Removing...' : 'Deleting...'}
        onConfirm={handleDeleteConfirm}
      />

      {/* Share modal */}
      {shareOverseer && shareTarget && (
        <ShareModal
          open
          onClose={() => setShareTarget(null)}
          overseer={shareOverseer.stub}
          metadata={shareTarget}
          currentUser={currentUser}
          authenticatedApi={authenticatedApi}
        />
      )}
    </WorkspacesContext.Provider>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools (search). Lives in the rail's pinned-top area so it stays put while the lists below scroll.
// Only renders in collapsed mode — see the note below.
// ─────────────────────────────────────────────────────────────────────────────
export function SidebarWorkspacesTools({ collapsed = false }: { collapsed?: boolean }) {
  // No "New workspace" button: Home *is* the new-workspace launcher, so it would be redundant.
  // Search lives as a magnifying-glass icon in the brand row when expanded; when collapsed the
  // brand-row buttons are hidden, so we surface a compact search icon here instead.
  if (!collapsed) return null

  return (
    <div className="flex flex-col items-center px-2">
      <button
        type="button"
        onClick={() => openCommandPalette()}
        aria-label="Search"
        title="Search (⌘K)"
        className="press flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
      >
        <MagnifyingGlass size={15} />
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Lists (Favorites / Recent workspaces). Lives in the rail's scrolling middle
// region. In collapsed mode shows a compact avatar stack.
// ─────────────────────────────────────────────────────────────────────────────
export function SidebarWorkspacesLists({ collapsed = false }: { collapsed?: boolean }) {
  const {
    search,
    favorites,
    recent,
    gadgetsLoading,
    onTogglePin,
    onRename,
    onShare,
    onDelete,
  } = useWorkspacesContext()

  const [favOpen, setFavOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(true)

  if (collapsed) {
    const compact = [...favorites, ...recent].slice(0, 8)
    return (
      <div className="flex flex-col items-center gap-1.5 px-2">
        {compact.map((g) => (
          <SidebarGadgetRow
            key={g.id}
            gadget={g}
            collapsed
            onTogglePin={onTogglePin}
            onRename={onRename}
            onShare={onShare}
            onDelete={onDelete}
          />
        ))}
      </div>
    )
  }

  const recentShown = recent.slice(0, RECENT_INITIAL_LIMIT)
  const recentHidden = Math.max(0, recent.length - RECENT_INITIAL_LIMIT)

  return (
    <div className="flex flex-col pb-3">
      {/* Favorites */}
      <SidebarSection
        label="Favorites"
        count={favorites.length}
        open={favOpen}
        onToggle={() => setFavOpen((o) => !o)}
        icon={<Star size={12} weight="regular" className="text-kumo-inactive" />}
      >
        {favorites.length === 0 ? (
          <p className="px-2.5 py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-inactive">
            Favorite a workspace to keep it here.
          </p>
        ) : (
          <div className="flex flex-col">
            {favorites.map((g) => (
              <SidebarGadgetRow
                key={g.id}
                gadget={g}
                onTogglePin={onTogglePin}
                onRename={onRename}
                onShare={onShare}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </SidebarSection>

      {/* Recent workspaces — no count here; the "Show all (N)" link already carries it. */}
      <SidebarSection
        label="Recent workspaces"
        open={recentOpen}
        onToggle={() => setRecentOpen((o) => !o)}
      >
        {gadgetsLoading ? (
          <div className="flex flex-col gap-1 px-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-7 rounded-md bg-kumo-elevated animate-pulse" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <p className="px-2.5 py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-inactive">
            {search ? 'No matches.' : 'No workspaces yet.'}
          </p>
        ) : (
          <>
            <div className="flex flex-col">
              {recentShown.map((g) => (
                <SidebarGadgetRow
                  key={g.id}
                  gadget={g}
                  onTogglePin={onTogglePin}
                  onRename={onRename}
                  onShare={onShare}
                  onDelete={onDelete}
                />
              ))}
            </div>
            <Link
              to="/workspaces"
              className="mt-0.5 flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
            >
              {recentHidden > 0 ? `Show all (${recent.length})` : 'Show all'}
              <ArrowRight size={11} weight="bold" />
            </Link>
          </>
        )}
      </SidebarSection>
    </div>
  )
}

// A collapsible group header used by SidebarWorkspacesLists.
function SidebarSection({
  label,
  count,
  icon,
  open,
  onToggle,
  children,
}: {
  label: string
  count?: number
  icon?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="mt-3 flex flex-col px-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-6 cursor-pointer items-center gap-1 px-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive transition-colors hover:text-kumo-subtle"
      >
        <CaretDown
          size={10}
          weight="bold"
          className={['transition-transform', open ? '' : '-rotate-90'].join(' ')}
        />
        {icon}
        <span>{label}</span>
        {count !== undefined && <span className="ml-1 text-kumo-inactive">{count}</span>}
      </button>
      {open && <div className="mt-0.5">{children}</div>}
    </div>
  )
}
