import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import {
  MagnifyingGlass,
  DotsThreeVertical,
  Stack,
  ArrowSquareOut,
  Cube,
  Clock,
  User,
  ShareNetwork,
  CaretDown,
  Check,
  PencilSimple,
  Trash,
  X,
} from '@phosphor-icons/react'
import { OutputSummary } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'
import ViewToggle from '../components/ViewToggle'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../components/menuStyles'
import { formatOf } from '../components/format/formats'
import { FormatThumbnail, FormatTile } from '../components/format/FormatVisuals'
import { useOutputFormats } from '../components/format/useOutputFormats'
import NewFormatRow from '../components/format/NewFormatRow'
import DeleteConfirmationDialog from '../components/DeleteConfirmationDialog'
import { WorkshopButton, WorkshopIconButton } from '../components/WorkshopControls'

// The Outputs page: everything the user's workspaces have produced, in one place, so they don't
// have to remember which workspace they made a thing in. Backed by an index in the user's own
// account that each workspace pushes to (AuthenticatedApi.listOutputs()).

export const Route = createFileRoute('/outputs')({
  component: OutputsPage,
})

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function outputKey(output: OutputSummary): string {
  return `${output.workspaceId}:${output.workpieceId}`
}

// Whether the user may rename or remove this output. Follows the workspace roles, not ownership: a
// "build" collaborator holds the same capability over a workpiece as the owner (see
// GadgetClientImpl). The user's own workspaces carry no role; a shared one must say so, since a
// role missing there predates role caching and may well be "use".
function canModify(output: OutputSummary): boolean {
  return output.owner === undefined || output.role === 'build'
}

// ─── rows / cards ────────────────────────────────────────────────────────────

function OutputMenu({
  onOpen,
  onOpenWorkspace,
  onRename,
  onRemove,
}: {
  onOpen: () => void
  onOpenWorkspace: () => void
  // Undefined for a workspace shared with "use" access, which may open an output but not change
  // it. See canModify().
  onRename?: () => void
  onRemove?: () => void
}) {
  return (
    <div
      className="press-exempt"
      onClick={(e) => { e.stopPropagation() }}
      // The card/row is itself a keyboard-activatable button; without this, Enter or Space on the
      // menu trigger would also open the output.
      onKeyDown={(e) => { e.stopPropagation() }}
    >
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              aria-label="Output actions"
              className="cursor-pointer rounded-md p-1.5 text-kumo-subtle transition-colors hover:bg-kumo-fill hover:text-kumo-default focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            >
              <DotsThreeVertical size={16} />
            </button>
          }
        />
        <DropdownMenu.Content className={MENU_CONTENT}>
          <DropdownMenu.Item onClick={onOpen} className={MENU_ITEM}>
            <ArrowSquareOut size={13} className="mr-2" /> Open
          </DropdownMenu.Item>
          <DropdownMenu.Item onClick={onOpenWorkspace} className={MENU_ITEM}>
            <Cube size={13} className="mr-2" /> Open workspace
          </DropdownMenu.Item>
          {onRename && (
            <DropdownMenu.Item onClick={onRename} className={MENU_ITEM}>
              <PencilSimple size={13} className="mr-2" /> Rename
            </DropdownMenu.Item>
          )}
          {onRemove && (
            <DropdownMenu.Item onClick={onRemove} className={`${MENU_ITEM} text-kumo-danger`}>
              <Trash size={13} className="mr-2" /> Remove
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}

// Secondary line under an output's title in the grid, where there's no room for meta columns.
function subtitle(output: OutputSummary): string {
  const parts = [output.workspaceTitle || 'Untitled workspace']
  if (output.owner) parts.push(`Shared by ${output.owner.name}`)
  parts.push(`Workspace active ${formatRelativeTime(output.lastActive)}`)
  return parts.join(' · ')
}

// Provenance for a list row: the output came out of the user's own workspace or a shared one.
function OutputProvenance({ owner }: { owner?: OutputSummary['owner'] }) {
  return (
    <span
      className="flex w-52 items-center gap-1 truncate whitespace-nowrap"
      title={owner ? `In a workspace shared by ${owner.name}` : 'In a workspace you created'}
    >
      {owner ? <ShareNetwork size={11} /> : <User size={11} />}
      <span className="truncate">{owner ? `Shared by ${owner.name}` : 'Created by you'}</span>
    </span>
  )
}

type OutputActions = {
  onOpen: () => void
  onOpenWorkspace: () => void
  onRename?: () => void
  onRemove?: () => void
}

function OutputCard({
  output, onOpen, onOpenWorkspace, onRename, onRemove,
}: { output: OutputSummary } & OutputActions) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="themed-card-hover-shadow press group flex cursor-pointer flex-col overflow-hidden rounded-xl border border-kumo-line bg-kumo-base text-left transition-[border-color,box-shadow] duration-150 ease-out hover:border-kumo-fill"
    >
      <div className="relative aspect-[4/3] w-full border-b border-kumo-line">
        <FormatThumbnail output={output.output} />
      </div>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <FormatTile output={output.output} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
            {output.title || 'Untitled'}
          </p>
          <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {subtitle(output)}
          </p>
        </div>
        <OutputMenu onOpen={onOpen} onOpenWorkspace={onOpenWorkspace}
                    onRename={onRename} onRemove={onRemove} />
      </div>
    </div>
  )
}

function OutputRow({
  output, onOpen, onOpenWorkspace, onRename, onRemove,
}: { output: OutputSummary } & OutputActions) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-kumo-tint"
    >
      <FormatTile output={output.output} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
          {output.title || 'Untitled'}
        </p>
        <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
          {formatOf(output.output).noun} · {output.workspaceTitle || 'Untitled workspace'}
        </p>
      </div>
      {/* Fixed-width meta columns so rows line up like a table. */}
      <div className="hidden shrink-0 items-center gap-6 text-xs text-kumo-inactive lg:flex">
        <OutputProvenance owner={output.owner} />
        <span className="flex w-40 items-center justify-end gap-1 whitespace-nowrap">
          <Clock size={10} />
          Workspace active {formatRelativeTime(output.lastActive)}
        </span>
      </div>
      <OutputMenu onOpen={onOpen} onOpenWorkspace={onOpenWorkspace}
                  onRename={onRename} onRemove={onRemove} />
    </div>
  )
}

// ─── filter chips ────────────────────────────────────────────────────────────

function FilterChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium tracking-[-0.25px] transition-colors ${
        active
          ? 'bg-kumo-fill text-kumo-strong'
          : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
      }`}
    >
      {label}
      <span className={active ? 'text-kumo-subtle' : 'text-kumo-inactive'}>{count}</span>
    </button>
  )
}

// ─── scope ───────────────────────────────────────────────────────────────────

// Whose outputs to show. Not a chip: type is the axis people browse by, so the chips are its
// alone. Ownership is a scope you set once, so it collapses into one control stating the current
// answer.
type OwnerFilter = 'all' | 'mine' | 'shared'

const SCOPE_ICON = { all: Stack, mine: User, shared: ShareNetwork } as const

function ScopeSelect({
  value,
  counts,
  onChange,
}: {
  value: OwnerFilter
  counts: Record<OwnerFilter, number>
  onChange: (value: OwnerFilter) => void
}) {
  // The trigger shows the chosen option verbatim, so the default label has to spell out the union
  // of the other two. Anything shorter ("Anyone", "All") reads as a directory of other people,
  // when nothing here is reachable without having made it or been given access.
  const options: { value: OwnerFilter; label: string }[] = [
    { value: 'all', label: 'Yours and shared' },
    { value: 'mine', label: 'Created by you' },
    { value: 'shared', label: 'Shared with you' },
  ]
  const current = options.find((o) => o.value === value)!
  const CurrentIcon = SCOPE_ICON[value]

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className={`inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium tracking-[-0.25px] transition-colors ${
              value === 'all'
                ? 'border-kumo-line text-kumo-subtle hover:text-kumo-default'
                : 'border-kumo-line bg-kumo-fill text-kumo-strong'
            }`}
          >
            <CurrentIcon size={14} className="shrink-0" />
            {current.label}
            <CaretDown size={11} className="shrink-0 text-kumo-inactive" />
          </button>
        }
      />
      <DropdownMenu.Content
        className={`${MENU_CONTENT} !min-w-[210px]`}
        style={MENU_POSITIONER_STYLE}
        align="end"
        sideOffset={6}
      >
        {options.map((option) => {
          const Icon = SCOPE_ICON[option.value]
          return (
            <DropdownMenu.Item
              key={option.value}
              className={MENU_ITEM}
              onClick={() => onChange(option.value)}
            >
              <Icon size={13} className="mr-2 flex-shrink-0 text-kumo-subtle" />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <span className="ml-3 flex-shrink-0 tabular-nums text-kumo-inactive">
                {counts[option.value]}
              </span>
              <Check
                size={12}
                weight="bold"
                className={`ml-2 flex-shrink-0 ${
                  option.value === value ? 'text-kumo-subtle' : 'invisible'
                }`}
              />
            </DropdownMenu.Item>
          )
        })}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

function RenameOutputDialog({
  output,
  value,
  busy,
  onValueChange,
  onClose,
  onSave,
}: {
  output: OutputSummary | null
  value: string
  busy: boolean
  onValueChange: (value: string) => void
  onClose: () => void
  onSave: () => void
}) {
  return (
    <Dialog.Root open={output !== null} onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <Dialog
        className="responsive-dialog !z-[1000] !w-[min(420px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[20%] !-translate-y-0"
        size="sm"
      >
        <form onSubmit={(event) => { event.preventDefault(); onSave() }}>
          <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] font-medium leading-5 tracking-[-0.3px] text-kumo-default">
                Rename output
              </Dialog.Title>
              {/* Renames the output itself, unlike the sidebar's workspace rename, which relabels
                  only your own copy. */}
              <Dialog.Description className="mt-1 text-[12px] leading-4 text-kumo-subtle">
                Renames the output for everyone with access to “{output?.workspaceTitle}”.
              </Dialog.Description>
            </div>
            <WorkshopIconButton type="button" className="!h-7 !w-7" disabled={busy} aria-label="Close" onClick={onClose}>
              <X size={16} />
            </WorkshopIconButton>
          </div>
          <div className="px-5 py-4">
            <label className="block text-[12px] font-medium text-kumo-subtle" htmlFor="rename-output-title">
              Name
            </label>
            <input
              id="rename-output-title"
              autoFocus
              value={value}
              disabled={busy}
              onChange={(event) => onValueChange(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[13px] text-kumo-default focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15"
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-5 py-3">
            <WorkshopButton type="button" disabled={busy} onClick={onClose}>Cancel</WorkshopButton>
            <WorkshopButton tone="primary" type="submit" disabled={busy || !value.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </WorkshopButton>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

// Which format to show; 'all' plus one entry per format id actually present.
type TypeFilter = 'all' | string

function OutputsPage() {
  useDocumentTitle('Outputs')
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { formats } = useOutputFormats()
  // In a ref so the load effect can report a failed refresh without taking the manager as a
  // dependency, which would refetch for an unrelated reason.
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts

  const [view, setView] = useState<'grid' | 'list'>(() => {
    if (typeof window === 'undefined') return 'grid'
    return localStorage.getItem('outputs-view') === 'list' ? 'list' : 'grid'
  })
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all')
  const [search, setSearch] = useState('')
  const [outputs, setOutputs] = useState<OutputSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const loadedOnce = useRef(false)
  const [renameOutput, setRenameOutput] = useState<OutputSummary | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [removeOutput, setRemoveOutput] = useState<OutputSummary | null>(null)
  const [mutationBusy, setMutationBusy] = useState(false)

  useEffect(() => {
    localStorage.setItem('outputs-view', view)
  }, [view])

  useEffect(() => {
    let cancelled = false
    // Keep the current list visible during background refreshes; skeletons are only for the first
    // visit.
    if (!loadedOnce.current) setLoading(true)
    setLoadError(false)
    // Workspaces predating the outputs index are swept in a bounded batch per call, so keep asking
    // until the server says it is done. Each round shows what has arrived so far, which is what
    // makes a large account fill in visibly while the page is open rather than over several
    // visits.
    void (async () => {
      for (;;) {
        const { outputs: list, catchingUp } = await authenticatedApi.listOutputs()
        if (cancelled) return
        setOutputs(list)
        setLoading(false)
        loadedOnce.current = true
        if (!catchingUp) return
      }
    })().catch((err) => {
      console.error('Failed to load outputs:', err)
      if (cancelled) return
      setLoading(false)
      // A failed *refresh* must not discard a page already showing something: it is still the last
      // good answer, and the next focus retries. The error state is for having nothing to show.
      if (loadedOnce.current) {
        toastsRef.current.add({ title: "Couldn't refresh outputs", variant: 'error' })
      } else {
        setLoadError(true)
      }
    })
    return () => { cancelled = true }
  }, [authenticatedApi, reloadToken])

  // A cheap snapshot rather than another live subscription, so refetch when the user returns to
  // the window.
  useEffect(() => {
    const refresh = () => setReloadToken((n) => n + 1)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  const openOutput = (output: OutputSummary) => {
    navigate({
      to: '/workspace/$id',
      params: { id: output.workspaceId },
      search: { w: output.workpieceId },
    })
  }

  const openWorkspace = (output: OutputSummary) => {
    navigate({ to: '/workspace/$id', params: { id: output.workspaceId }, search: {} })
  }

  const beginRename = (output: OutputSummary) => {
    setRenameOutput(output)
    setRenameValue(output.title)
  }

  const saveRename = async () => {
    if (!renameOutput || !canModify(renameOutput) || !renameValue.trim()) return
    setMutationBusy(true)
    const current = renameOutput
    let overseer
    let gadget
    try {
      overseer = await authenticatedApi.openGadget(current.workspaceId)
      gadget = overseer.getGadget(current.workpieceId)
      const title = renameValue.trim()
      await gadget.setTitle(title)
      setOutputs((list) => list.map((output) =>
        outputKey(output) === outputKey(current) ? { ...output, title } : output))
      setRenameOutput(null)
    } catch (err) {
      console.error('Failed to rename output:', err)
      toasts.add({ title: "Couldn't rename this output", variant: 'error' })
    } finally {
      gadget?.[Symbol.dispose]()
      overseer?.[Symbol.dispose]()
      setMutationBusy(false)
    }
  }

  const confirmRemove = async () => {
    if (!removeOutput || !canModify(removeOutput)) return
    setMutationBusy(true)
    const current = removeOutput
    let overseer
    let gadget
    try {
      overseer = await authenticatedApi.openGadget(current.workspaceId)
      gadget = overseer.getGadget(current.workpieceId)
      await gadget.remove()
      setOutputs((list) => list.filter((output) => outputKey(output) !== outputKey(current)))
      setRemoveOutput(null)
    } catch (err) {
      console.error('Failed to remove output:', err)
      toasts.add({ title: "Couldn't remove this output", variant: 'error' })
    } finally {
      gadget?.[Symbol.dispose]()
      overseer?.[Symbol.dispose]()
      setMutationBusy(false)
    }
  }

  // Keep configured categories visible even before the user has made one. Apps is the universal
  // fallback; configured formats follow deployment order, then legacy/disabled types found in the
  // actual list are appended so existing outputs never lose their filter.
  const presentTypes = useMemo(() => {
    let generic = formatOf()
    let byId = new Map<string, string>([[generic.id, generic.plural]])
    for (let offer of formats) {
      if (!byId.has(offer.output.id)) byId.set(offer.output.id, offer.output.plural)
    }
    for (let output of outputs) {
      let format = formatOf(output.output)
      if (!byId.has(format.id)) byId.set(format.id, format.plural)
    }
    return [...byId]
  }, [formats, outputs])
  const showTypeFilters = presentTypes.length > 1
  const showToolbar = outputs.length > 0 || showTypeFilters
  // Keep ownership scopes available alongside categories even when one or both counts are zero.
  const showOwnerFilters = showToolbar

  const q = search.trim().toLowerCase()
  const matchesType = (o: OutputSummary) =>
    !showTypeFilters || typeFilter === 'all' || formatOf(o.output).id === typeFilter
  const matchesOwner = (o: OutputSummary) =>
    !showOwnerFilters || ownerFilter === 'all'
      || (ownerFilter === 'mine' ? !o.owner : !!o.owner)
  const matchesSearch = (o: OutputSummary) => {
    if (!q) return true
    const format = formatOf(o.output)
    const searchable = [
      o.title,
      o.workspaceTitle,
      format.noun,
      format.plural,
      o.owner?.name ?? '',
    ].join('\n').toLowerCase()
    return searchable.includes(q)
  }

  // A control's own counts ignore that control but honour the others, so the numbers describe what
  // clicking would actually give you. Without this the format chips still total every output while
  // a scope is selected, and they don't add up to the list underneath.
  const inTypeScope = outputs.filter((o) => matchesOwner(o) && matchesSearch(o))
  const inOwnerScope = outputs.filter((o) => matchesType(o) && matchesSearch(o))
  const filtered = inTypeScope.filter(matchesType)
  const isFiltered = q !== '' || (showTypeFilters && typeFilter !== 'all')
      || (showOwnerFilters && ownerFilter !== 'all')

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-3 sm:px-10">
      <header className="flex items-end justify-between gap-4 px-3 pb-4 pt-6 sm:pt-10">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Outputs</h1>
          <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
            Everything your workspaces have produced, in one place.
          </p>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </header>

      {/* Toolbar: format chips on the left (the browsing axis), scope + search on the right (the
          refining controls). Configured categories stay visible with zero counts. */}
      <div className={`flex flex-col gap-3 px-3 pb-3 sm:flex-row sm:items-center sm:justify-between ${
        !showToolbar ? 'hidden' : ''}`}>
        <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 sidebar-scroll">
          {showTypeFilters && (
            <>
              <FilterChip active={typeFilter === 'all'} label="All" count={inTypeScope.length}
                          onClick={() => setTypeFilter('all')} />
              {presentTypes.map(([id, plural]) => (
                <FilterChip
                  key={id}
                  active={typeFilter === id}
                  label={plural}
                  count={inTypeScope.filter((o) => formatOf(o.output).id === id).length}
                  onClick={() => setTypeFilter(id)}
                />
              ))}
            </>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:shrink-0">
          {showOwnerFilters && (
            <ScopeSelect
              value={ownerFilter}
              counts={{
                all: inOwnerScope.length,
                mine: inOwnerScope.filter((o) => !o.owner).length,
                shared: inOwnerScope.filter((o) => o.owner).length,
              }}
              onChange={setOwnerFilter}
            />
          )}
          <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search outputs…"
              className="h-10 w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-4 text-[16px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] duration-150 ease-out focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15 sm:h-9 sm:text-[13px]"
            />
          </div>
        </div>
      </div>

      <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
        {loading ? (
          <div className="grid grid-cols-1 gap-4 px-3 min-[400px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-kumo-elevated" />
            ))}
          </div>
        ) : loadError ? (
          <div className="py-12 text-center text-sm">
            <p className="text-kumo-danger">Something went wrong loading your outputs.</p>
            <button onClick={() => setReloadToken((n) => n + 1)} className="mt-1 text-kumo-brand underline">
              Try again
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-3 py-20 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-fill text-kumo-subtle">
              <Stack size={18} />
            </div>
            <div>
              <p className="text-sm font-medium text-kumo-default">
                {isFiltered ? 'No outputs match' : 'No outputs yet'}
              </p>
              <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
                {isFiltered
                  ? 'Try a different filter or search term.'
                  : 'Anything your workspaces build will show up here.'}
              </p>
            </div>
            {/* Offer the deployment's formats here rather than sending them to the home page. */}
            {!isFiltered && <NewFormatRow label="Start with" />}
          </div>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-1 gap-4 px-3 min-[400px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((output) => (
              <OutputCard key={outputKey(output)} output={output}
                          onOpen={() => openOutput(output)}
                          onOpenWorkspace={() => openWorkspace(output)}
                          onRename={canModify(output) ? () => beginRename(output) : undefined}
                          onRemove={canModify(output) ? () => setRemoveOutput(output) : undefined} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((output) => (
              <OutputRow key={outputKey(output)} output={output}
                         onOpen={() => openOutput(output)}
                         onOpenWorkspace={() => openWorkspace(output)}
                         onRename={canModify(output) ? () => beginRename(output) : undefined}
                         onRemove={canModify(output) ? () => setRemoveOutput(output) : undefined} />
            ))}
          </div>
        )}
      </div>

      <RenameOutputDialog
        output={renameOutput}
        value={renameValue}
        busy={mutationBusy}
        onValueChange={setRenameValue}
        onClose={() => setRenameOutput(null)}
        onSave={() => { void saveRename() }}
      />
      <DeleteConfirmationDialog
        open={removeOutput !== null}
        title={`Remove “${removeOutput?.title || 'Untitled'}”?`}
        description={
          <>
            This permanently removes the output from “{removeOutput?.workspaceTitle}”
            {removeOutput?.owner ? ', for everyone with access to that workspace' : ''}. Other
            outputs in that workspace stay available. This can’t be undone.
          </>
        }
        confirmLabel="Remove"
        confirmingLabel="Removing…"
        isDeleting={mutationBusy}
        onOpenChange={(open) => { if (!open) setRemoveOutput(null) }}
        onConfirm={() => { void confirmRemove() }}
      />
    </div>
  )
}
