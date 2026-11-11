import { cloudLobes } from './shapes'
import type { Pose } from './morph'

type Circle = { x: number; y: number; radius: number }
export type LoadingFrame = { circles: Circle[]; sparkle: Pose; separation: number }

const baseAngle = -145 * Math.PI / 180
const orbitRadius = 25
const trailingAngles = [42, 72, 98, 121].map((angle) => angle * Math.PI / 180)
const radii = [4.6, 3.8, 2.9, 2.3]
const smoothstep = (value: number) => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

/**
 * One physical rotor drives the whole loop. Followers have their own angular
 * inertia, and the sparkle's axial spin has independent angular momentum.
 */
export class LoadingMotion {
  private phase: 'depart' | 'spin' | 'gather' | 'rest' = 'depart'
  private age = 0
  private cycleAge = 0
  private angle = baseAngle
  private velocity = 0
  private spinStart = baseAngle
  private axialAngle = 0
  private axialVelocity = 0
  private followers = trailingAngles.map((offset) => ({ angle: baseAngle - offset, velocity: 0 }))

  reset(rotation = 0) {
    this.phase = 'depart'
    this.age = this.cycleAge = this.velocity = this.axialVelocity = 0
    this.angle = this.spinStart = baseAngle
    this.axialAngle = rotation * Math.PI / 180
    this.followers = trailingAngles.map((offset) => ({ angle: baseAngle - offset, velocity: 0 }))
  }

  step(dt: number): LoadingFrame {
    const steps = Math.max(1, Math.ceil(dt * 240))
    const step = dt / steps
    for (let index = 0; index < steps; index++) {
      this.age += step
      this.cycleAge += step
      const separation = this.separation()
      const cruise = 4.9
      const drive = this.phase === 'depart'
        ? cruise * smoothstep((this.age - 0.35) / 1.15)
        : this.phase === 'spin' ? cruise
          : this.phase === 'gather' ? cruise * (1 - smoothstep(this.age / 1.25)) : 0

      // A motor supplies energy; gravity speeds up the descending part and
      // slows the ascent. Drag and existing velocity make both feel connected.
      const gravity = 5 * Math.cos(this.angle) * separation * smoothstep(this.velocity / 3)
      this.velocity = Math.max(0, this.velocity + (2.4 * (drive - this.velocity) + gravity) * step)
      this.angle += this.velocity * step
      this.axialVelocity += (separation * 3.8 - this.axialVelocity) * (1 - Math.exp(-step * 3))
      this.axialAngle += this.axialVelocity * step

      this.followers.forEach((follower, followerIndex) => {
        const target = this.angle - trailingAngles[followerIndex]
        const stiffness = 70 - followerIndex * 8
        const drag = 11 - followerIndex * 0.9
        follower.velocity += (stiffness * (target - follower.angle) + drag * (this.velocity - follower.velocity)) * step
        follower.angle += follower.velocity * step
      })

      if (this.phase === 'depart' && this.age >= 2.25) {
        this.phase = 'spin'
        this.age = 0
        this.spinStart = this.angle
      } else if (this.phase === 'spin' && this.angle - this.spinStart >= Math.PI * 5) {
        this.phase = 'gather'
        this.age = 0
      } else if (this.phase === 'gather' && this.age >= 1.25) {
        this.phase = 'rest'
        this.age = 0
      } else if (this.phase === 'rest' && this.age >= 0.45) {
        // The orbital coordinates are hidden inside the assembled cloud here.
        // Reset that hidden coordinate frame, preserving the axial spin.
        const rotation = this.axialAngle * 180 / Math.PI
        this.reset(rotation)
      }
    }
    return this.frame()
  }

  private separation() {
    if (this.phase === 'gather') return 1 - smoothstep(this.age / 1.25)
    if (this.phase === 'rest') return 0
    return smoothstep((this.cycleAge - 0.1) / 1.05)
  }

  private frame(): LoadingFrame {
    const separation = this.separation()
    const circles = cloudLobes.map((lobe, index) => {
      const depart = smoothstep((this.cycleAge - 0.45 - index * 0.22) / 1.05)
      const delay = (cloudLobes.length - 1 - index) * 0.06
      const returnAmount = this.phase === 'gather'
        ? 1 - smoothstep((this.age - delay) / (1.25 - delay))
        : this.phase === 'rest' ? 0 : 1
      const amount = depart * returnAmount
      const remaining = 1 - amount
      const orbitX = 32 + Math.cos(this.followers[index].angle) * orbitRadius
      const orbitY = 28 + Math.sin(this.followers[index].angle) * orbitRadius
      return {
        x: remaining ** 2 * lobe.x + 2 * remaining * amount * 12 + amount ** 2 * orbitX,
        y: remaining ** 2 * lobe.y + 2 * remaining * amount * -9 + amount ** 2 * orbitY,
        radius: lobe.radius + (radii[index] - lobe.radius) * amount,
      }
    })
    const remaining = 1 - separation
    return {
      circles,
      separation,
      sparkle: {
        x: remaining ** 2 * 43.5 + 2 * remaining * separation * 15 + separation ** 2 * (32 + Math.cos(this.angle) * orbitRadius),
        y: remaining ** 2 * 32.7 + 2 * remaining * separation * 12 + separation ** 2 * (28 + Math.sin(this.angle) * orbitRadius),
        rotation: this.axialAngle * 180 / Math.PI,
        scale: 1 - separation * 0.22,
      },
    }
  }

  static still(): LoadingFrame {
    return {
      separation: 1,
      circles: cloudLobes.map((_, index) => ({
        x: 32 + Math.cos(baseAngle - trailingAngles[index]) * orbitRadius,
        y: 28 + Math.sin(baseAngle - trailingAngles[index]) * orbitRadius,
        radius: radii[index],
      })),
      sparkle: { x: 32 + Math.cos(baseAngle) * orbitRadius, y: 28 + Math.sin(baseAngle) * orbitRadius, rotation: 0, scale: 0.78 },
    }
  }
}
