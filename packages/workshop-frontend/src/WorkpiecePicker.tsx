import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  CaretDown, CaretLeft, CaretRight, Check, GitBranch, Lightning, MagnifyingGlass, PencilSimple,
  Pulse, X,
} from '@phosphor-icons/react'
import { FormatGlyph } from './components/format/FormatVisuals'
import { Tooltip } from '@cloudflare/kumo'
import type {
  GadgetSummary, WorkpieceId, WorkpieceSummary, WorktreeSummary,
} from '@gadgets/workshop-shared/api'
import { CountBadge } from './components/CountBadge'
import { WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import { GadgetContextMenu } from './features/gadget-deletion/GadgetContextMenu'
import { isImeComposing } from './keyboardEvent'
import { useGadgetReorder, type GadgetMove } from './gadgetReorder'
import {
  gadgetTitleDetail, groupOfWorkpiece, groupWorkpieces, matchesWorkpieceQuery, parseGadgetTitle,
  type GadgetGroupName,
} from './gadgetTitle'

export const WORKPIECE_RAIL_COLLAPSED_WIDTH = 48
export const WORKPIECE_RAIL_MIN_WIDTH = 240
export const WORKPIECE_RAIL_MAX_WIDTH = 520
export const WORKPIECE_RAIL_DEFAULT_WIDTH = 300

const RAIL_WIDTH_STORAGE_KEY = 'gadgets:workshop:outputRailWidth'
const COLLAPSED_GROUPS_STORAGE_PREFIX = 'gadgets:workshop:outputGroupsCollapsed:'
const KEYBOARD_RESIZE_STEP = 16

export function clampRailWidth(width: number): number {
  return Math.round(Math.max(WORKPIECE_RAIL_MIN_WIDTH, Math.min(WORKPIECE_RAIL_MAX_WIDTH, width)))
}

/** The expanded rail width the viewer last chose, or the default. */
export function getStoredRailWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY))
    if (Number.isFinite(stored) && stored > 0) return clampRailWidth(stored)
  } catch {
    // private mode / sandboxed iframes
  }
  return WORKPIECE_RAIL_DEFAULT_WIDTH
}

export function persistRailWidth(width: number) {
  try {
    window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(clampRailWidth(width)))
  } catch {
    // The width still holds for this session when storage is unavailable.
  }
}

function collapsedGroupsKey(workspaceId: string) {
  return `${COLLAPSED_GROUPS_STORAGE_PREFIX}${workspaceId}`
}

function readCollapsedGroups(workspaceId: string | undefined): Set<GadgetGroupName> {
  if (!workspaceId) return new Set()
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(collapsedGroupsKey(workspaceId)) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is GadgetGroupName => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeCollapsedGroups(workspaceId: string | undefined, groups: ReadonlySet<GadgetGroupName>) {
  if (!workspaceId) return
  try {
    window.localStorage.setItem(collapsedGroupsKey(workspaceId), JSON.stringify([...groups]))
  } catch {
    // Collapse state still holds for this session when storage is unavailable.
  }
}

interface WorkpiecePickerProps {
  // The workspace, for remembering which groups the viewer collapsed in it.
  workspaceId?: string
  // Draft apps remain listed globally; selecting one returns to its creating conversation.
  gadgets: GadgetSummary[]
  // Worktrees are listed under "Other": each belongs to one conversation, and selecting it
  // returns there.
  worktrees: WorktreeSummary[]
  selectedId: WorkpieceId | null
  // The gadget the agent is currently streaming edits into, if any. Shown as an activity dot when
  // it isn't the selected one (e.g. because the user pinned their selection mid-turn).
  agentEditingId?: WorkpieceId | null
  // Gadgets with at least one enabled hook, i.e. whose code can be woken by an external event.
  hookedGadgetIds: ReadonlySet<WorkpieceId>
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  // Expanded width in px, owned by the editor because the layout beside the rail depends on it.
  width?: number
  onWidthChange?: (width: number) => void
  // True while the left edge is being dragged, so the editor can pause its width transitions.
  onResizingChange?: (resizing: boolean) => void
  onSelect: (id: WorkpieceId) => void
  onRename: (id: WorkpieceId, title: string) => void
  // Drag (or Alt+Up/Down) to reorder gadgets within their group. Absent when the viewer can't
  // reorder.
  onMoveGadget?: (move: GadgetMove) => void
  // Asks to delete a gadget, from its right-click menu; the caller confirms it.
  onDelete: (gadget: GadgetSummary) => void  pendingActivityCount: number
  onOpenActivity: () => void
}

export default function WorkpiecePicker({
  workspaceId,
  gadgets,
  worktrees,
  selectedId,
  agentEditingId,
  hookedGadgetIds,
  expanded,
  onExpandedChange,
  width = WORKPIECE_RAIL_DEFAULT_WIDTH,
  onWidthChange,
  onResizingChange,
  onSelect,
  onRename,
  onMoveGadget,
  onDelete,  pendingActivityCount,
  onOpenActivity,
}: WorkpiecePickerProps) {
  const [editing, setEditing] = useState<{ id: WorkpieceId; value: string } | null>(null)
  const [query, setQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] =
    useState<Set<GadgetGroupName>>(() => readCollapsedGroups(workspaceId))
  const searchRef = useRef<HTMLInputElement>(null)
  const focusSearchOnExpandRef = useRef(false)
  const baseId = useId()

  useEffect(() => { setCollapsedGroups(readCollapsedGroups(workspaceId)) }, [workspaceId])

  const searching = expanded && query.trim() !== ''
  const allWorkpieces: WorkpieceSummary[] = useMemo(
    () => [...gadgets, ...worktrees], [gadgets, worktrees])
  const groups = useMemo(() => groupWorkpieces(
    searching ? allWorkpieces.filter(w => matchesWorkpieceQuery(w, query)) : allWorkpieces,
  ), [allWorkpieces, searching, query])

  // Reorder works on the rows as displayed, gadgets only, and never across groups: the saved order
  // is one list, but a move between categories would be undone by the grouping on the next render.
  const displayedGadgetIds = useMemo(
    () => groups.flatMap(g => g.items).filter(w => w.type === 'gadget').map(w => w.id),
    [groups])
  const groupById = useMemo(
    () => new Map(allWorkpieces.map(w => [w.id, groupOfWorkpiece(w)])), [allWorkpieces])
  const moveWithinGroup = useCallback((move: GadgetMove) => {
    if (groupById.get(move.id) !== groupById.get(move.targetId)) return
    onMoveGadget?.(move)
  }, [groupById, onMoveGadget])
  const reorder = useGadgetReorder(
    displayedGadgetIds,
    editing || searching || !onMoveGadget ? undefined : moveWithinGroup,
    'y')

  const commitRename = () => {
    if (!editing) return
    const title = editing.value.trim()
    if (title) onRename(editing.id, title)
    setEditing(null)
  }

  const toggleExpanded = () => {
    if (expanded) setEditing(null)
    onExpandedChange(!expanded)
  }

  const toggleGroup = (name: GadgetGroupName) => {
    setCollapsedGroups(current => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      writeCollapsedGroups(workspaceId, next)
      return next
    })
  }

  // Cmd/Ctrl+K jumps to the search box, expanding the rail first if it's collapsed. The rail only
  // shows while the workspace pane (and its switcher, which owns the shortcut there) is closed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key !== 'k' && e.key !== 'K')) return
      e.preventDefault()
      if (expanded) {
        searchRef.current?.focus()
        searchRef.current?.select()
      } else {
        focusSearchOnExpandRef.current = true
        onExpandedChange(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expanded, onExpandedChange])
  useEffect(() => {
    if (expanded && focusSearchOnExpandRef.current) {
      focusSearchOnExpandRef.current = false
      searchRef.current?.focus()
    }
  }, [expanded])

  // ── left-edge resize ──────────────────────────────────────────────────────────
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!onWidthChange) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { startX: e.clientX, startWidth: width }
    setResizing(true)
    onResizingChange?.(true)
  }
  const onResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    onWidthChange?.(clampRailWidth(drag.startWidth + (drag.startX - e.clientX)))
  }
  const onResizePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = null
    setResizing(false)
    onResizingChange?.(false)
  }
  const onResizeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!onWidthChange) return
    // The handle is on the rail's left edge, so Left widens it.
    if (e.key === 'ArrowLeft') onWidthChange(clampRailWidth(width + KEYBOARD_RESIZE_STEP))
    else if (e.key === 'ArrowRight') onWidthChange(clampRailWidth(width - KEYBOARD_RESIZE_STEP))
    else if (e.key === 'Home') onWidthChange(WORKPIECE_RAIL_MIN_WIDTH)
    else if (e.key === 'End') onWidthChange(WORKPIECE_RAIL_MAX_WIDTH)
    else return
    e.preventDefault()
  }

  const renderGadgetRow = (gadget: GadgetSummary) => {
    const isSelected = gadget.id === selectedId
    const isPending = gadget.chatId !== undefined
    const isAgentEditing = agentEditingId === gadget.id && !isSelected
    const hasHook = hookedGadgetIds.has(gadget.id)
    const parsed = parseGadgetTitle(gadget.title)
    const detail = gadgetTitleDetail(parsed)

    if (expanded && editing?.id === gadget.id) {
      return (
        <div key={gadget.id} className="flex items-center gap-1 py-0.5">
          <WorkshopInput
            type="text"
            value={editing.value}
            onChange={e => setEditing({ id: gadget.id, value: e.target.value })}
            onKeyDown={e => {
              if (isImeComposing(e)) return
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditing(null)
            }}
            autoFocus
            aria-label="Gadget name"
            className="!h-7 min-w-0 flex-1 bg-kumo-tint text-[13px]"
          />
          <WorkshopIconButton
            onClick={commitRename}
            disabled={!editing.value.trim()}
            className="!h-6 !w-6"
            aria-label="Save gadget name"
          >
            <Check size={13} />
          </WorkshopIconButton>
          <WorkshopIconButton
            onClick={() => setEditing(null)}
            className="!h-6 !w-6"
            aria-label="Cancel rename"
          >
            <X size={13} />
          </WorkshopIconButton>
        </div>
      )
    }

    const tooltip = `${gadget.title}${!expanded && isPending ? ' (Draft)' : ''}${hasHook ? ' · Hooks enabled' : ''}`
    const button = (
      <button
        type="button"
        onClick={() => onSelect(gadget.id)}
        title={expanded ? gadget.title : undefined}
        className={`relative flex min-w-0 cursor-pointer text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
          expanded ? 'flex-1 items-start gap-2 py-1.5' : 'h-full w-full items-center justify-center'
        }`}
        aria-current={isSelected ? 'true' : undefined}
      >
        {/* Drawn as whatever the workpiece is -- a page for a Document, a grid for a
            Spreadsheet -- falling back to the generic app glyph. */}
        <FormatGlyph
          output={gadget.output}
          size={expanded ? 'md' : 'lg'}
          className={`flex-shrink-0 ${expanded ? 'mt-px' : ''} ${isSelected ? 'text-kumo-strong' : 'text-kumo-inactive'}`}
          weight={isSelected ? 'fill' : 'regular'}
        />
        {expanded && (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="line-clamp-2 break-words font-medium">{parsed.contents}</span>
            {detail && (
              <span className="text-[11px] leading-4 font-normal text-kumo-subtle">{detail}</span>
            )}
          </span>
        )}
        {isAgentEditing && (
          <span className={`${expanded ? 'mt-1.5' : 'absolute right-1 top-1'} h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-kumo-brand`} />
        )}
        {isPending && (
          expanded ? (
            <span className="mt-px flex-shrink-0 rounded-full bg-kumo-base px-1.5 py-0.5 text-[10px] leading-none font-medium text-kumo-subtle">
              Draft
            </span>
          ) : (
            <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full border border-kumo-base bg-kumo-brand" />
          )
        )}
        {hasHook && (
          <span
            role="img"
            aria-label="Hooks enabled"
            className={expanded
              ? 'mt-px flex-shrink-0 text-kumo-inactive'
              : 'absolute bottom-0.5 left-0.5 rounded-full border border-kumo-base bg-kumo-base text-kumo-inactive'}
          >
            <Lightning size={expanded ? 14 : 10} weight="fill" />
          </span>
        )}
      </button>
    )

    return (
      <div
        key={gadget.id}
        {...reorder.itemProps(gadget.id)}
        style={reorder.dropIndicatorStyle(gadget.id)}
        className={`group/workpiece flex rounded-lg text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
          expanded ? 'min-h-8 items-start gap-1 pl-2 pr-1' : 'h-9 w-9 items-center justify-center self-center'
        } ${
          isSelected
            ? 'bg-kumo-fill text-kumo-strong'
            : 'text-kumo-default hover:bg-kumo-tint'
        } ${reorder.draggingId === gadget.id ? 'opacity-50' : ''}`}
      >
        {expanded ? button : <Tooltip content={tooltip} asChild>{button}</Tooltip>}
        {expanded && (
          <WorkshopIconButton
            onClick={() => setEditing({ id: gadget.id, value: gadget.title })}
            className="!mt-1 !h-6 !w-6 flex-shrink-0 opacity-0 transition-opacity duration-150 ease-out group-hover/workpiece:opacity-100 focus-visible:opacity-100"
            title="Rename gadget"
            aria-label={`Rename ${gadget.title}`}
          >
            <PencilSimple size={13} />
          </WorkshopIconButton>
        )}
      </div>
    )
  }

  const renderWorktreeRow = (worktree: WorktreeSummary) => {
    const isSelected = worktree.id === selectedId
    const isAgentEditing = agentEditingId === worktree.id && !isSelected
    const button = (
      <button
        type="button"
        onClick={() => onSelect(worktree.id)}
        title={expanded ? worktree.title : undefined}
        className={`relative flex min-w-0 cursor-pointer text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
          expanded ? 'flex-1 items-start gap-2 py-1.5' : 'h-full w-full items-center justify-center'
        }`}
        aria-current={isSelected ? 'true' : undefined}
      >
        <GitBranch
          size={expanded ? 15 : 17}
          className={`flex-shrink-0 ${expanded ? 'mt-px' : ''} ${isSelected ? 'text-kumo-strong' : 'text-kumo-inactive'}`}
          weight={isSelected ? 'fill' : 'regular'}
        />
        {expanded && (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="line-clamp-2 break-words font-medium">{worktree.title}</span>
            <span className="text-[11px] leading-4 font-normal text-kumo-subtle">Worktree</span>
          </span>
        )}
        {isAgentEditing && (
          <span className={`${expanded ? 'mt-1.5' : 'absolute right-1 top-1'} h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-kumo-brand`} />
        )}
      </button>
    )
    return (
      <div
        key={worktree.id}
        className={`flex rounded-lg text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
          expanded ? 'min-h-8 items-start gap-1 pl-2 pr-1' : 'h-9 w-9 items-center justify-center self-center'
        } ${
          isSelected
            ? 'bg-kumo-fill text-kumo-strong'
            : 'text-kumo-default hover:bg-kumo-tint'
        }`}
      >
        {expanded ? button : <Tooltip content={worktree.title} asChild>{button}</Tooltip>}
      </div>
    )
  }

  const renderRow = (workpiece: WorkpieceSummary) =>
    workpiece.type === 'gadget' ? renderGadgetRow(workpiece) : renderWorktreeRow(workpiece)

  return (
    <div
      className={`relative flex flex-shrink-0 flex-col overflow-hidden border-l border-kumo-line bg-kumo-elevated ${
        resizing ? '' : 'transition-[width] duration-200 ease-out'
      }`}
      style={{ width: expanded ? width : WORKPIECE_RAIL_COLLAPSED_WIDTH }}
    >
      {expanded && onWidthChange && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize outputs panel"
          aria-valuemin={WORKPIECE_RAIL_MIN_WIDTH}
          aria-valuemax={WORKPIECE_RAIL_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          onKeyDown={onResizeKeyDown}
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-kumo-line focus-visible:bg-kumo-ring focus-visible:outline-none"
        />
      )}

      <button
        type="button"
        onClick={toggleExpanded}
        title={expanded ? 'Collapse outputs' : 'Expand outputs'}
        aria-label={expanded ? 'Collapse outputs' : 'Expand outputs'}
        aria-expanded={expanded}
        className={`flex h-12 flex-shrink-0 cursor-pointer items-center text-kumo-inactive transition-colors hover:text-kumo-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring ${
          expanded ? 'justify-between px-3' : 'justify-center'
        }`}
      >
        {expanded && (
          <span className="text-[11px] font-medium uppercase tracking-[0.06em]">Outputs</span>
        )}
        {expanded ? <CaretRight size={14} /> : <CaretLeft size={14} />}
      </button>

      {expanded && (
        <div className="flex-shrink-0 px-2 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-2 focus-within:ring-2 focus-within:ring-kumo-ring">
            <MagnifyingGlass size={13} className="flex-shrink-0 text-kumo-inactive" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  setQuery('')
                }
              }}
              placeholder="Search outputs"
              aria-label="Search outputs"
              aria-keyshortcuts="Meta+K Control+K"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-kumo-default outline-none placeholder:text-kumo-inactive"
            />
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
        {expanded && searching && groups.length === 0 && (
          <div className="px-2 py-4 text-center text-[13px] text-kumo-subtle">No matching outputs</div>
        )}

        {groups.map((group, index) => {
          if (!expanded) {
            return (
              <div key={group.name} className="flex flex-col gap-0.5">
                {index > 0 && <span aria-hidden="true" className="mx-2 my-1 border-t border-kumo-line" />}
                {group.items.map(renderRow)}
              </div>
            )
          }
          // A search shows every match, collapsed group or not.
          const isCollapsed = !searching && collapsedGroups.has(group.name)
          const regionId = `${baseId}-group-${group.name}`
          return (
            <section key={group.name} aria-label={group.name} className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => toggleGroup(group.name)}
                aria-expanded={!isCollapsed}
                aria-controls={regionId}
                disabled={searching}
                className={`mt-2 flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive transition-colors hover:text-kumo-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-default ${
                  index === 0 ? 'mt-0' : ''
                }`}
              >
                <CaretDown
                  size={10}
                  weight="bold"
                  className={`flex-shrink-0 transition-transform duration-150 ${isCollapsed ? '-rotate-90' : ''}`}
                />
                <span className="flex-1 text-left">{group.name}</span>
                <span className="font-normal normal-case tracking-normal">{group.items.length}</span>
              </button>
              {!isCollapsed && (
                <div id={regionId} className="flex flex-col gap-0.5">
                  {group.items.map(renderRow)}
                </div>

          const row = (
            <div
              className={`group/workpiece flex items-center rounded-lg text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
                expanded ? 'h-8 gap-1 pl-2 pr-1' : 'h-9 w-9 justify-center self-center'
              } ${
                isSelected
                  ? 'bg-kumo-fill font-medium text-kumo-strong'
                  : 'text-kumo-default hover:bg-kumo-tint data-[popup-open]:bg-kumo-tint'
              }`}
            >
              <Tooltip content={`${gadget.title}${!expanded && isPending ? ' (Draft)' : ''}${hasHook ? ' · Hooks enabled' : ''}`} asChild>
                <button
                  type="button"
                  onClick={() => onSelect(gadget.id)}
                  className={`relative flex min-w-0 cursor-pointer items-center text-left ${
                    expanded ? 'flex-1 gap-2' : 'h-full w-full justify-center'
                  }`}
                  aria-current={isSelected ? 'true' : undefined}
                >
                  {/* Drawn as whatever the workpiece is -- a page for a Document, a grid for a
                      Spreadsheet -- falling back to the generic app glyph. */}
                  <FormatGlyph
                    output={gadget.output}
                    size={expanded ? 'md' : 'lg'}
                    className={`flex-shrink-0 ${isSelected ? 'text-kumo-strong' : 'text-kumo-inactive'}`}
                    weight={isSelected ? 'fill' : 'regular'}
                  />
                  {expanded && (
                    <span className="min-w-0 flex-1 truncate">{gadget.title}</span>
                  )}
                  {isAgentEditing && (
                    <span className={`${expanded ? '' : 'absolute right-1 top-1'} h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-kumo-brand`} />
                  )}
                  {isPending && (
                    expanded ? (
                      <span className="flex-shrink-0 rounded-full bg-kumo-base px-1.5 py-0.5 text-[10px] leading-none font-medium text-kumo-subtle">
                        Draft
                      </span>
                    ) : (
                      <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full border border-kumo-base bg-kumo-brand" />
                    )
                  )}
                  {hasHook && (
                    <span
                      role="img"
                      aria-label="Hooks enabled"
                      className={expanded
                        ? 'flex-shrink-0 text-kumo-inactive'
                        : 'absolute bottom-0.5 left-0.5 rounded-full border border-kumo-base bg-kumo-base text-kumo-inactive'}
                    >
                      <Lightning size={expanded ? 14 : 10} weight="fill" />
                    </span>
                  )}
                </button>
              </Tooltip>
              {expanded && (
                <WorkshopIconButton
                  onClick={() => setEditing({ id: gadget.id, value: gadget.title })}
                  className="!h-6 !w-6 flex-shrink-0 opacity-0 transition-opacity duration-150 ease-out group-hover/workpiece:opacity-100 focus-visible:opacity-100"
                  title="Rename gadget"
                  aria-label={`Rename ${gadget.title}`}
                >
                  <PencilSimple size={13} />
                </WorkshopIconButton>              )}
            </section>
          )

          return (
            <GadgetContextMenu key={gadget.id} trigger={row} onDelete={() => onDelete(gadget)} />
          )
        })}

        <Tooltip content="View activity" asChild>
          <button
            type="button"
            onClick={onOpenActivity}
            className={`relative mt-3 flex cursor-pointer items-center rounded-lg text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
              expanded ? 'h-8 gap-2 px-2 text-left' : 'h-9 w-9 justify-center self-center'
            }`}
          >
            <Pulse size={expanded ? 15 : 17} className="flex-shrink-0 text-kumo-inactive" />
            {expanded && <span className="min-w-0 flex-1 truncate">View activity</span>}
            {expanded ? (
              <CountBadge count={pendingActivityCount} />
            ) : pendingActivityCount > 0 && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-kumo-brand" />
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
