import { useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react'
import { animate, motion, useMotionValue } from 'motion/react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton, motionTransition } from '@gadgets/ui'
import { CardGridMotion } from '@/components/cardGridMotion'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { FOCUS_RING } from '@/components/focusRing'
import type { PinDrag } from './usePinDrag'
import { useWorkspaceUnderlay } from './useWorkspaceUnderlay'
import type { WorkspaceListItemProps } from './WorkspaceListItem'

/** A workspace pinned to the sidebar, as its tile shows it. */
export type PinnedWorkspace = Omit<WorkspaceListItemProps, 'selected' | 'onSelect' | 'subtitle' | 'menuOpen'> & { id: string }

export type PinnedWorkspacesProps = {
  workspaces: PinnedWorkspace[]
  selectedId?: string
  /** The one whose menu is open, which keeps its hover while the pointer is in the menu. */
  menuOpenId?: string
  onSelect: (id: string) => void
  /** Lets the tiles be put in another order with Alt and an arrow key, giving the ids in the new one. */
  onReorder?: (ids: string[]) => void
  /** A workspace being dragged, by a row or by its tile (`usePinDrag`). */
  drag?: PinDrag
  /** The area a workspace is dropped on. */
  dropRef?: Ref<HTMLDivElement>
}

// The place kept for a workspace being dragged in, which is no workspace's.
const INCOMING = 'pin:incoming'
const GROW = { type: 'spring', duration: 0.4, bounce: 0.15 } as const
const UNDERLAY = 'pointer-events-none absolute top-0 left-0 -z-10 h-0 rounded-2xl bg-kumo-fill'

const Tile = ({ id, workspaceLabel, workspaceLook, title, unread, attention, href, selected, menuOpen, landing, onSelect }: PinnedWorkspace & { selected: boolean; menuOpen: boolean; landing: boolean; onSelect: () => void }) => (
  <LinkButton
    href={href}
    data-workspace-id={id}
    data-menu-open={menuOpen || undefined}
    onClick={onSelect}
    aria-current={selected || undefined}
    aria-label={attention ? `${title}, ${attention.toLowerCase()}` : unread ? `${title}, unread` : title}
    className={cn(
      // Its hover and selection are the surfaces the tiles share (`useWorkspaceUnderlay`).
      'flex min-w-0 flex-col items-center gap-2 rounded-2xl px-1.5 pt-3.5 pb-3', FOCUS_RING,
    )}
  >
    {/* Out of sight while the icon dragged here flies into its place. */}
    <span data-pin-icon className={cn('relative flex', landing && 'invisible')}>
      <WorkspaceIcon label={workspaceLabel} {...workspaceLook} />
      {(attention || unread) && <span aria-hidden="true" className={cn('absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-kumo-canvas', attention ? 'bg-kumo-warning' : 'bg-kumo-brand')} />}
    </span>
    <span className="line-clamp-2 w-full text-center text-xs/tight font-medium wrap-break-word hyphens-auto text-kumo-default">{title}</span>
  </LinkButton>
)

/**
 * The workspaces pinned to the sidebar, as tiles in lines over everything else in it: each its
 * icon over its title, marked as its row would be. While a workspace is dragged (`drag`), the area
 * is tinted and opens out of nothing if it was empty, saying "Pin workspace"; over it, the others
 * make way for the place it would take (`CardGridMotion`, as the Library's cards do), and a tile
 * being dragged leaves its own place. Its height springs to what it holds.
 */
export const PinnedWorkspaces = ({ workspaces, selectedId, menuOpenId, onSelect, onReorder, drag, dropRef }: PinnedWorkspacesProps) => {
  // One hover, gliding from tile to tile along a line as it does from row to row in the list.
  const { listRef: gridRef, underlayRef, hoverUnderlayRef } = useWorkspaceUnderlay(`[data-card]:not([data-card="${INCOMING}"])`, 'x')
  const innerRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef<CardGridMotion>(undefined)
  const [announcement, setAnnouncement] = useState('')

  useLayoutEffect(() => {
    // The pointer's drags are `usePinDrag`'s: this slides the tiles, and moves them by the keyboard.
    const tiles = new CardGridMotion(gridRef.current!, setAnnouncement, { pointer: false, resize: true })
    motionRef.current = tiles
    return () => tiles.destroy()
  }, [])

  const ids = workspaces.map(({ id }) => id)
  useLayoutEffect(() => {
    motionRef.current?.sync([{ key: 'pinned', cards: ids, reorder: onReorder }])
  })

  const held = drag && !drag.result
  const shown = held && drag.pinned ? workspaces.filter(({ id }) => id !== drag.workspaceId) : workspaces
  // Kept while the area closes again, after a drag that pinned nothing.
  const placeholder = drag && shown.length === 0 && (held || drag.result === 'back')
  const cells: Array<PinnedWorkspace | typeof INCOMING> = [...shown]
  if (placeholder) cells.push(INCOMING)
  else if (held && drag.over) cells.splice(Math.min(drag.at, cells.length), 0, INCOMING)
  const open = workspaces.length > 0 || (drag !== undefined && (held || drag.result === 'pinned'))

  // Springs to what it holds, from nothing as a drag starts with none pinned, and back.
  const height = useMotionValue(open ? -1 : 0)
  const [clipped, setClipped] = useState(!open)
  // Only the latest growth lets go of the clip once it is done.
  const growth = useRef(0)
  useLayoutEffect(() => {
    const inner = innerRef.current!
    let first = height.get() < 0
    const resize = () => {
      const to = open ? inner.offsetHeight : 0
      if (first) {
        first = false
        height.set(to)
        return
      }
      if (to === height.get()) return
      setClipped(true)
      const mine = ++growth.current
      void animate(height, to, motionTransition(GROW)).then(() => {
        if (mine === growth.current && to > 0) setClipped(false)
      })
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [open, height])

  return (
    <motion.div style={{ height }} className={cn('shrink-0', clipped && 'overflow-hidden')}>
      <div ref={innerRef} className="pb-2">
        <div
          ref={dropRef}
          data-pin-drop
          className={cn('@container relative rounded-2xl transition-colors duration-200', held && 'bg-kumo-contrast/4')}
        >
          {/* Up to three to a line, four where the area is wide enough, as wide as they can be, a last line of fewer in its middle. */}
          <div ref={gridRef} style={{ '--count': Math.max(cells.length, 1) } as CSSProperties} className="relative isolate flex flex-wrap justify-center gap-y-0.5 [--most:3] [overflow-anchor:none] @min-[20rem]:[--most:4]">
            <div ref={underlayRef} aria-hidden="true" className={UNDERLAY} />
            <div ref={hoverUnderlayRef} aria-hidden="true" className={UNDERLAY} />
            {cells.map((cell) => cell === INCOMING
              ? (
                  <div key={INCOMING} data-card={INCOMING} aria-hidden="true" className={cn('grid w-[calc(100%/min(var(--count),var(--most)))] place-items-center px-1', placeholder && 'min-h-19.75')}>
                    {placeholder && (
                      <span
                        className={cn(
                          'appears text-sm font-medium transition-[opacity,color] duration-200',
                          !held && 'opacity-0',
                          drag.over ? 'text-kumo-default' : 'text-kumo-subtle',
                        )}
                      >
                        Pin workspace
                      </span>
                    )}
                  </div>
                )
              : (
                  <div key={cell.id} data-card={cell.id} className="flex w-[calc(100%/min(var(--count),var(--most)))] min-w-0 flex-col rounded-2xl select-none *:flex-1 [-webkit-touch-callout:none]">
                    <Tile
                      {...cell}
                      selected={cell.id === selectedId}
                      menuOpen={cell.id === menuOpenId}
                      landing={drag?.result !== undefined && drag.result !== 'gone' && drag.workspaceId === cell.id}
                      onSelect={() => onSelect(cell.id)}
                    />
                  </div>
                ))}
          </div>
          <span role="status" className="sr-only">{announcement}</span>
        </div>
      </div>
    </motion.div>
  )
}
