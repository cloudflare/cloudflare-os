import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  Blueprint,
  MagnifyingGlass,
  Plus,
  SquaresFour,
} from '@phosphor-icons/react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../../AuthContext'
import type { GadgetMetadataWithTimestamps, OutputFormatOffer } from '@gadgets/workshop-shared/api'
import { FormatGlyph } from '../format/FormatVisuals'
import { createFromFormat } from '../format/useOutputFormats'
import { isImeComposing } from '../../keyboardEvent'

// A ⌘K command palette: jump to a workspace or a primary destination. Because it's keyboard-driven
// and opened many times a day, it deliberately has *no* open/close animation (instant feels faster
// than any transition here — see the Raycast example in our motion guidance). Results stream in as
// the gadget list loads.

type Command = {
  id: string
  label: string
  hint?: string
  icon: ReactNode
  run: () => void
}

type BlueprintEntry = { id: string; title: string; recency: number }
type PaletteData = {
  gadgets: GadgetMetadataWithTimestamps[]
  blueprints: BlueprintEntry[]
  formats: OutputFormatOffer[]
}

// Module-level cache shared across opens for the lifetime of the page. The palette serves this
// instantly on open and only refetches when it's older than the TTL (stale-while-revalidate), so
// hammering ⌘K doesn't spam RPCs while newly-created items still appear on the next open.
const PALETTE_CACHE_TTL_MS = 30_000
let paletteCache: { data: PaletteData; fetchedAt: number } | null = null

// Merge the user's published blueprints and their library into a single de-duplicated list, keyed
// by id and keeping the most-recent timestamp from either source.
function mergeBlueprints(
  own: { id: string; title: string; lastUpdated: Date }[],
  library: { id: string; metadata: { title: string }; addedAt: Date }[],
): BlueprintEntry[] {
  const map = new Map<string, BlueprintEntry>()
  for (const b of library) {
    map.set(b.id, {
      id: b.id,
      title: b.metadata.title || 'Untitled blueprint',
      recency: b.addedAt.getTime(),
    })
  }
  for (const b of own) {
    const prev = map.get(b.id)
    map.set(b.id, {
      id: b.id,
      title: b.title || prev?.title || 'Untitled blueprint',
      recency: Math.max(prev?.recency ?? 0, b.lastUpdated.getTime()),
    })
  }
  return Array.from(map.values())
}

// A command after fuzzy matching: carries the indices of the characters that matched the query so
// we can bold them in the label.
type ScoredCommand = Command & { indices: number[] }
type Group = { heading: string; items: ScoredCommand[] }

// Lightweight subsequence fuzzy matcher. Returns the matched character indices and a relevance
// score (higher is better), or null if the query isn't a subsequence of the text. Bonuses favor
// consecutive runs and word-boundary starts so "fin insg" ranks "Find insights" highly, and an
// earlier first match wins ties. Good enough for a few dozen rows; no dependency needed.
function fuzzyMatch(text: string, query: string): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] }
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const indices: number[] = []
  let score = 0
  let consecutive = 0
  let prevMatch = -2
  let from = 0
  for (const ch of lowerQuery) {
    const found = lowerText.indexOf(ch, from)
    if (found === -1) return null
    indices.push(found)
    if (found === prevMatch + 1) {
      consecutive += 1
      score += 5 + consecutive
    } else {
      consecutive = 0
      score += 1
    }
    if (found === 0 || /[\s\-_/]/.test(lowerText[found - 1])) score += 10
    prevMatch = found
    from = found + 1
  }
  // Prefer matches that start earlier in the string.
  score -= indices[0]
  return { score, indices }
}

// Render a label with the fuzzy-matched characters emphasized.
function highlight(label: string, indices: number[]): ReactNode {
  if (indices.length === 0) return label
  const matched = new Set(indices)
  const out: ReactNode[] = []
  let buf = ''
  let bufMatched = false
  const flush = () => {
    if (!buf) return
    out.push(
      bufMatched ? (
        <span key={out.length} className="font-semibold text-kumo-strong">
          {buf}
        </span>
      ) : (
        <span key={out.length}>{buf}</span>
      ),
    )
    buf = ''
  }
  for (let i = 0; i < label.length; i++) {
    const isMatch = matched.has(i)
    if (isMatch !== bufMatched) {
      flush()
      bufMatched = isMatch
    }
    buf += label[i]
  }
  flush()
  return out
}

export default function CommandPalette({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [gadgets, setGadgets] = useState<GadgetMetadataWithTimestamps[]>(
    () => paletteCache?.data.gadgets ?? [],
  )
  const [blueprints, setBlueprints] = useState<BlueprintEntry[]>(
    () => paletteCache?.data.blueprints ?? [],
  )
  const [formats, setFormats] = useState<OutputFormatOffer[]>(
    () => paletteCache?.data.formats ?? [],
  )

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset transient state and focus the input each time the palette opens. Serve cached results
  // instantly, then refetch in the background only when the cache is missing or stale. Nothing runs
  // while the palette is closed.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    // Defer focus until after the element is painted.
    const id = requestAnimationFrame(() => inputRef.current?.focus())

    if (paletteCache) {
      setGadgets(paletteCache.data.gadgets)
      setBlueprints(paletteCache.data.blueprints)
      setFormats(paletteCache.data.formats)
    }

    let cancelled = false
    const isFresh = paletteCache && Date.now() - paletteCache.fetchedAt < PALETTE_CACHE_TTL_MS
    if (!isFresh) {
      Promise.all([
        authenticatedApi.listGadgets(),
        authenticatedApi.listOwnBlueprints(),
        authenticatedApi.listLibraryBlueprints(),
        authenticatedApi.listOutputFormats(),
      ])
        .then(([gadgetList, own, library, formatList]) => {
          const data: PaletteData = {
            gadgets: gadgetList,
            blueprints: mergeBlueprints(own, library),
            formats: formatList,
          }
          paletteCache = { data, fetchedAt: Date.now() }
          if (cancelled) return
          setGadgets(data.gadgets)
          setBlueprints(data.blueprints)
          setFormats(data.formats)
        })
        .catch((err) => console.error('Command palette: failed to load items', err))
    }
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [open, authenticatedApi])

  const go = useCallback(
    (run: () => void) => {
      onClose()
      run()
    },
    [onClose],
  )

  // Picking a format here behaves as it does anywhere else; see createFromFormat.
  const createFormat = useCallback(
    (format: OutputFormatOffer) =>
      createFromFormat(authenticatedApi, navigate, toasts, format).catch(() => {}),
    [authenticatedApi, navigate, toasts],
  )

  const { groups, flat } = useMemo(() => {
    const needle = query.trim()
    const searching = needle.length > 0

    // One entry per standard format. "New workspace" remains the first action because it is the
    // general starting point; the format shortcuts follow it in the admin's configured order.
    const formatCommands: Command[] = formats.map((format) => ({
      id: `format-${format.blueprintId}`,
      label: `New ${format.output.noun}`,
      hint: 'Format',
      icon: <FormatGlyph output={format.output} size="md" />,
      run: () => { void createFormat(format) },
    }))

    const nav: Command[] = [
      {
        id: 'nav-new',
        label: 'New workspace',
        icon: <Plus size={15} weight="bold" />,
        run: () => navigate({ to: '/' }),
      },
      ...formatCommands,
      {
        id: 'nav-workspaces',
        label: 'Workspaces',
        icon: <SquaresFour size={15} />,
        run: () => navigate({ to: '/workspaces' }),
      },
      {
        id: 'nav-blueprints',
        label: 'Blueprints',
        icon: <Blueprint size={15} />,
        run: () => navigate({ to: '/explore' }),
      },
    ]

    const wsBase: Command[] = gadgets
      .toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
      .map((g) => ({
        id: `ws-${g.id}`,
        label: g.title || 'Untitled workspace',
        hint: 'Workspace',
        icon: <SquaresFour size={15} className="text-kumo-inactive" />,
        run: () => navigate({ to: '/workspace/$id', params: { id: g.id } }),
      }))

    const bpBase: Command[] = blueprints
      .toSorted((a, b) => b.recency - a.recency)
      .map((b) => ({
        id: `bp-${b.id}`,
        label: b.title,
        hint: 'Blueprint',
        icon: <Blueprint size={15} className="text-kumo-inactive" />,
        run: () => navigate({ to: '/blueprint/$id', params: { id: b.id } }),
      }))

    // Empty state shows a short, curated list (actions + a few recent workspaces). Once the user
    // types, we fuzzy-match across everything and rank by score, expanding the per-group limits.
    const refine = (cmds: Command[], limit: number): ScoredCommand[] => {
      if (!searching) return cmds.slice(0, limit).map((c) => ({ ...c, indices: [] }))
      const scored: (ScoredCommand & { score: number })[] = []
      for (const c of cmds) {
        const m = fuzzyMatch(c.label, needle)
        if (m) scored.push({ ...c, indices: m.indices, score: m.score })
      }
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, limit)
    }

    const built: Group[] = searching
      ? [
          { heading: 'Actions', items: refine(nav, nav.length) },
          { heading: 'Workspaces', items: refine(wsBase, 8) },
          { heading: 'Blueprints', items: refine(bpBase, 8) },
        ]
      : [
          { heading: 'Actions', items: refine(nav, nav.length) },
          { heading: 'Recent workspaces', items: refine(wsBase, 4) },
        ]

    const groups = built.filter((g) => g.items.length > 0)
    const flat = groups.flatMap((g) => g.items)
    return { groups, flat }
  }, [query, gadgets, blueprints, formats, navigate, createFormat])

  // Keep the active index in range as the result set changes.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, flat.length - 1)))
  }, [flat.length])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isImeComposing(e)) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (flat.length ? (i + 1) % flat.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = flat[activeIndex]
        if (cmd) go(cmd.run)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [flat, activeIndex, go, onClose],
  )

  // Scroll the active row into view on keyboard navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[1500] flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="absolute inset-0 bg-black/20" aria-hidden="true" onMouseDown={onClose} />
      <div className="themed-floating-shadow-lg relative w-full max-w-xl overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
        <div className="flex items-center gap-2.5 border-b border-kumo-line px-3.5">
          <MagnifyingGlass size={16} className="shrink-0 text-kumo-inactive" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search workspaces and actions…"
            className="h-12 w-full bg-transparent text-[14px] leading-5 tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-kumo-line px-1.5 py-0.5 font-sans text-[10px] leading-none text-kumo-inactive">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="sidebar-scroll max-h-[min(60vh,420px)] overflow-y-auto p-1.5">
          {flat.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-kumo-inactive">No results.</p>
          ) : (
            groups.map((group, gi) => {
              // Compute the flat index offset for this group so keyboard nav stays in sync.
              const start = groups.slice(0, gi).reduce((n, g) => n + g.items.length, 0)
              return (
                <div key={group.heading} className="mb-1 last:mb-0">
                  <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-[0.4px] text-kumo-inactive">
                    {group.heading}
                  </p>
                  {group.items.map((cmd, j) => {
                    const i = start + j
                    return (
                      <button
                        key={cmd.id}
                        type="button"
                        data-index={i}
                        onMouseMove={() => setActiveIndex(i)}
                        onClick={() => go(cmd.run)}
                        className={[
                          'flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] leading-[18px] tracking-[-0.25px] transition-colors',
                          i === activeIndex ? 'bg-kumo-fill text-kumo-strong' : 'text-kumo-default',
                        ].join(' ')}
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-kumo-subtle">
                          {cmd.icon}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{highlight(cmd.label, cmd.indices)}</span>
                        {cmd.hint && (
                          <span className="shrink-0 text-[11px] text-kumo-inactive">{cmd.hint}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        {/* Footer hint strip — standard command-palette keyboard legend. */}
        <div className="flex items-center gap-3 border-t border-kumo-line px-3.5 py-2 text-[11px] text-kumo-inactive">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-kumo-line px-1 py-0.5 font-sans leading-none">↑</kbd>
            <kbd className="rounded border border-kumo-line px-1 py-0.5 font-sans leading-none">↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-kumo-line px-1 py-0.5 font-sans leading-none">↵</kbd>
            open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-kumo-line px-1 py-0.5 font-sans leading-none">esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  )
}
