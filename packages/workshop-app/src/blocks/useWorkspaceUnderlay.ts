import { useLayoutEffect, useRef } from 'react'

type Bounds = { top: number; height: number }
type Target = {
  selected?: HTMLButtonElement
  hovered?: HTMLButtonElement
  neighbour?: HTMLButtonElement
  activeBox?: Bounds
  hoverBox?: Bounds
}

const EASING = 'cubic-bezier(0.2, 0, 0.15, 1)'
const GLIDE_DURATION = 75

const sameBounds = (a: Bounds | undefined, b: Bounds | undefined) => a?.top === b?.top && a?.height === b?.height

const readSurface = (surface: HTMLElement) => {
  const style = getComputedStyle(surface)
  return { top: style.top, height: style.height, borderRadius: style.borderRadius }
}

/** Joins active and hover surfaces, preserving the direction from which the pointer approached. */
export const useWorkspaceUnderlay = () => {
  const listRef = useRef<HTMLDivElement>(null)
  const underlayRef = useRef<HTMLDivElement>(null)
  const hoverUnderlayRef = useRef<HTMLDivElement>(null)
  const refreshRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const list = listRef.current!
    const underlay = underlayRef.current!
    const hoverUnderlay = hoverUnderlayRef.current!
    const scroller = list.parentElement!
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    const canHover = matchMedia('(hover: hover)')
    let rows: HTMLButtonElement[] = []
    let hovered: HTMLButtonElement | undefined
    let pointer: { x: number; y: number } | undefined
    let target: Target | undefined
    let connected = false
    let generation = 0
    let animations: Animation[] = []
    const radius = getComputedStyle(underlay).borderTopLeftRadius
    const squareTop = `0px 0px ${radius} ${radius}`
    const squareBottom = `${radius} ${radius} 0px 0px`
    const frame = (box: Bounds, borderRadius = radius) => ({ top: `${box.top}px`, height: `${box.height}px`, borderRadius })

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
      if (motion && Number.parseFloat(from.height) > 0) animate(surface, [from, to], duration)
    }

    const rowAt = (element: EventTarget | null) => {
      const row = element instanceof Element ? element.closest<HTMLButtonElement>('[data-workspace-id]') : null
      return row?.parentElement === list ? row : undefined
    }

    const update = (hoverChanged = false) => {
      const selected = rows.find((row) => row.getAttribute('aria-current') === 'true')
      const selectedIndex = selected ? rows.indexOf(selected) : -1
      const hoveredIndex = hovered ? rows.indexOf(hovered) : -1
      const neighbour = selectedIndex >= 0 && hoveredIndex >= 0 && Math.abs(selectedIndex - hoveredIndex) === 1
        ? hovered
        : undefined
      const listTop = list.getBoundingClientRect().top
      const measure = (row: HTMLButtonElement | undefined): Bounds | undefined => {
        if (!row) return undefined
        const box = row.getBoundingClientRect()
        return { top: box.top - listTop, height: box.height }
      }
      const activeBox = measure(selected)
      const hoverBox = measure(hovered)
      const previous = target
      if (previous?.selected === selected && previous?.hovered === hovered && previous?.neighbour === neighbour &&
          sameBounds(previous?.activeBox, activeBox) && sameBounds(previous?.hoverBox, hoverBox) && !reducedMotion.matches) return

      const selectionChanged = previous?.selected !== selected
      const selectingJoined = selectionChanged && selected === previous?.neighbour && connected
      const motion = previous !== undefined && !reducedMotion.matches
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
        const top = Math.min(activeBox.top, hoverBox.top)
        const union = { top, height: Math.max(activeBox.top + activeBox.height, hoverBox.top + hoverBox.height) - top }
        const approaching = motion && hoverChanged && !selectionChanged && !wasConnected && previous?.hovered !== selected

        if (approaching) {
          // Arriving from outside the active row: slide the existing hover and flatten both meeting
          // corners in one motion. Swap to the shared rectangle only once the seam is closed.
          const above = hoverBox.top < activeBox.top
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
          const above = previous.hoverBox.top < activeBox.top
          const top = Number.parseFloat(activeFrom.top)
          const bottom = top + Number.parseFloat(activeFrom.height)
          const seam = Math.min(bottom, Math.max(top, above ? activeBox.top : activeBox.top + activeBox.height))
          const upper = { top, height: seam - top }
          const lower = { top: seam, height: bottom - seam }
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
      if (hovered === nextHovered) return
      hovered = nextHovered
      update(true)
    }
    const onPointerLeave = () => {
      pointer = undefined
      hovered = undefined
      update(true)
    }
    const hitTest = () => {
      hovered = pointer && canHover.matches ? rowAt(document.elementFromPoint(pointer.x, pointer.y)) : undefined
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
      const nextRows = Array.from(list.querySelectorAll<HTMLButtonElement>(':scope > [data-workspace-id]'))
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
    reducedMotion.addEventListener('change', onLayout)
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
      reducedMotion.removeEventListener('change', onLayout)
      canHover.removeEventListener('change', onLayout)
    }
  }, [])

  // Selection, ordering and row content come from React; their geometry belongs to the DOM.
  useLayoutEffect(() => { refreshRef.current?.() })

  return { listRef, underlayRef, hoverUnderlayRef }
}
