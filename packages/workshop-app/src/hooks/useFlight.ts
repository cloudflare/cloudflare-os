import { useLayoutEffect, useRef, type RefObject } from 'react'

// How briskly it settles, as the natural frequency of the spring: it comes within 5% of where it is
// going in about 4.7 / OMEGA seconds, with no overshoot, however many times it is told to go elsewhere.
const OMEGA = 10
// The same, `brisk`: for a way back that is to be done by the time what it leaves has gone.
const BRISK_OMEGA = 16
// What it is told is first eased towards, so that a long way to go is not a kick: the spring is pulled
// along gradually, and starts as gently as it ends. Also a frequency, in the same unit.
const EASE_IN = 14
const BRISK_EASE_IN = 22
// How near it has to be to be there, in pixels.
const NEAR = 8
// The fastest it goes, in pixels a second, however far.
const TOP_SPEED = 1500

type Point = { x: number; y: number }

// Where an element is laid out in the document, which scrolling does not change.
const laidOutAt = (element: HTMLElement): Point => {
  const point = { x: 0, y: 0 }
  for (let at: Element | null = element; at instanceof HTMLElement; at = at.offsetParent) {
    point.x += at.offsetLeft
    point.y += at.offsetTop
  }
  return point
}

/**
 * Keeps `flier`, which sits at the top left of `stage`, centred on `target`, wherever that is as the
 * page lays itself out, and carries it to a new `target` when that changes rather than putting it
 * there. What is carried is how far it is from the target, which settles to nothing on a critically
 * damped spring: it is where the target is, plus that. So what moves the target while it is where it
 * is going, such as a row opening above it, moves it too, in step, and only a change of target is
 * a journey. Told to go elsewhere part of the way, it carries on from the speed it has, instead of
 * stopping and setting off again. It sets off from where it was last seen, even where the stage has moved
 * since, as when something came in above it. A target that has left the page is where it was last seen. Without
 * `animate` it is put there at once. `onArrive` is told when it is there (within a few pixels of it)
 * and when it is not, which is while it is on its way to a new place. `brisk` is a quicker spring.
 */
export const useFlight = (stage: RefObject<HTMLElement | null>, flier: RefObject<HTMLElement | null>, target: HTMLElement | null, animate: boolean, onArrive?: (arrived: boolean) => void, brisk = false) => {
  const at = useRef<Point>(undefined)
  // Where the stage was when it was last drawn, which `at` is from.
  const stageAt = useRef<Point>(undefined)
  const lastAim = useRef<Point>(undefined)
  // How far it is from the target, how fast that is changing, and what the spring is being pulled towards.
  const apart = useRef<Point>({ x: 0, y: 0 })
  const speed = useRef<Point>({ x: 0, y: 0 })
  const pulled = useRef<Point>({ x: 0, y: 0 })

  useLayoutEffect(() => {
    const parent = stage.current
    const moving = flier.current
    if (!parent || !moving || !target) return

    const aim = (): Point => {
      if (!target.isConnected && lastAim.current) return lastAim.current
      const from = parent.getBoundingClientRect()
      const to = target.getBoundingClientRect()
      lastAim.current = { x: to.left - from.left + (to.width - moving.offsetWidth) / 2, y: to.top - from.top + (to.height - moving.offsetHeight) / 2 }
      return lastAim.current
    }
    const draw = (goal: Point) => {
      const point = { x: goal.x + apart.current.x, y: goal.y + apart.current.y }
      at.current = point
      stageAt.current = laidOutAt(parent)
      // The `translate` property rather than `transform`: a scale of its own on `flier` (the property of that
      // name) is then about its middle, where this puts it, and not multiplied into how far it is moved.
      moving.style.translate = `${point.x}px ${point.y}px`
    }

    let arrived = false
    const mark = (is: boolean) => {
      if (is === arrived) return
      arrived = is
      onArrive?.(is)
    }
    onArrive?.(false)

    // Told to go to a new target: where it is now is that far from it, and the spring settles that.
    const first = aim()
    // Where the stage was laid out when it was last seen there, for setting off from there if it has moved since.
    const was = stageAt.current
    let gone = false
    if (animate && at.current) {
      apart.current = { x: at.current.x - first.x, y: at.current.y - first.y }
      pulled.current = { ...apart.current }
      // Where the stage is now is only known once everything else of this commit is laid out, such as a row above
      // it opening from less than its height, which its own effect starts: after them all, before it is drawn.
      if (was) {
        queueMicrotask(() => {
          if (gone) return
          const now = laidOutAt(parent)
          const by = { x: was.x - now.x, y: was.y - now.y }
          apart.current = { x: apart.current.x + by.x, y: apart.current.y + by.y }
          pulled.current = { x: pulled.current.x + by.x, y: pulled.current.y + by.y }
          draw(aim())
          wake()
        })
      }
    } else {
      apart.current = { x: 0, y: 0 }
      speed.current = { x: 0, y: 0 }
    }

    let frame = 0
    let last = 0
    const step = (now: number) => {
      frame = 0
      const goal = aim()
      // Frames that were skipped (a tab in the background) are not made up for in one lurch.
      const dt = Math.min((now - (last || now - 16)) / 1000, 0.032)
      last = now
      const omega = brisk ? BRISK_OMEGA : OMEGA
      const eased = 1 - Math.exp(-(brisk ? BRISK_EASE_IN : EASE_IN) * dt)
      const p = pulled.current
      p.x -= p.x * eased
      p.y -= p.y * eased
      const a = apart.current
      const v = speed.current
      v.x += (omega * omega * (p.x - a.x) - 2 * omega * v.x) * dt
      v.y += (omega * omega * (p.y - a.y) - 2 * omega * v.y) * dt
      const fast = Math.hypot(v.x, v.y)
      if (fast > TOP_SPEED) {
        v.x *= TOP_SPEED / fast
        v.y *= TOP_SPEED / fast
      }
      a.x += v.x * dt
      a.y += v.y * dt
      if (Math.hypot(a.x, a.y) < 0.2 && Math.hypot(v.x, v.y) < 2) {
        apart.current = { x: 0, y: 0 }
        speed.current = { x: 0, y: 0 }
        pulled.current = { x: 0, y: 0 }
        last = 0
        mark(true)
        return draw(goal)
      }
      mark(Math.hypot(a.x, a.y) < NEAR)
      draw(goal)
      frame = requestAnimationFrame(step)
    }
    const wake = () => {
      if (!frame) frame = requestAnimationFrame(step)
    }

    draw(first)
    if (Math.hypot(apart.current.x, apart.current.y) > 0.2) wake()
    else mark(true)
    // The stage changing size, as what it holds opens, closes or comes in, moves the target: it goes with it
    // at once, in the same frame, rather than after it.
    const watch = new ResizeObserver(() => draw(aim()))
    watch.observe(parent)
    return () => {
      gone = true
      cancelAnimationFrame(frame)
      watch.disconnect()
    }
  }, [stage, flier, target, animate, onArrive, brisk])
}
