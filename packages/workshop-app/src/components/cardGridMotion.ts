import { isMotionOff } from '@/prefs/motion'
import { arrowPlace, isArrowKey, nearestSlot, type Slot } from './cardGridLayout'
import { motionCurve } from './springCurve'

/** A group as the motion knows it: its cards' keys, and how to put them in another order, if it can. */
export type CardMotionGroup = { key: string; cards: string[]; reorder?: (keys: string[]) => void }

// As `GroupedListMotion` moves its rows: this long, on a spring that barely overshoots, a finger
// picking a card up once held this long unless it has moved further than SLOP, a mouse once it has
// moved this far.
const DURATION = 420
const ease = motionCurve(0.03, 0.6)
const LONG_PRESS = 350
const SLOP = 8
const DRAG_START = 4
// A card that has been picked up is this much larger.
const LIFT = 1.03

/** How far a card was from its place at `start`, from where it slides there. */
type Slide = { x: number; y: number; start: number }

/** How wide a card was drawn at `start`, from which it grows or shrinks to its place's width. */
type Resize = { from: number; start: number }

export type CardGridMotionOptions = {
  /** Off, the cards are only moved by the keyboard, as where something else drags them. */
  pointer?: boolean
  /**
   * A card whose place changes width, as when how many are on a line does, slides by its middle,
   * and what is in it (its one child) grows or shrinks to the new width about that middle.
   */
  resize?: boolean
}

type Card = {
  key: string
  element: HTMLElement
  /** Where the browser has laid the card out, which it is moved from. */
  slot: Slot
  slide?: Slide
  resize?: Resize
  /** Over the others as it settles, once let go of. */
  dropping: boolean
}

type Drag = {
  key: string
  element: HTMLElement
  pointerId: number
  touch: boolean
  startX: number
  startY: number
  /** From the card's corner to the pointer. */
  grabX: number
  grabY: number
  /** Where the card is drawn, within the grid. */
  x: number
  y: number
  moving: boolean
  timer?: number
}

const clamp = (value: number, least: number, most: number) => Math.min(most, Math.max(least, value))

/**
 * The motion of `CardGrid`: a card that has another place after a render slides there from where it
 * was seen, and one that arrives fades in. A card of a group that can be reordered is dragged with
 * a mouse, held and dragged with a finger, or moved with Alt and an arrow key, to any of its
 * group's places (`nearestSlot`, `arrowPlace`), the others making way as it passes.
 */
export class CardGridMotion {
  private cards: Card[] = []
  private groups: CardMotionGroup[] = []
  private initialized = false
  private frame = 0
  private drag: Drag | undefined
  private swallowClick = false
  private focused: HTMLElement | null = null
  private readonly observer = new ResizeObserver(() => this.measure())

  private readonly pointer: boolean
  private readonly resize: boolean

  constructor(
    private readonly grid: HTMLElement,
    private readonly announce: (text: string) => void,
    { pointer = true, resize = false }: CardGridMotionOptions = {},
  ) {
    this.pointer = pointer
    this.resize = resize
    grid.addEventListener('pointerdown', this.onPointerDown)
    grid.addEventListener('keydown', this.onKeyDown)
    grid.addEventListener('focusin', this.onFocusIn)
    grid.addEventListener('focusout', this.onFocusOut)
    grid.addEventListener('click', this.onClick, true)
    grid.addEventListener('dragstart', this.onDragStart, true)
    grid.addEventListener('contextmenu', this.onContextMenu)
  }

  destroy() {
    cancelAnimationFrame(this.frame)
    this.endDrag(false)
    this.observer.disconnect()
    const grid = this.grid
    grid.removeEventListener('pointerdown', this.onPointerDown)
    grid.removeEventListener('keydown', this.onKeyDown)
    grid.removeEventListener('focusin', this.onFocusIn)
    grid.removeEventListener('focusout', this.onFocusOut)
    grid.removeEventListener('click', this.onClick, true)
    grid.removeEventListener('dragstart', this.onDragStart, true)
    grid.removeEventListener('contextmenu', this.onContextMenu)
  }

  /** Takes up where React has put the cards, after each render, and sets moving what changed place. */
  sync(groups: CardMotionGroup[]) {
    this.groups = groups
    const now = performance.now()
    const animate = this.initialized && !isMotionOff()
    const before = new Map(this.cards.map((card) => [card.key, { card, width: this.widthAt(card, now), ...this.seenAt(card, now) }]))

    this.cards = Array.from(this.grid.querySelectorAll<HTMLElement>('[data-card]'), (element) => {
      const key = element.dataset.card!
      const slot = this.slotOf(element)
      const was = before.get(key)
      const card: Card = { key, element, slot, dropping: was?.card.dropping ?? false }
      this.observer.observe(element)
      if (!was) {
        if (animate) element.animate([{ opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1 }], { duration: 200, easing: 'ease-out' })
        return card
      }
      // The one being dragged is where the pointer has it.
      if (this.drag?.moving && this.drag.key === key) return card
      // By its middle where it can change width, so that what is in it does not jump to one side.
      const resized = this.resize && animate && Math.abs(was.width - slot.width) >= 0.5
      if (resized) card.resize = { from: was.width, start: now }
      const x = this.resize ? was.x + was.card.slot.width / 2 - (slot.left + slot.width / 2) : was.x - slot.left
      const y = was.y - slot.top
      if (!animate || (Math.abs(x) < 0.5 && Math.abs(y) < 0.5)) return card
      // One already on its way to this place carries on, rather than starting over.
      const under = was.card.slide && this.offsetOf(was.card, now)
      card.slide = under && Math.abs(under.x - x) < 0.5 && Math.abs(under.y - y) < 0.5 ? was.card.slide : { x, y, start: now }
      return card
    })

    this.initialized = true
    // The browser lets go of focus in a card it moves: give it back.
    const focused = this.focused
    const active = document.activeElement
    if (focused?.isConnected && this.grid.contains(focused) && active !== focused && (active === null || active === document.body)) focused.focus({ preventScroll: true })
    if (this.draw(now)) this.schedule()
  }

  /** Within the grid, which is what the cards are laid out against. */
  private slotOf(element: HTMLElement): Slot {
    return { left: element.offsetLeft, top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight }
  }

  private offsetOf(card: Card, now: number) {
    if (!card.slide) return { x: 0, y: 0 }
    const left = 1 - ease(clamp((now - card.slide.start) / DURATION, 0, 1))
    return { x: card.slide.x * left, y: card.slide.y * left }
  }

  /** How wide what is in a card is drawn at `now`. */
  private widthAt(card: Card, now: number) {
    if (!card.resize) return card.slot.width
    const done = ease(clamp((now - card.resize.start) / DURATION, 0, 1))
    return card.resize.from + (card.slot.width - card.resize.from) * done
  }

  /** Where a card is drawn at `now`, within the grid. */
  private seenAt(card: Card, now: number) {
    if (this.drag?.moving && this.drag.key === card.key) return { x: this.drag.x, y: this.drag.y }
    const offset = this.offsetOf(card, now)
    return { x: card.slot.left + offset.x, y: card.slot.top + offset.y }
  }

  /** Draws every card where it is at `now`; says whether anything is still moving. */
  private draw(now: number) {
    let active = this.drag?.moving === true
    for (const card of this.cards) {
      const dragged = this.drag?.moving === true && this.drag.key === card.key
      if (card.slide && now - card.slide.start >= DURATION) card.slide = undefined
      if (!card.slide && !dragged) card.dropping = false
      active ||= card.slide !== undefined
      if (card.resize) {
        const content = card.element.firstElementChild
        const width = this.widthAt(card, now)
        if (now - card.resize.start >= DURATION) card.resize = undefined
        else active = true
        if (content instanceof HTMLElement) {
          Object.assign(content.style, card.resize ? { width: `${width}px`, translate: `${(card.slot.width - width) / 2}px 0` } : { width: '', translate: '' })
        }
      }
      const { x, y } = this.seenAt(card, now)
      const dx = x - card.slot.left
      const dy = y - card.slot.top
      const still = Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01
      Object.assign(card.element.style, {
        transform: still && !dragged ? '' : `translate(${dx}px, ${dy}px)${dragged ? ` scale(${LIFT})` : ''}`,
        zIndex: dragged || card.dropping ? '2' : card.slide ? '1' : '',
      })
      card.element.toggleAttribute('data-lifted', dragged || card.dropping)
    }
    return active
  }

  private schedule() {
    if (this.frame) return
    this.frame = requestAnimationFrame((now) => {
      this.frame = 0
      if (this.draw(now)) this.schedule()
    })
  }

  /** Reads the cards' places again, as when the grid is resized and has more or fewer to a line. */
  private measure() {
    for (const card of this.cards) card.slot = this.slotOf(card.element)
    if (this.draw(performance.now())) this.schedule()
  }

  private cardOf(target: EventTarget | null) {
    const element = target instanceof Element ? target.closest<HTMLElement>('[data-card]') : null
    if (!element || !this.grid.contains(element)) return undefined
    const key = element.dataset.card!
    const group = this.groups.find(({ cards }) => cards.includes(key))
    return group ? { element, key, group } : undefined
  }

  /** The places of a group's cards, in order. */
  private slotsOf(group: CardMotionGroup) {
    const slots = new Map(this.cards.map((card) => [card.key, card.slot]))
    return group.cards.map((key) => slots.get(key)!)
  }

  private move(group: CardMotionGroup, key: string, to: number) {
    const keys = group.cards.filter((other) => other !== key)
    keys.splice(to, 0, key)
    group.reorder?.(keys)
    return keys
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey || !isArrowKey(event.key)) return
    const found = this.cardOf(event.target)
    if (!found?.group.reorder) return
    event.preventDefault()
    const to = arrowPlace(this.slotsOf(found.group), found.group.cards.indexOf(found.key), event.key)
    if (to === undefined) return
    const keys = this.move(found.group, found.key, to)
    this.announce(`Moved to ${keys.indexOf(found.key) + 1} of ${keys.length}`)
  }

  private onFocusIn = (event: FocusEvent) => {
    this.focused = event.target instanceof HTMLElement ? event.target : null
  }

  private onFocusOut = () => {
    // Let go of by the person, not by a move: a move gives it back before this runs.
    queueMicrotask(() => {
      if (!this.grid.contains(document.activeElement)) this.focused = null
    })
  }

  private onClick = (event: MouseEvent) => {
    if (!this.swallowClick) return
    event.preventDefault()
    event.stopPropagation()
    this.swallowClick = false
  }

  // Links are the browser's to drag otherwise, which would end a drag of their card.
  private onDragStart = (event: DragEvent) => {
    if (this.pointer && this.cardOf(event.target)?.group.reorder) event.preventDefault()
  }

  // A long press is the card's, not the menu a touch browser opens for one.
  private onContextMenu = (event: Event) => {
    if (this.drag?.touch) event.preventDefault()
  }

  private holdStill = (event: TouchEvent) => {
    if (this.drag?.moving) event.preventDefault()
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.drag || !this.pointer) return
    const found = this.cardOf(event.target)
    if (!found?.group.reorder) return
    const within = this.grid.getBoundingClientRect()
    const box = found.element.getBoundingClientRect()
    const x = box.left - within.left
    const y = box.top - within.top
    const touch = event.pointerType === 'touch'
    this.drag = {
      key: found.key,
      element: found.element,
      pointerId: event.pointerId,
      touch,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - within.left - x,
      grabY: event.clientY - within.top - y,
      x,
      y,
      moving: false,
    }
    if (touch) {
      // A touch scrolls the page, unless it is held still for a moment: then it picks the card up,
      // and the page is kept from scrolling under it until the finger lifts.
      this.drag.timer = window.setTimeout(() => this.begin(), LONG_PRESS)
      found.element.addEventListener('touchmove', this.holdStill, { passive: false })
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
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
      if (drag.touch) {
        if (distance > SLOP) this.endDrag(false)
        return
      }
      if (distance < DRAG_START) return
      this.begin()
    }
    const group = this.groups.find(({ cards }) => cards.includes(drag.key))
    if (!group) return
    // Within its group's places, which it is put among by where it is drawn (`nearestSlot`).
    const slots = this.slotsOf(group)
    const index = group.cards.indexOf(drag.key)
    const self = slots[index]
    const within = this.grid.getBoundingClientRect()
    drag.x = clamp(event.clientX - within.left - drag.grabX, Math.min(...slots.map(({ left }) => left)), Math.max(...slots.map(({ left, width }) => left + width)) - self.width)
    drag.y = clamp(event.clientY - within.top - drag.grabY, Math.min(...slots.map(({ top }) => top)), Math.max(...slots.map(({ top, height }) => top + height)) - self.height)
    const to = nearestSlot(slots, drag.x + self.width / 2, drag.y + self.height / 2)
    if (to !== index) this.move(group, drag.key, to)
    this.schedule()
  }

  private onPointerUp = (event: PointerEvent) => {
    if (event.pointerId === this.drag?.pointerId) this.endDrag(true)
  }

  private onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId === this.drag?.pointerId) this.endDrag(false)
  }

  /** Lets go of the card: put down where it was taken to, it settles into its place. */
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
    const card = this.cards.find(({ key }) => key === drag.key)
    if (card) {
      const x = drag.x - card.slot.left
      const y = drag.y - card.slot.top
      card.slide = drop && !isMotionOff() && (x !== 0 || y !== 0) ? { x, y, start: performance.now() } : undefined
      card.dropping = true
    }
    // After the click the drag ends with, which comes before this.
    window.setTimeout(() => {
      this.swallowClick = false
    })
    this.schedule()
  }
}
