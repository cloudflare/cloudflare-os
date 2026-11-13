import { SPACING, boundaryOf, layOut, surfaceRuns, type LayoutItem } from './groupedLayout'
import { planList, type PlanItem, type PlannedItem } from './groupedPlan'
import { springCurve } from './springCurve'

/** A group as the motion knows it: its rows' keys, and how to put them in another order, if it can. */
export type MotionGroup = { key: string; rows: string[]; reorder?: (keys: string[]) => void }

// Everything moves this long, on a spring that barely overshoots.
const DURATION = 420
const ease = springCurve(0.03, 0.6)
// Held this long, a finger picks a row up; moved further than SLOP before then, it scrolls instead.
const LONG_PRESS = 350
const SLOP = 8
// A mouse picks a row up once it has moved this far.
const DRAG_START = 4
// A row growing in or shrinking out is this much of its height at the least, keeping its width, and
// blurs this much, as it fades.
const SIZING_SCALE = 0.85
const SIZING_BLUR = 3

type Tween = { from: number; to: number; start: number }
const settled = (value: number): Tween => ({ from: value, to: value, start: 0 })
const done = (tween: Tween, now: number) => tween.from === tween.to || now - tween.start >= DURATION
const valueAt = (tween: Tween, now: number) =>
  done(tween, now) ? tween.to : tween.from + (tween.to - tween.from) * ease(Math.max(0, (now - tween.start) / DURATION))
const clamp = (value: number) => Math.min(1, Math.max(0, value))

type Item = {
  id: string
  key: string
  ghost: boolean
  group: string
  fades: boolean
  /** The row, or for a ghost the copy of it left shrinking out. */
  element: HTMLElement
  height: number
  /** Where the browser has laid the row out, which it is moved from. */
  flowTop: number
  presence: Tween
  gap: Tween
  /** How far it is from its place, sliding there: a reorder, or let go of after a drag. */
  lift: Tween
  /** Over the others as it slides, or as it settles once let go of. */
  raised: boolean
  dropping: boolean
}

type Drag = {
  key: string
  element: HTMLElement
  pointerId: number
  touch: boolean
  x: number
  y: number
  /** From the row's top to the pointer. */
  grab: number
  top: number
  moving: boolean
  timer?: number
}

/**
 * The motion of `GroupedList`, which renders its rows as one flat list, each group's padded apart
 * by margins: this lays them out again as they move (`planList`, `layOut`), draws the surface
 * under them (`surfaceRuns`), and moves the rows over it.
 */
export class GroupedListMotion {
  private items: Item[] = []
  private groups: MotionGroup[] = []
  private initialized = false
  private frame = 0
  private serial = 0
  private drag: Drag | undefined
  private swallowClick = false
  private focused: HTMLElement | null = null
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly observer = new ResizeObserver(() => this.measure())

  constructor(
    private readonly list: HTMLElement,
    private readonly surface: HTMLElement,
    private readonly ghosts: HTMLElement,
    private readonly announce: (text: string) => void,
  ) {
    list.addEventListener('pointerdown', this.onPointerDown)
    list.addEventListener('keydown', this.onKeyDown)
    list.addEventListener('focusin', this.onFocusIn)
    list.addEventListener('focusout', this.onFocusOut)
    list.addEventListener('click', this.onClick, true)
    list.addEventListener('dragstart', this.onDragStart, true)
    list.addEventListener('contextmenu', this.onContextMenu)
  }

  destroy() {
    cancelAnimationFrame(this.frame)
    this.endDrag(false)
    this.observer.disconnect()
    const list = this.list
    list.removeEventListener('pointerdown', this.onPointerDown)
    list.removeEventListener('keydown', this.onKeyDown)
    list.removeEventListener('focusin', this.onFocusIn)
    list.removeEventListener('focusout', this.onFocusOut)
    list.removeEventListener('click', this.onClick, true)
    list.removeEventListener('dragstart', this.onDragStart, true)
    list.removeEventListener('contextmenu', this.onContextMenu)
    this.ghosts.replaceChildren()
    this.surface.replaceChildren()
  }

  /** Takes up where React has put the rows, after each render, and sets moving what changed. */
  sync(groups: MotionGroup[]) {
    this.groups = groups
    const now = performance.now()
    const animate = this.initialized && !this.reduced.matches
    const elements = new Map(Array.from(this.list.querySelectorAll<HTMLElement>(':scope > [data-row]'), (element) => [element.dataset.row!, element]))
    const after = groups.flatMap(({ key, rows }) => rows.map((row) => ({ key: row, group: key })))

    const { tops } = this.layoutAt(now)
    const visual = new Map(this.items.map((item, index) => [item.id, tops[index] + valueAt(item.lift, now)]))
    const before: PlanItem[] = this.items.map((item) => ({ ...item, gap: valueAt(item.gap, now), presence: valueAt(item.presence, now) }))
    const planned = planList(before, after, { boundary: boundaryOf(SPACING), touching: 2 * SPACING.pad }, (key) => `${key}~${(this.serial += 1)}`)

    const byId = new Map(this.items.map((item) => [item.id, item]))
    const tween = (current: Tween | undefined, { from, to }: { from: number; to: number }): Tween => {
      if (!animate) return settled(to)
      if (current && current.to === to && Math.abs(valueAt(current, now) - from) < 0.01) return current
      return from === to ? settled(to) : { from, to, start: now }
    }
    this.items = planned.map((entry) => this.itemFor(entry, byId, elements, tween))

    for (const item of this.items) {
      if (item.ghost) continue
      item.height = item.element.offsetHeight
      item.flowTop = item.element.offsetTop
      this.observer.observe(item.element)
    }

    // What React moved, or what now has another place, slides there from where it was seen.
    const { tops: next } = this.layoutAt(now)
    this.items.forEach((item, index) => {
      const entry = planned[index]
      const seen = entry.was === undefined ? undefined : visual.get(entry.was)
      if (item.ghost || seen === undefined || this.drag?.key === item.key) return
      const from = seen - next[index]
      if (Math.abs(from - valueAt(item.lift, now)) < 0.5) return
      item.lift = animate && Math.abs(from) >= 0.5 ? { from, to: 0, start: now } : settled(0)
      item.raised = entry.change === 'slid' || Math.abs(from) > item.height
    })

    this.initialized = true
    // The browser lets go of focus in a row it moves: give it back.
    const focused = this.focused
    const active = document.activeElement
    if (focused?.isConnected && this.list.contains(focused) && active !== focused && (active === null || active === document.body)) focused.focus({ preventScroll: true })
    if (this.draw(now)) this.schedule()
  }

  private itemFor(entry: PlannedItem, byId: Map<string, Item>, elements: Map<string, HTMLElement>, tween: (current: Tween | undefined, values: { from: number; to: number }) => Tween): Item {
    const was = entry.was === undefined ? undefined : byId.get(entry.was)
    if (entry.ghost) {
      const item = was?.ghost ? was : { ...was!, id: entry.id, ghost: true, element: this.copy(was!.element), lift: settled(0), raised: false, dropping: false }
      return Object.assign(item, { fades: entry.fades, presence: tween(item.presence, entry.presence), gap: tween(item.gap, entry.gap) })
    }
    const element = elements.get(entry.key)!
    if (was?.ghost) was.element.remove()
    const item: Item = was && entry.change !== 'arrived'
      ? { ...was, id: entry.id, ghost: false, fades: false, element, lift: was.ghost ? settled(0) : was.lift }
      : { id: entry.id, key: entry.key, ghost: false, group: entry.group, fades: false, element, height: 0, flowTop: 0, presence: settled(0), gap: settled(0), lift: settled(0), raised: false, dropping: false }
    return Object.assign(item, { group: entry.group, presence: tween(was ? item.presence : undefined, entry.presence), gap: tween(was ? item.gap : undefined, entry.gap) })
  }

  /** A copy of a row that has left, to shrink out where it was. */
  private copy(row: HTMLElement) {
    const copy = row.cloneNode(true) as HTMLElement
    copy.removeAttribute('data-row')
    copy.removeAttribute('data-lifted')
    for (const named of copy.querySelectorAll('[id]')) named.removeAttribute('id')
    copy.inert = true
    Object.assign(copy.style, { position: 'absolute', left: `${SPACING.pad}px`, right: `${SPACING.pad}px`, margin: '0', transform: '', zIndex: '' })
    this.ghosts.append(copy)
    return copy
  }

  private layoutAt(now: number) {
    const shape: LayoutItem[] = this.items.map((item) => ({ height: item.height, presence: valueAt(item.presence, now), gap: valueAt(item.gap, now), fades: item.fades }))
    return { shape, ...layOut(shape, SPACING) }
  }

  /** Lets go of copies that have shrunk out, their room joining what was before them. */
  private prune(now: number) {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index]
      if (!item.ghost || !done(item.presence, now)) continue
      const prior = this.items[index - 1]
      if (prior) {
        const from = valueAt(prior.gap, now) + valueAt(item.gap, now)
        const to = prior.gap.to + item.gap.to
        prior.gap = from === to ? settled(to) : { from, to, start: now }
      }
      item.element.remove()
      this.items.splice(index, 1)
    }
  }

  /** Draws everything as it is at `now`; says whether anything is still moving. */
  private draw(now: number) {
    this.prune(now)
    const { shape, tops, height } = this.layoutAt(now)
    let active = this.drag?.moving === true
    this.items.forEach((item, index) => {
      const presence = clamp(shape[index].presence)
      const shown = item.height * presence
      active ||= !done(item.presence, now) || !done(item.gap, now) || !done(item.lift, now)
      // Growing in or shrinking out, it is whole, in the middle of the room it has, grown or shrunk
      // towards it, and blurred as it fades: it shows once there is room for it, and is gone before
      // the room is, so nothing cuts it off.
      const sizing = presence < 1
      const fade = clamp((presence - 0.5) / 0.5)
      const centring = (shown - item.height) / 2
      const scale = sizing ? ` scaleY(${SIZING_SCALE + (1 - SIZING_SCALE) * presence})` : ''
      const fading = { opacity: sizing ? String(fade) : '', filter: fade < 1 ? `blur(${(1 - fade) * SIZING_BLUR}px)` : '' }
      if (item.ghost) {
        Object.assign(item.element.style, { top: `${tops[index] + centring}px`, height: `${item.height}px`, transform: scale.trim(), ...fading })
        return
      }
      if (done(item.lift, now)) {
        item.raised = false
        item.dropping = false
      }
      const dragged = this.drag?.moving === true && this.drag.key === item.key
      const translate = (dragged ? this.drag!.top : tops[index] + valueAt(item.lift, now) + (sizing ? centring : 0)) - item.flowTop
      Object.assign(item.element.style, {
        transform: Math.abs(translate) < 0.01 && !sizing ? '' : `translateY(${translate}px)${scale}`,
        ...fading,
        zIndex: dragged || item.dropping ? '2' : item.raised ? '1' : '',
      })
      item.element.toggleAttribute('data-lifted', dragged || item.dropping)
    })

    const runs = surfaceRuns(shape, tops, SPACING)
    while (this.surface.children.length < runs.length) {
      const run = document.createElement('div')
      run.className = 'absolute inset-x-0 bg-kumo-tint'
      this.surface.append(run)
    }
    while (this.surface.children.length > runs.length) this.surface.lastElementChild!.remove()
    runs.forEach(({ top, height: tall, topRadius, bottomRadius }, index) => {
      Object.assign((this.surface.children[index] as HTMLElement).style, {
        top: `${top}px`,
        height: `${tall}px`,
        borderRadius: `${topRadius}px ${topRadius}px ${bottomRadius}px ${bottomRadius}px`,
      })
    })
    // As tall as it is drawn while it moves, so that what is after it moves with it.
    this.list.style.height = active ? `${height}px` : ''
    return active
  }

  private schedule() {
    if (this.frame) return
    this.frame = requestAnimationFrame((now) => {
      this.frame = 0
      if (this.draw(now)) this.schedule()
    })
  }

  /** Reads the rows' sizes again, as when the list is resized. */
  private measure() {
    for (const item of this.items) {
      if (item.ghost) continue
      item.height = item.element.offsetHeight
      item.flowTop = item.element.offsetTop
    }
    if (this.draw(performance.now())) this.schedule()
  }

  private rowOf(target: EventTarget | null) {
    const row = target instanceof Element ? target.closest<HTMLElement>('[data-row]') : null
    if (!row || row.parentElement !== this.list) return undefined
    const key = row.dataset.row!
    const group = this.groups.find(({ rows }) => rows.includes(key))
    return group ? { row, key, group } : undefined
  }

  private move(group: MotionGroup, key: string, to: number) {
    const keys = group.rows.filter((other) => other !== key)
    keys.splice(to, 0, key)
    group.reorder?.(keys)
    return keys
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    const found = this.rowOf(event.target)
    if (!found?.group.reorder) return
    event.preventDefault()
    const to = found.group.rows.indexOf(found.key) + (event.key === 'ArrowUp' ? -1 : 1)
    if (to < 0 || to >= found.group.rows.length) return
    const keys = this.move(found.group, found.key, to)
    this.announce(`Moved to ${keys.indexOf(found.key) + 1} of ${keys.length}`)
  }

  private onFocusIn = (event: FocusEvent) => {
    this.focused = event.target instanceof HTMLElement ? event.target : null
  }

  private onFocusOut = () => {
    // Let go of by the person, not by a move: a move gives it back before this runs.
    queueMicrotask(() => {
      if (!this.list.contains(document.activeElement)) this.focused = null
    })
  }

  private onClick = (event: MouseEvent) => {
    if (!this.swallowClick) return
    event.preventDefault()
    event.stopPropagation()
    this.swallowClick = false
  }

  // Links are the browser's to drag otherwise, which would end a drag of their row.
  private onDragStart = (event: DragEvent) => {
    if (this.rowOf(event.target)?.group.reorder) event.preventDefault()
  }

  // A long press is the row's, not the menu a touch browser opens for one.
  private onContextMenu = (event: Event) => {
    if (this.drag?.touch) event.preventDefault()
  }

  private holdStill = (event: TouchEvent) => {
    if (this.drag?.moving) event.preventDefault()
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.drag) return
    const found = this.rowOf(event.target)
    if (!found?.group.reorder) return
    const listTop = this.list.getBoundingClientRect().top
    const top = found.row.getBoundingClientRect().top - listTop
    const touch = event.pointerType === 'touch'
    this.drag = { key: found.key, element: found.row, pointerId: event.pointerId, touch, x: event.clientX, y: event.clientY, grab: event.clientY - listTop - top, top, moving: false }
    if (touch) {
      // A touch scrolls the page, unless it is held still for a moment: then it picks the row up,
      // and the page is kept from scrolling under it until the finger lifts.
      this.drag.timer = window.setTimeout(() => this.begin(), LONG_PRESS)
      found.row.addEventListener('touchmove', this.holdStill, { passive: false })
    }
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerCancel)
  }

  private begin() {
    const drag = this.drag
    if (!drag) return
    window.clearTimeout(drag.timer)
    drag.moving = true
    this.swallowClick = true
    this.schedule()
  }

  private onPointerMove = (event: PointerEvent) => {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!drag.moving) {
      const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y)
      if (drag.touch) {
        if (distance > SLOP) this.endDrag(false)
        return
      }
      if (distance < DRAG_START) return
      this.begin()
    }
    const group = this.groups.find(({ rows }) => rows.includes(drag.key))
    if (!group) return
    // Within its group's rows, which it is put among by where its middle is.
    const { tops } = this.layoutAt(performance.now())
    const places = group.rows.map((key) => this.items.findIndex((item) => !item.ghost && item.key === key))
    const self = this.items[places[group.rows.indexOf(drag.key)]]
    const first = tops[Math.min(...places)]
    const last = Math.max(...places)
    const lowest = tops[last] + this.items[last].height - self.height
    drag.top = Math.min(lowest, Math.max(first, event.clientY - this.list.getBoundingClientRect().top - drag.grab))
    const middle = drag.top + self.height / 2
    const to = group.rows.filter((key, index) => key !== drag.key && tops[places[index]] + this.items[places[index]].height / 2 < middle).length
    if (to !== group.rows.indexOf(drag.key)) this.move(group, drag.key, to)
    this.schedule()
  }

  private onPointerUp = (event: PointerEvent) => {
    if (event.pointerId === this.drag?.pointerId) this.endDrag(true)
  }

  private onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId === this.drag?.pointerId) this.endDrag(false)
  }

  /** Lets go of the row: put down where it was taken to, it settles into its place. */
  private endDrag(drop: boolean) {
    const drag = this.drag
    if (!drag) return
    window.clearTimeout(drag.timer)
    drag.element.removeEventListener('touchmove', this.holdStill)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerCancel)
    this.drag = undefined
    if (!drag.moving) return
    const now = performance.now()
    const index = this.items.findIndex((item) => !item.ghost && item.key === drag.key)
    const item = this.items[index]
    if (item) {
      const from = drag.top - this.layoutAt(now).tops[index]
      item.lift = drop && !this.reduced.matches && from !== 0 ? { from, to: 0, start: now } : settled(0)
      item.dropping = true
    }
    // After the click the drag ends with, which comes before this.
    window.setTimeout(() => {
      this.swallowClick = false
    })
    this.schedule()
  }
}
