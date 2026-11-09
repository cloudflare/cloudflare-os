import { useCallback, useRef } from 'react'

/** How far, in pixels, the surface overshoots past the trigger when the menu closes. */
const RECOIL = 5

/** The most, in pixels, the surface may squash below the trigger's size during that overshoot. */
const SQUASH = 3

/** When, as a fraction of the closing transition, the recoil reaches its furthest point. */
const SPRING_PEAK = 0.45

/** Peak sideways lift, in pixels, of an in-place menu, which otherwise never leaves the trigger. */
const IN_PLACE_LIFT = 32

type Insets = { top: number; right: number; bottom: number; left: number }

type Geometry = {
  insets: Insets
  side: string | undefined
  inPlace: boolean
  drift: { x: number; y: number }
}

/**
 * Mirrors the surface position in DropdownMenu.css (--menu-offset-x / -y) at progress `p`,
 * returning the surface centre's offset from the popup's centre. Used to find how fast the surface
 * arrives at the trigger, so the closing spring can be tuned to overshoot it by a fixed distance.
 * Keep the two in step.
 */
const surfaceCentre = ({ insets, side, inPlace, drift }: Geometry, p: number) => {
  const horizontal = side === 'left' || side === 'right'
  // Past the trigger (p < 0) the curve continues along its tangent, as --menu-pos-ahead does.
  const ahead = Math.max(0, p)
  const lead = 1 - p * (2 - ahead)
  const lag = 1 - p * ahead
  const shiftX = inPlace ? (horizontal ? lag : lead) : 1 - p
  const shiftY = inPlace ? (horizontal ? lead : lag) : 1 - p
  const dx = (insets.right - insets.left) / 2
  const dy = (insets.bottom - insets.top) / 2
  const curveX = inPlace ? drift.x : side === 'left' ? -insets.right : side === 'right' ? insets.left : dx
  const curveY = inPlace ? drift.y : side === 'bottom' ? insets.top : horizontal ? dy : -insets.bottom
  const bend = p * (1 - ahead)
  return {
    x: (shiftX * (insets.left - insets.right)) / 2 + curveX * bend,
    y: (shiftY * (insets.top - insets.bottom)) / 2 + curveY * bend,
  }
}

/**
 * A spring released from rest that overshoots its end by `overshoot` (as a fraction of the travel)
 * once, then settles, sampled as a CSS `linear()` easing. One continuous motion: the morph carries
 * on past the trigger along its own path and returns, rather than adding a separate bounce.
 */
const springEasing = (overshoot: number) => {
  const logOvershoot = Math.log(Math.min(Math.max(overshoot, 0.002), 0.2))
  const damping = -logOvershoot / Math.sqrt(Math.PI ** 2 + logOvershoot ** 2)
  // Peak at the same point of the transition whatever the overshoot, so a deeper recoil reads as a
  // bigger bounce rather than a stiffer, quicker one.
  const damped = Math.PI / SPRING_PEAK
  const frequency = damped / Math.sqrt(1 - damping ** 2)
  const samples = Array.from({ length: 49 }, (_, i) => {
    const t = i / 48
    const envelope = Math.exp(-damping * frequency * t)
    const value = 1 - envelope * (Math.cos(damped * t) + (damping / Math.sqrt(1 - damping ** 2)) * Math.sin(damped * t))
    return i === 48 ? 1 : Number(value.toFixed(4))
  })
  return `linear(${samples.join(', ')})`
}

/**
 * Measures the trigger in the popup's coordinates, including collision flips and shifts, so the
 * popup surface can morph out of the trigger's exact box and corner radius.
 */
export const useMenuMorph = () => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useCallback((popup: HTMLDivElement | null) => {
    const trigger = triggerRef.current
    if (!popup || !trigger) return

    const update = () => {
      const button = trigger.getBoundingClientRect()
      const menu = popup.getBoundingClientRect()
      const insets = {
        top: button.top - menu.top,
        right: menu.right - button.right,
        bottom: menu.bottom - button.bottom,
        left: button.left - menu.left,
      }
      for (const [side, value] of Object.entries(insets)) {
        popup.style.setProperty(`--menu-from-${side}`, `${value}px`)
      }
      // A fully rounded trigger reports a huge radius; the visible one is capped by its size.
      const radius = Math.min(Number.parseFloat(getComputedStyle(trigger).borderTopLeftRadius) || 0, button.width / 2, button.height / 2)
      popup.style.setProperty('--menu-trigger-width', `${button.width}px`)
      popup.style.setProperty('--menu-trigger-height', `${button.height}px`)
      popup.style.setProperty('--menu-trigger-radius', `${radius}px`)
      // The surface edge nearest the trigger on each axis, which the content and trigger copy stay
      // pinned to. A centred menu grows evenly both ways, so it pins to the centre instead.
      const pinTo = (start: number, end: number, names: [string, string]) =>
        Math.abs(start - end) < 1 ? 'center' : start < end ? names[0] : names[1]
      const pin = { x: pinTo(insets.left, insets.right, ['left', 'right']), y: pinTo(insets.top, insets.bottom, ['top', 'bottom']) }
      popup.dataset.morphX = pin.x
      popup.dataset.morphY = pin.y

      // In place, lift the surface a little toward where it opens and back, so it travels too.
      const toward = { x: (insets.right - insets.left) / 2, y: (insets.bottom - insets.top) / 2 }
      const length = Math.hypot(toward.x, toward.y) || 1
      // The lift follows p(1 - p), which peaks at a quarter.
      const drift = { x: (toward.x / length) * IN_PLACE_LIFT * 4, y: (toward.y / length) * IN_PLACE_LIFT * 4 }
      popup.style.setProperty('--menu-drift-x', `${drift.x}px`)
      popup.style.setProperty('--menu-drift-y', `${drift.y}px`)

      // How fast the surface arrives, in pixels per unit of progress, sets the overshoot that
      // carries it RECOIL pixels past the trigger along its own path.
      const geometry: Geometry = { insets, side: popup.dataset.side, inPlace: popup.hasAttribute('data-in-place'), drift }
      const step = 0.001
      const ahead = surfaceCentre(geometry, step)
      const behind = surfaceCentre(geometry, -step)
      const speed = Math.hypot(ahead.x - behind.x, ahead.y - behind.y) / (2 * step)
      if (speed > 1) popup.style.setProperty('--menu-close-easing', springEasing(RECOIL / speed))
      // Size eases toward this much progress past the trigger, so the most it shrinks along either
      // axis is SQUASH pixels, whatever the menu's size. In place, the leading axis shrinks at twice
      // the rate (its p(2 - p) has a slope of 2 there).
      const span = Math.max(menu.width - button.width, menu.height - button.height, 1) * (geometry.inPlace ? 2 : 1)
      popup.style.setProperty('--menu-squash', String(SQUASH / span))
    }

    update()
    // Keep the real button hidden through the exit animation, until Kumo unmounts
    // the popup. Swapping opaque surfaces at identical bounds avoids a crossfade.
    trigger.setAttribute('data-menu-morphing', '')
    const resize = new ResizeObserver(update)
    resize.observe(popup)
    resize.observe(trigger)
    // Kumo positions the portal after mounting, and updates its transform on scroll
    // and collision changes. Measure its final layout, never an animated surface.
    const position = new MutationObserver(update)
    position.observe(popup.parentElement!, { attributes: true, attributeFilter: ['style'] })
    // A collision flip changes the side, and so the curve the spring is tuned for.
    position.observe(popup, { attributes: true, attributeFilter: ['data-side'] })
    return () => {
      resize.disconnect()
      position.disconnect()
      trigger.removeAttribute('data-menu-morphing')
    }
  }, [])

  return { triggerRef, popupRef }
}
