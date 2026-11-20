import { readMotionLevel } from './motion'

/**
 * A spring released from rest that overshoots its end by `overshoot` (as a fraction of the travel)
 * once, at `peak` (as a fraction of the time), then settles: progress over time, both from 0 to 1.
 * The peak is at the same point whatever the overshoot, so a deeper one reads as a bigger bounce
 * rather than a stiffer, quicker one.
 */
export const springCurve = (overshoot: number, peak: number) => {
  const logOvershoot = Math.log(Math.min(Math.max(overshoot, 0.002), 0.2))
  const damping = -logOvershoot / Math.sqrt(Math.PI ** 2 + logOvershoot ** 2)
  const damped = Math.PI / peak
  const frequency = damped / Math.sqrt(1 - damping ** 2)
  return (t: number) => {
    if (t >= 1) return 1
    const envelope = Math.exp(-damping * frequency * t)
    return 1 - envelope * (Math.cos(damped * t) + (damping / Math.sqrt(1 - damping ** 2)) * Math.sin(damped * t))
  }
}

/**
 * `springCurve`, as the motion level in force has it, read each time it is sampled: overshooting
 * as asked at `full`, and settling without overshoot otherwise.
 */
export const motionCurve = (overshoot: number, peak: number) => {
  const bouncy = springCurve(overshoot, peak)
  const settled = springCurve(0, peak)
  return (t: number) => (readMotionLevel() === 'full' ? bouncy : settled)(t)
}
