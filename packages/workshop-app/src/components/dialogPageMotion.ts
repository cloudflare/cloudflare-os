// How a dialog goes from one of its pages to another (`Dialog`'s `page`): its surface stays, and
// widens or narrows from the one page's width to the other's about its middle (its height glides
// by itself, `SurfaceGlide`), while the page that leaves fades as it slides a little toward where
// it goes and the one that arrives comes from the other side, a moment behind it. One clock,
// easing out without overshoot, as a header's bubbles do.

/** One animation of a page change: what it is of, its keyframes and its timing. */
export type PageAnimation = {
  target: 'surface' | 'incoming' | 'outgoing'
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
}

/** How long the surface takes to reach its new width, and each page its place. */
export const PAGE_DURATION = 280
/** How far a page slides as it comes or goes. */
export const PAGE_SHIFT = 20
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

/**
 * The animations of going `forward` (deeper, so the new page comes from the right) or back, from
 * the surface's width `from` to `to`, in pixels. With reduced motion the pages only fade, quickly,
 * over a surface already at its new width. The leaving page's are held at their end, as it is drawn until
 * all of them have.
 */
export const pageMotion = ({ from, to, forward, reduced }: { from: number; to: number; forward: boolean; reduced: boolean }): PageAnimation[] => {
  if (reduced) {
    return [
      { target: 'outgoing', keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 120, easing: 'ease-out', fill: 'forwards' } },
      { target: 'incoming', keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 120, easing: 'ease-out', fill: 'backwards' } },
    ]
  }
  const shift = forward ? PAGE_SHIFT : -PAGE_SHIFT
  const motion = { duration: PAGE_DURATION, easing: EASING }
  return [
    ...(from === to ? [] : [{ target: 'surface' as const, keyframes: [{ width: `${from}px` }, { width: `${to}px` }], options: motion }]),
    // Slid by `margin-left` and `left` rather than moved, which would hide a configurator's frame
    // in it (`ResourceConfiguratorFrame`) until it settled.
    { target: 'outgoing', keyframes: [{ marginLeft: '0px' }, { marginLeft: `${-shift}px` }], options: { ...motion, fill: 'forwards' } },
    { target: 'outgoing', keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 110, easing: 'ease-out', fill: 'forwards' } },
    { target: 'incoming', keyframes: [{ left: `${shift}px` }, { left: '0px' }], options: motion },
    { target: 'incoming', keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 180, delay: 50, easing: 'ease-out', fill: 'backwards' } },
  ]
}
