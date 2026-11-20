import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { animate, useMotionValue, type AnimationPlaybackControls } from 'motion/react'
import { nearestSlot } from '@/components/cardGridLayout'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { motionTransition } from '@/hooks/motionTransition'
import { isMotionOff } from '@/prefs/motion'

/** The workspace a row or a tile is of, which dragging it pins, moves among the pinned, or unpins. */
export type PinDragSource = {
  workspaceId: string
  workspaceLabel: string
  workspaceLook?: WorkspaceLook
  /** It is a pinned workspace's tile, put in another place among them, or unpinned outside them. */
  pinned: boolean
  /** A row of a workspace pinned already: it can be picked up, but the area does not take it, and it goes back. */
  alreadyPinned?: boolean
}

/**
 * How a drag ended, while its icon settles: `pinned` flies into its tile, `back` to where it was
 * taken from, and `gone`, unpinned, fades where it was let go of.
 */
export type PinDragResult = 'pinned' | 'back' | 'gone'

/** A workspace being dragged: whether it is over the pinned area and the place it would take there, and once let go of, how it ended. */
export type PinDrag = PinDragSource & { over: boolean; at: number; result?: PinDragResult }

export type PinDragActions = {
  /** A row's workspace let go of over the area, at the place `at` among the pinned. */
  onPin: (workspaceId: string, at: number) => void
  /** A pinned one put in another place among them. */
  onMove: (workspaceId: string, at: number) => void
  /** A pinned one let go of outside the area. */
  onUnpin: (workspaceId: string) => void
}

type Point = { x: number; y: number }

// As a card is picked up by a mouse (`CardGridMotion`): once it has moved this far.
const DRAG_START = 4
// The icon is this much larger while it is held.
const LIFT = 1.15
const FLIGHT = { type: 'spring', duration: 0.42, bounce: 0.22 } as const
const FADE = { duration: 0.2, ease: 'easeOut' } as const

const centreOf = (element: Element): Point => {
  const box = element.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

/** A pinned workspace's icon in the area, once it is there. */
const tileIconOf = (area: HTMLElement | null, workspaceId: string) =>
  area?.querySelector(`[data-workspace-id="${CSS.escape(workspaceId)}"] [data-pin-icon]`) ?? null

/** Where a workspace let go of at (`x`, `y`) goes: whether that is over the area, and the place among the tiles nearest it. */
const dropAt = (area: HTMLElement | null, x: number, y: number, source: PinDragSource) => {
  if (source.alreadyPinned) return { over: false, at: 0 }
  const box = area?.getBoundingClientRect()
  if (!area || !box || x < box.left || x > box.right || y < box.top || y > box.bottom) return { over: false, at: 0 }
  // Among the places as they are laid out, the one already kept for it included, so that it does not move for having moved.
  const cells = Array.from(area.querySelectorAll<HTMLElement>('[data-card]'))
  if (cells.length === 0) return { over: true, at: 0 }
  const slots = cells.map((cell) => ({ left: cell.offsetLeft, top: cell.offsetTop, width: cell.offsetWidth, height: cell.offsetHeight }))
  const grid = cells[0].offsetParent?.getBoundingClientRect() ?? box
  return { over: true, at: nearestSlot(slots, x - grid.left, y - grid.top) }
}

const swallow = (click: MouseEvent) => {
  click.preventDefault()
  click.stopPropagation()
}

/**
 * Dragging a workspace with a mouse, by a row of it or by its pinned tile. Past a few pixels a copy
 * of its icon lifts off it and floats to the pointer, which it then follows (`ghost`, drawn
 * by whoever spreads the handlers). Let go of over the pinned area (`dropRef`), a row's workspace
 * is pinned at the place nearest and a tile is moved there, and the icon flies into its tile; a
 * tile let go of outside it is unpinned, and its icon fades. Escape, or a row let go of elsewhere,
 * sends the icon back, as does any drop of a row whose workspace is pinned already. `sourceOf` says which workspace an element is of, if it can be dragged.
 * A finger does not drag: a long press is the row's menu.
 */
export const usePinDrag = (sourceOf: (element: Element) => PinDragSource | undefined, actions: PinDragActions) => {
  const [drag, setDrag] = useState<PinDrag>()
  const dropRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ sourceOf, actions })
  useEffect(() => {
    latest.current = { sourceOf, actions }
  })

  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const scale = useMotionValue(1)
  const opacity = useMotionValue(1)
  const flight = useRef<AnimationPlaybackControls>(undefined)
  const stop = useRef<() => void>(undefined)
  const settle = useRef<() => void>(undefined)
  useEffect(() => () => {
    stop.current?.()
    flight.current?.stop()
    settle.current?.()
  }, [])

  /** Moves the icon from one point to another, both read again each frame as they may be moving, and its size between two. */
  const fly = (from: () => Point, to: () => Point, sizes: [number, number], done?: () => void) => {
    flight.current?.stop()
    const place = (progress: number) => {
      const a = from()
      const b = to()
      x.set(a.x + (b.x - a.x) * progress)
      y.set(a.y + (b.y - a.y) * progress)
      scale.set(sizes[0] + (sizes[1] - sizes[0]) * progress)
    }
    if (isMotionOff()) {
      place(1)
      done?.()
      return
    }
    place(0)
    flight.current = animate(0, 1, { ...motionTransition(FLIGHT), onUpdate: place, onComplete: done })
  }

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0 || event.pointerType === 'touch' || !(event.target instanceof Element) || stop.current || settle.current) return
    const source = latest.current.sourceOf(event.target)
    if (!source) return
    const icon = event.target.closest('[data-chat-key], [data-workspace-id]')?.querySelector<HTMLElement>('[data-pin-icon]') ?? null
    const { pointerId, clientX: startX, clientY: startY } = event
    let moving = false
    let pointer: Point = { x: startX, y: startY }
    let lifting = true
    let state: PinDrag = { ...source, over: false, at: 0 }
    const show = (next: PinDrag) => {
      if (next.over === state.over && next.at === state.at && next.result === state.result) return
      state = next
      setDrag(next)
    }

    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      pointer = { x: next.clientX, y: next.clientY }
      if (!moving) {
        if (Math.hypot(pointer.x - startX, pointer.y - startY) < DRAG_START) return
        moving = true
        document.getSelection()?.removeAllRanges()
        document.documentElement.toggleAttribute('data-pin-dragging', true)
        // A copy of the icon lifts off it and floats to the pointer.
        const origin = icon ? centreOf(icon) : pointer
        opacity.set(1)
        state = { ...source, ...dropAt(dropRef.current, pointer.x, pointer.y, source) }
        setDrag(state)
        fly(() => origin, () => pointer, [1, LIFT], () => {
          lifting = false
        })
        return
      }
      if (!lifting) {
        x.set(pointer.x)
        y.set(pointer.y)
      }
      show({ ...source, ...dropAt(dropRef.current, pointer.x, pointer.y, source) })
    }

    const end = (drop: boolean) => (last: PointerEvent | KeyboardEvent) => {
      if ('pointerId' in last && last.pointerId !== pointerId) return
      if (last instanceof KeyboardEvent && last.key !== 'Escape') return
      const was = moving
      stop.current?.()
      if (!was) return
      // The click a drag ends with is not the row's.
      addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => removeEventListener('click', swallow, { capture: true }))

      const at = drop && last instanceof PointerEvent ? dropAt(dropRef.current, last.clientX, last.clientY, source) : undefined
      const result: PinDragResult = at?.over ? 'pinned' : at && source.pinned ? 'gone' : 'back'
      const { onPin, onMove, onUnpin } = latest.current.actions
      if (at?.over) (source.pinned ? onMove : onPin)(source.workspaceId, at.at)
      if (result === 'gone') onUnpin(source.workspaceId)
      show({ ...state, result })

      const finish = () => {
        settle.current = undefined
        flight.current = undefined
        setDrag(undefined)
      }
      settle.current = finish
      const from = { x: x.get(), y: y.get() }
      if (result === 'gone') {
        flight.current?.stop()
        if (isMotionOff()) return finish()
        animate(scale, scale.get() * 0.6, FADE)
        flight.current = animate(opacity, 0, { ...FADE, onComplete: finish })
        return
      }
      // Into its tile, which may only be there from the next frame, or back where it was taken from.
      const target = () => {
        const into = result === 'pinned' || source.pinned ? tileIconOf(dropRef.current, source.workspaceId) : icon?.isConnected ? icon : null
        return into ? centreOf(into) : from
      }
      requestAnimationFrame(() => fly(() => from, target, [scale.get(), 1], finish))
    }
    const up = end(true)
    const cancel = end(false)
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', cancel)
    addEventListener('keydown', cancel)
    stop.current = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', cancel)
      removeEventListener('keydown', cancel)
      document.documentElement.removeAttribute('data-pin-dragging')
      stop.current = undefined
    }
  }

  // A link is the browser's to drag otherwise, which would end this drag.
  const onDragStart = (event: DragEvent) => {
    if (event.target instanceof Element && latest.current.sourceOf(event.target)) event.preventDefault()
  }

  return { drag, dropRef, ghost: { x, y, scale, opacity }, onPointerDown, onDragStart }
}
