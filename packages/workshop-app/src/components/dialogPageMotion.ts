// How a dialog goes from one of its pages to another (`Dialog`'s `page`): its surface stays, and
// grows or shrinks from the one page's size to the other's about its middle, while the page that
// leaves fades as it slides a little toward where it goes and the one that arrives comes from the
// other side, a moment behind it. Each page stays where it is when settled, so only the surface's
// edges and that slide move. One clock, easing out without overshoot, as a header's bubbles do.

/** A page's size, or the surface's, in pixels. */
export type PageSize = { width: number; height: number }

/** One animation of a page change: what it is of, its keyframes and its timing. */
export type PageAnimation = {
  target: 'surface' | 'incoming' | 'outgoing'
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
}

/** How long the surface takes to reach its new size, and each page its place. */
export const PAGE_DURATION = 280
/** How far a page slides as it comes or goes. */
export const PAGE_SHIFT = 20
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

/**
 * The animations of going `forward` (deeper, so the new page comes from the right) or back, from
 * the surface's size `from` to `to`. With reduced motion the pages only fade, quickly, over a
 * surface already at its new size. The leaving page's are held at their end, as it is drawn until
 * all of them have.
 */
export const pageMotion = ({ from, to, forward, reduced }: { from: PageSize; to: PageSize; forward: boolean; reduced: boolean }): PageAnimation[] => {
  if (reduced) {
    return [
      { target: 'outgoing', keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 120, easing: 'ease-out', fill: 'forwards' } },
      { target: 'incoming', keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 120, easing: 'ease-out', fill: 'backwards' } },
    ]
  }
  const shift = forward ? PAGE_SHIFT : -PAGE_SHIFT
  const motion = { duration: PAGE_DURATION, easing: EASING }
  const resized = from.width !== to.width || from.height !== to.height
  return [
    ...(resized ? [{
      target: 'surface' as const,
      keyframes: [{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }],
      options: motion,
    }] : []),
    // Slid by `margin-left` and `left` rather than moved, which would hide a configurator's frame
    // in it (`ResourceConfiguratorFrame`) until it settled.
    { target: 'outgoing', keyframes: [{ marginLeft: '0px' }, { marginLeft: `${-shift}px` }], options: { ...motion, fill: 'forwards' } },
    { target: 'outgoing', keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 110, easing: 'ease-out', fill: 'forwards' } },
    { target: 'incoming', keyframes: [{ left: `${shift}px` }, { left: '0px' }], options: motion },
    { target: 'incoming', keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 180, delay: 50, easing: 'ease-out', fill: 'backwards' } },
  ]
}
