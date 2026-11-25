import { useLayoutEffect, useRef } from 'react'
import { isMotionOff, subscribeMotionLevel } from '@gadgets/ui'
import { slidBy } from './useRowSlide'

type Bounds = { top: number; height: number; left: number; width: number }
type Target = {
  selected?: HTMLButtonElement
  hovered?: HTMLButtonElement
  neighbour?: HTMLButtonElement
  activeBox?: Bounds
  hoverBox?: Bounds
}

const EASING = 'cubic-bezier(0.2, 0, 0.15, 1)'
const GLIDE_DURATION = 75

const sameBounds = (a: Bounds | undefined, b: Bounds | undefined) => a?.top === b?.top && a?.height === b?.height && a?.left === b?.left && a?.width === b?.width

/** What a row says of itself, or the one thing in it says, as a tile's link does for the place it is in. */
const flag = (row: Element, name: string) => row.getAttribute(name) ?? row.firstElementChild?.getAttribute(name) ?? null

/**
 * Joins active and hover surfaces, preserving the direction from which the pointer approached.
 * The rows are the list's children that match `rowSelector`; the current one has `aria-current`,
 * and one with `data-menu-open` is drawn as hovered whatever the pointer does (on the row, or the
 * one thing in it). Along `x`, the rows are tiles in lines: the surfaces glide and join along a
 * line, and go from one line to another at once, placed by where the tiles are laid out.
 */
export const useWorkspaceUnderlay = (rowSelector = '[data-workspace-id]', axis: 'x' | 'y' = 'y') => {
  const listRef = useRef<HTMLDivElement>(null)
  const underlayRef = useRef<HTMLDivElement>(null)
  const hoverUnderlayRef = useRef<HTMLDivElement>(null)
  const refreshRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const list = listRef.current!
    const underlay = underlayRef.current!
    const hoverUnderlay = hoverUnderlayRef.current!
    const scroller = list.parentElement!
    const canHover = matchMedia('(hover: hover)')
    let rows: HTMLButtonElement[] = []
    let pointed: HTMLButtonElement | undefined
    let pointer: { x: number; y: number } | undefined
    let target: Target | undefined
    let connected = false
    let generation = 0
    let animations: Animation[] = []
    const radius = getComputedStyle(underlay).borderTopLeftRadius
    const across = axis === 'x'
    // The corners square where one meets another: at its start (top, or left), or its end.
    const squareTop = across ? `0px ${radius} ${radius} 0px` : `0px 0px ${radius} ${radius}`
    const squareBottom = across ? `${radius} 0px 0px ${radius}` : `${radius} ${radius} 0px 0px`
    const frame = (box: Bounds, borderRadius = radius) => ({
      top: `${box.top}px`,
      height: `${box.height}px`,
      ...(across ? { left: `${box.left}px`, width: `${box.width}px` } : {}),
      borderRadius,
    })
    const readSurface = (surface: HTMLElement) => {
      const style = getComputedStyle(surface)
      return { top: style.top, height: style.height, ...(across ? { left: style.left, width: style.width } : {}), borderRadius: style.borderRadius }
    }
    // Where a box starts and how long it is, along the axis.
    const start = (box: Bounds) => (across ? box.left : box.top)
    const size = (box: Bounds) => (across ? box.width : box.height)
    const along = (from: number, length: number, cross: Bounds): Bounds => (across ? { ...cross, left: from, width: length } : { ...cross, top: from, height: length })

    const animate = (surface: HTMLElement, frames: Keyframe[], duration = 100) => {
      const animation = surface.animate(frames, { duration, easing: EASING })
      animations.push(animation)
      return animation
    }
    const move = (
      surface: HTMLElement,
      from: ReturnType<typeof readSurface>,
      box: Bounds | undefined,
      motion: boolean,
      duration = 100,
    ) => {
      if (!box) {
        surface.style.height = '0px'
        return
      }
      const to = frame(box)
      Object.assign(surface.style, to)
      // To another line of tiles it goes at once.
      const sameLine = !across || Number.parseFloat(from.top) === box.top
      if (motion && sameLine && Number.parseFloat(from.height) > 0) animate(surface, [from, to], duration)
    }

    const rowAt = (element: EventTarget | null) => {
      const row = element instanceof Element ? element.closest<HTMLButtonElement>(rowSelector) : null
      return row?.parentElement === list ? row : undefined
    }

    const update = (hoverChanged = false) => {
      // A row whose menu is open keeps the hover while the pointer is in the menu.
      const hovered = rows.find((row) => flag(row, 'data-menu-open') !== null) ?? pointed
      const selected = rows.find((row) => {
        const current = flag(row, 'aria-current')
        return current !== null && current !== 'false'
      })
      const listTop = list.getBoundingClientRect().top
      const measure = (row: HTMLButtonElement | undefined): Bounds | undefined => {
        if (!row) return undefined
        // Tiles where they are laid out, not where a move has them on the way there.
        if (across) return { top: row.offsetTop, height: row.offsetHeight, left: row.offsetLeft, width: row.offsetWidth }
        // Rows where they are laid out too, not where a slide to there has them (`useRowSlide`).
        const box = row.getBoundingClientRect()
        return { top: box.top - listTop - slidBy(row), height: box.height, left: 0, width: 0 }
      }
      const activeBox = measure(selected)
      const hoverBox = measure(hovered)
      const selectedIndex = selected ? rows.indexOf(selected) : -1
      const hoveredIndex = hovered ? rows.indexOf(hovered) : -1
      // Tiles only side by side, along one line.
      const neighbour = selectedIndex >= 0 && hoveredIndex >= 0 && Math.abs(selectedIndex - hoveredIndex) === 1 && (!across || activeBox?.top === hoverBox?.top)
        ? hovered
        : undefined
      const previous = target
      if (previous?.selected === selected && previous?.hovered === hovered && previous?.neighbour === neighbour &&
          sameBounds(previous?.activeBox, activeBox) && sameBounds(previous?.hoverBox, hoverBox) && !isMotionOff()) return

      const selectionChanged = previous?.selected !== selected
      const selectingJoined = selectionChanged && selected === previous?.neighbour && connected
      const motion = previous !== undefined && !isMotionOff()
      const wasConnected = connected
      const activeFrom = readSurface(underlay)
      const hoverFrom = readSurface(hoverUnderlay)
      const version = ++generation
      for (const animation of animations) animation.cancel()
      animations = []
      target = { selected, hovered, neighbour, activeBox, hoverBox }
      connected = false

      // Both surfaces own their fill, so a moving hover never disappears in favour of a row's CSS.
      for (const row of rows) row.toggleAttribute('data-underlay', row === selected || row === hovered)

      if (neighbour && activeBox && hoverBox) {
        const first = Math.min(start(activeBox), start(hoverBox))
        const union = along(first, Math.max(start(activeBox) + size(activeBox), start(hoverBox) + size(hoverBox)) - first, activeBox)
        const approaching = motion && hoverChanged && !selectionChanged && !wasConnected && previous?.hovered !== selected

        if (approaching) {
          // Arriving from outside the active row: slide the existing hover and flatten both meeting
          // corners in one motion. Swap to the shared rectangle only once the seam is closed.
          const above = start(hoverBox) < start(activeBox)
          const activeJoined = frame(activeBox, above ? squareTop : squareBottom)
          const hoverJoined = frame(hoverBox, above ? squareBottom : squareTop)
          const travelling = Number.parseFloat(hoverFrom.height) > 0
          const duration = travelling ? GLIDE_DURATION : 100
          Object.assign(underlay.style, activeJoined)
          Object.assign(hoverUnderlay.style, hoverJoined)
          animate(underlay, [activeFrom, activeJoined], duration)
          const hoverAnimation = animate(hoverUnderlay, [
            travelling ? hoverFrom : frame(hoverBox),
            hoverJoined,
          ], duration)
          hoverAnimation.onfinish = () => {
            if (version !== generation) return
            Object.assign(underlay.style, frame(union))
            hoverUnderlay.style.height = '0px'
            connected = true
          }
        } else {
          // Leaving the active row, or retargeting an already joined shape, grows one rectangle.
          connected = true
          hoverUnderlay.style.height = '0px'
          move(underlay, activeFrom, union, motion && hoverChanged && !selectionChanged)
        }
      } else {
        const separateHover = hovered !== selected ? hoverBox : undefined
        const departing = motion && hoverChanged && !selectionChanged && previous?.neighbour !== undefined
        let activeStart = activeFrom
        let hoverStart = hoverFrom
        if (departing && wasConnected && activeBox && previous?.hoverBox && separateHover) {
          // Cut the visible shared surface at the seam before separating it. Shrinking the entire
          // union at the same time would make the active half appear to withdraw. Use the current
          // animated bounds so a split during growth does not jump to the full two-row height.
          const above = start(previous.hoverBox) < start(activeBox)
          const top = Number.parseFloat(across ? activeFrom.left! : activeFrom.top)
          const bottom = top + Number.parseFloat(across ? activeFrom.width! : activeFrom.height)
          const seam = Math.min(bottom, Math.max(top, above ? start(activeBox) : start(activeBox) + size(activeBox)))
          const upper = along(top, seam - top, activeBox)
          const lower = along(seam, bottom - seam, activeBox)
          activeStart = frame(above ? lower : upper, above ? squareTop : squareBottom)
          hoverStart = frame(above ? upper : lower, above ? squareBottom : squareTop)
        }
        // Selection never travels between separate rows. A fully joined shape can still contract.
        move(underlay, activeStart, activeBox, motion && (selectionChanged ? selectingJoined : hoverChanged), departing && separateHover ? GLIDE_DURATION : 100)
        move(hoverUnderlay, hoverStart, separateHover, motion && hoverChanged && !selectionChanged, GLIDE_DURATION)
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !canHover.matches) return
      pointer = { x: event.clientX, y: event.clientY }
      const nextHovered = rowAt(event.target)
      if (pointed === nextHovered) return
      pointed = nextHovered
      update(true)
    }
    const onPointerLeave = () => {
      pointer = undefined
      pointed = undefined
      update(true)
    }
    const hitTest = () => {
      pointed = pointer && canHover.matches ? rowAt(document.elementFromPoint(pointer.x, pointer.y)) : undefined
    }
    const onScroll = () => {
      // The underlay lives in the scrolling content, so only the hovered row needs recomputing.
      hitTest()
      update(true)
    }
    const onLayout = () => {
      hitTest()
      update()
    }
    const observer = new ResizeObserver(onLayout)
    observer.observe(list)

    refreshRef.current = () => {
      const nextRows = Array.from(list.querySelectorAll<HTMLButtonElement>(`:scope > ${rowSelector}`))
      for (const row of rows) {
        if (!nextRows.includes(row)) {
          observer.unobserve(row)
          row.removeAttribute('data-underlay')
        }
      }
      for (const row of nextRows) if (!rows.includes(row)) observer.observe(row)
      rows = nextRows
      onLayout()
    }

    list.addEventListener('pointerover', onPointerMove)
    list.addEventListener('pointermove', onPointerMove)
    list.addEventListener('pointerleave', onPointerLeave)
    list.addEventListener('pointercancel', onPointerLeave)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const unsubscribeMotion = subscribeMotionLevel(onLayout)
    canHover.addEventListener('change', onLayout)
    return () => {
      refreshRef.current = null
      observer.disconnect()
      generation++
      for (const animation of animations) animation.cancel()
      underlay.removeAttribute('style')
      hoverUnderlay.removeAttribute('style')
      for (const row of rows) row.removeAttribute('data-underlay')
      list.removeEventListener('pointerover', onPointerMove)
      list.removeEventListener('pointermove', onPointerMove)
      list.removeEventListener('pointerleave', onPointerLeave)
      list.removeEventListener('pointercancel', onPointerLeave)
      scroller.removeEventListener('scroll', onScroll)
      unsubscribeMotion()
      canHover.removeEventListener('change', onLayout)
    }
  }, [])

  // Selection, ordering and row content come from React; their geometry belongs to the DOM.
  useLayoutEffect(() => { refreshRef.current?.() })

  return { listRef, underlayRef, hoverUnderlayRef }
}
