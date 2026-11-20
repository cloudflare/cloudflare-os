// How a dialog's surface follows what it holds as that grows or shrinks (`Dialog`): its height
// glides to each new one rather than jumping, a burst of changes making one glide to the latest,
// which takes over from where the last one had got to and how fast it was going.
//
// While it glides the surface is given its height, and what it holds is laid out in that: growing,
// the part of it that scrolls is shorter until the surface is tall enough, so that its foot stays
// at the surface's; shrinking, there is room under it until the surface has come up to it. It is
// still in the middle of the window, by its margins: nothing is transformed, so a configurator's
// frame in it is placed by the window throughout (`ResourceConfiguratorFrame`). Settled, it is as
// tall as what it holds, as if nothing had been done.

import { isMotionOff } from '../motion/motion'

/** How stiff the glide is: it is within a pixel or two of where it goes after about 280 ms. */
const STIFFNESS = 24

/**
 * One step of the glide, `dt` seconds on, from `height` going at `velocity` (pixels a second)
 * toward `target`: a critically damped spring, which never goes past where it is going from
 * rest, and turns smoothly toward a new target from wherever it is.
 */
export const glideStep = ({ height, velocity, target, dt }: { height: number; velocity: number; target: number; dt: number }) => {
  const offset = height - target
  const drive = velocity + STIFFNESS * offset
  const decay = Math.exp(-STIFFNESS * dt)
  return {
    height: target + (offset + drive * dt) * decay,
    velocity: (velocity - STIFFNESS * drive * dt) * decay,
  }
}

/** Close enough, and slow enough, to be where it is going. */
export const glideSettled = ({ height, velocity, target }: { height: number; velocity: number; target: number }) =>
  Math.abs(height - target) < 0.5 && Math.abs(velocity) < 20

/**
 * Glides `surface`'s height after what it holds. What it holds is read again as anything in it
 * changes, before that is drawn, and each frame while it glides. `cut()` keeps it cut to its
 * rounded edge while something else moves in it (a page's width), until the returned function is
 * called.
 */
export class SurfaceGlide {
  private height: number | undefined
  private velocity = 0
  private target = 0
  private frame = 0
  private last = 0
  private cuts = 0
  private readonly heights = new WeakMap<Element, number>()
  private readonly sizes: ResizeObserver
  private readonly changes: MutationObserver

  constructor(private readonly surface: HTMLElement) {
    // Only noted, for `heightOf`: what is done about a change is done as it is made.
    this.sizes = new ResizeObserver((entries) => {
      for (const { target, borderBoxSize } of entries) this.heights.set(target, borderBoxSize[0]?.blockSize ?? 0)
    })
    this.changes = new MutationObserver((records) => {
      if (records.some(({ type }) => type === 'childList')) this.observeChildren()
      // Not what this sets on the surface, nor where a configurator's frame is placed each frame.
      if (records.some(({ target }) => target !== surface && !(target instanceof HTMLIFrameElement))) this.measure()
    })
    this.changes.observe(surface, { subtree: true, childList: true, attributes: true, characterData: true })
    window.addEventListener('resize', this.measure)
    this.observeChildren()
    this.measure()
  }

  /** How tall one of what it holds was last laid out. */
  heightOf(element: Element) {
    return this.heights.get(element)
  }

  cut() {
    this.cuts++
    this.draw()
    let cut = true
    return () => {
      if (!cut) return
      cut = false
      this.cuts--
      this.draw()
    }
  }

  /** Takes what it holds as it is now, at once: for a change made where it is known, such as one page taking another's place. */
  refresh() {
    this.observeChildren()
    this.measure()
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    this.sizes.disconnect()
    this.changes.disconnect()
    window.removeEventListener('resize', this.measure)
  }

  private observeChildren() {
    this.sizes.disconnect()
    for (const child of this.surface.children) this.sizes.observe(child)
  }

  // How tall it would be as it is, laid out as tall as what it holds, as far as it may be.
  private natural() {
    const { style } = this.surface
    const given = style.height
    style.height = ''
    const height = this.surface.offsetHeight
    style.height = given
    return height
  }

  private readonly measure = () => {
    this.target = this.natural()
    // Its first height it opens at; with reduced motion, every one it takes at once.
    if (this.height === undefined || isMotionOff()) {
      this.height = this.target
      this.velocity = 0
    } else if (!this.frame && !glideSettled({ height: this.height, velocity: this.velocity, target: this.target })) {
      this.last = performance.now()
      this.frame = requestAnimationFrame(this.step)
    }
    this.draw()
  }

  private readonly step = (now: number) => {
    // The step is exact for any time, so a slow frame (the page busy loading) goes as far as the
    // time it took rather than the glide crawling; a quarter of a second at most, so that a tab
    // come back to does not leap.
    const dt = Math.min((now - this.last) / 1000, 1 / 4)
    this.last = now
    this.target = this.natural()
    const next = glideStep({ height: this.height ?? this.target, velocity: this.velocity, target: this.target, dt })
    if (glideSettled({ ...next, target: this.target })) {
      this.height = this.target
      this.velocity = 0
      this.frame = 0
    } else {
      this.height = next.height
      this.velocity = next.velocity
      this.frame = requestAnimationFrame(this.step)
    }
    this.draw()
  }

  private draw() {
    Object.assign(this.surface.style, {
      height: this.frame ? `${this.height}px` : '',
      // The ring is drawn just outside it.
      clipPath: this.cuts > 0 ? 'inset(-1px round calc(1.5rem + 1px))' : '',
    })
  }
}
