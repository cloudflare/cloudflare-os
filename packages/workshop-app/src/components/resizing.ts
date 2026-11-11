import { animate, type MotionValue } from 'motion/react'

/** `size`, kept within its limits. */
export const clampSize = (size: number, min: number, max: number) => Math.min(max, Math.max(min, size))

// How far something follows a pull of `distance` past its limit: a little of it, and ever less of
// what is added, so the limit is felt rather than hit.
const give = (distance: number) => distance * 0.06 + 12 * Math.log1p(distance / 24)

/** `size` as it is shown while it is being dragged: free within its limits, reluctant past them. */
export const resistSize = (size: number, min: number, max: number) => {
  if (size < min) return min - give(min - size)
  if (size > max) return max + give(size - max)
  return size
}

/** Brings a size to rest at `to`, the way one let go of past its limit springs back. */
export const settleSize = (size: MotionValue<number>, to: number, instantly = false) => {
  if (instantly) size.jump(to)
  else animate(size, to, { type: 'spring', duration: 0.25, bounce: 0 })
}
