import { circlePath } from './circlePath'
import { LoadingMotion } from './loadingMotion'
import { alignPoints, inverseTransformPoints, orderHalves, roundedPointsToPath, samplePath, splitOutline, transformPoints, type Point, type Pose } from './morph'
import { cloudLobes, happyEye, sadCores, sadFace, sparkle } from './shapes'

export type MascotEmotion = 'idle' | 'thinking' | 'happy' | 'sad' | 'error' | 'loading'
type FaceEmotion = 'sad' | 'happy'

export type MascotMotion = {
  /** Grow in, or shrink away. It starts out not shown. */
  setShown: (shown: boolean) => void
  setEmotion: (emotion: MascotEmotion) => void
  /** Start squeezing it. Sad, it rains for as long as it is held; otherwise nothing happens. */
  press: () => void
  release: () => void
  /** A tap: the sparkle spins, or a happy mascot cheers again. A sad one only answers to `press`. */
  tap: () => void
  stop: () => void
}

/** How many raindrops can be falling at once; the component draws this many. */
export const RAINDROPS = 15

// The body's travel was tuned in pixels on a mascot 220px wide. As a share of its own size it
// moves the same at any size.
const TRAVEL_X = 100 / 220
const TRAVEL_Y = 100 / (220 * 64 / 73)

// Coming and going. The body's four blobs grow one shortly after another, each about the middle
// of the cloud rather than its own, so however far apart they are in size they overlap as they do
// at rest and the shape never comes apart. The sparkle follows once the last blob is nearly there.
// Leaving is the same seen backwards, at the same pace: the sparkle goes first, then the blobs
// in turn, last in first out.
const MIDDLE = { x: 32, y: 28 }
const GROW = 0.34
const STAGGER = 0.07
/** Each lobe's turn: from the lower left round to the lobe that holds the sparkle. */
const TURN = [2, 3, 0, 1]
const SPARKLE_AT = 3 * STAGGER + 0.12
const ARRIVED = SPARKLE_AT + GROW
/** From nothing to full size, a little past it on the way. */
const pop = (value: number) => {
  if (value <= 0) return 0
  const left = Math.min(1, value) - 1
  return 1 + 2.7 * left ** 3 + 1.7 * left ** 2
}

const happyEntrySpeed = 1.25
const smoothstep = (value: number) => {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped * clamped * (3 - 2 * clamped)
}

const springResponse = (t: number) => 1 - Math.exp(-5.5 * t) * (Math.cos(7 * t) + 5.5 / 7 * Math.sin(7 * t))
const springEase = (value: number) => springResponse(Math.max(0, Math.min(1, value))) / springResponse(1)

// The outlines the sparkle morphs through on its way to a face and back. Only the happy and sad
// emotions need them, and they are the same for every mascot, so they are sampled once, when the
// first face is asked for.
let sampled: ReturnType<typeof sampleOutlines> | undefined
const outlines = () => (sampled ??= sampleOutlines())
const sampleOutlines = () => {
  const sampledSparkle = samplePath(sparkle, 256)
  const sparkHalves = [splitOutline(sampledSparkle, true), splitOutline(sampledSparkle, false)]
  const sadHalves = sadFace.split(/(?=M)/).map((path) => samplePath(path))
  const happyHalves = [23, 42].map((x) => samplePath(happyEye).map((point) => ({ x: point.x + x, y: point.y + 24.5 })))
  const faceHalves = { sad: sadHalves, happy: happyHalves }
  const coreHalves = sadCores.map((path) => samplePath(path))
  return { sparkHalves, happyHalves, faceHalves, coreHalves }
}

/**
 * Animates the mascot drawn inside `frame` until stopped. It starts idle and not shown, and has
 * drawn that by the time this returns. Every frame is written straight to the SVG, so nothing
 * here renders React.
 *
 * The drawing is found by its `data-part` attributes: the `figure` that moves as a whole, the
 * `lobe` paths of the body (the clip's four, then the visible four), the two `sparkle` groups and
 * two `face` groups (outside the body, then inside it), each face's left and right `eye`, and the
 * `drop` paths of the rain.
 */
export const startMascotMotion = (frame: HTMLElement): MascotMotion => {
  const parts = <T extends Element>(name: string) => [...frame.querySelectorAll<T>(`[data-part="${name}"]`)]
  const figure = parts<HTMLElement>('figure')[0]
  const lobePaths = parts<SVGPathElement>('lobe')
  const sparkles = parts<SVGGElement>('sparkle')
  const faces = parts<SVGGElement>('face')
  const eyes = parts<SVGPathElement>('eye')
  const drops = parts<SVGPathElement>('drop')

  let shown = false
  // The clock of coming and going: 0 is gone, `ARRIVED` is all there.
  let presence = 0
  let onScreen = true
  let emotion: MascotEmotion = 'idle'
  let held = false
  let poke = 0
  let squeezeClicks = 0
  let rainRequests = 0
  let minimumRain = 0
  let happyReplay = false
  const spin = { rotation: 0, from: 0, target: 0, elapsed: 1, duration: 0.85 }

  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  let reduced = media.matches
  const onMotionChange = () => { reduced = media.matches }
  media.addEventListener('change', onMotionChange)
  const pointer = { x: 0, y: 0, localX: 32, localY: 28, influence: 0, active: false }
  const lobes = [
    { x: 37.8, y: 19.8, pull: 5.8, speed: 15, dx: 0, dy: 0, wanderX: 0, wanderY: 0, swell: 0 },
    { x: 44.4, y: 33.1, pull: 4.5, speed: 11, dx: 0, dy: 0, wanderX: 0, wanderY: 0, swell: 0 },
    { x: 26.5, y: 35.9, pull: 6.2, speed: 13, dx: 0, dy: 0, wanderX: 0, wanderY: 0, swell: 0 },
    { x: 18.4, y: 24.1, pull: 5.1, speed: 17, dx: 0, dy: 0, wanderX: 0, wanderY: 0, swell: 0 },
  ]
  // How much it billows: fully while idle or thinking, not at all otherwise. Thinking, it does so
  // faster and further, so the clock it runs on has a pace of its own.
  let billow = 0
  let billowTime = 0
  let billowVigour = 1
  const follow = { x: 0, y: 0 }
  const weight = { x: 0, y: 0 }
  const star = { x: 43.5, y: 32.7, rotation: 0, scale: 1 }
  const liquid = { x: 0, y: 0, vx: 0, vy: 0 }
  const shakenBody = { x: 0, velocity: 0 }
  const loading = new LoadingMotion()
  const loadingMix = { amount: 0, velocity: 0 }
  const happyMotion = {
    breath: { amount: 0, velocity: 0 },
    shake: { amount: 0, velocity: 0 },
    dance: { amount: 0, velocity: 0 },
  }
  let happyBreathFrom = 0
  let loadingFrame = loading.step(0)
  let displayRotation = 0
  const squeeze: { amount: number; velocity: number; phase: 'rest' | 'press' | 'hold' | 'recover'; heldFor: number; pressElapsed: number; pressFrom: number } = { amount: 0, velocity: 0, phase: 'rest', heldFor: 0, pressElapsed: 0, pressFrom: 0 }
  const raindrops = Array.from({ length: RAINDROPS }, () => ({ active: false, birthPending: false, elapsed: 0, duration: 1, x: 0, y: 0, drift: 0, radius: 0, distance: 0 }))
  let nextRaindrop = 0
  const rainBands = [0, 3, 1, 4, 2]
  let nextRainBand = Math.floor(Math.random() * rainBands.length)
  let heldRainTimer = 0.08
  let lastPose: Pose = { x: star.x, y: star.y, rotation: 0, scale: 1 }
  let splitActive = false
  let splitShapes: Point[][] | null = null
  let splitTransition: { from: Point[][]; core: Point[][]; to: Point[][]; elapsed: number; intoFace: boolean; faceEmotion: FaceEmotion } | null = null
  let sadness = 0
  let lift = 0
  let lateral = 0
  let joy = 0
  let rotation = 0
  let last = 0
  let time = 0
  let moodTime = 0
  let previousMood: MascotEmotion = emotion
  let thinkingAngle = 0
  let errorTime = 0
  let errorBurst = -1
  let errorAngle = -12
  let errorVelocity = 0
  let errorSpinDirection = 1
  let errorPeakVelocity = 2400
  let request = 0

  // Only where the pointer went is recorded here. It is measured against the mascot in the next
  // frame, so pointer moves anywhere on the page never force a layout of their own.
  let moved: { x: number; y: number } | undefined
  const onPointer = (event: PointerEvent) => { moved = { x: event.clientX, y: event.clientY } }
  const locatePointer = ({ x, y }: { x: number; y: number }) => {
    const bounds = frame.getBoundingClientRect()
    if (bounds.width === 0) return
    pointer.localX = (x - bounds.left) / bounds.width * 73 - 4
    pointer.localY = (y - bounds.top) / bounds.height * 64 - 4
    pointer.x = Math.max(-1, Math.min(1, (x - bounds.left - bounds.width / 2) / (bounds.width / 2)))
    pointer.y = Math.max(-1, Math.min(1, (y - bounds.top - bounds.height / 2) / (bounds.height / 2)))
    // Full attraction inside the container; smoothly fade with distance
    // from its nearest edge, scaled to the mascot rather than the viewport.
    const outsideX = Math.max(bounds.left - x, 0, x - bounds.right)
    const outsideY = Math.max(bounds.top - y, 0, y - bounds.bottom)
    const distance = Math.hypot(outsideX, outsideY)
    const falloff = Math.max(bounds.width, bounds.height) * 0.85
    pointer.influence = 1 - smoothstep(distance / falloff)
    pointer.active = true
  }
  const resetPointer = () => { moved = undefined; pointer.x = 0; pointer.y = 0; pointer.influence = 0; pointer.active = false }
  const onWindowBlur = () => { resetPointer(); held = false }
  window.addEventListener('pointermove', onPointer, { passive: true })
  document.addEventListener('pointerleave', resetPointer)
  window.addEventListener('blur', onWindowBlur)

  const animate = (now: number) => {
    const dt = Math.min((now - (last || now)) / 1000, 0.05)
    last = now
    if (moved) {
      locatePointer(moved)
      moved = undefined
    }
    presence = reduced
      ? shown ? ARRIVED : 0
      : Math.max(0, Math.min(ARRIVED, presence + (shown ? dt : -dt)))
    const sparkleSize = pop((presence - SPARKLE_AT) / GROW)
    if (!reduced) time += dt
    const t = time
    const ease = 1 - Math.exp(-dt * 5)
    const holdingSad = held && emotion === 'sad'
    if (emotion !== 'sad') minimumRain = 0
    if (holdingSad || minimumRain > 0) {
      heldRainTimer -= dt
      if (heldRainTimer <= 0) {
        rainRequests++
        minimumRain = Math.max(0, minimumRain - 1)
        heldRainTimer += 0.075 + Math.random() * 0.02
      }
    } else {
      heldRainTimer = 0.08
      held = false
    }
    if (squeezeClicks > 0) {
      if (!reduced) {
        squeeze.velocity = Math.max(0, squeeze.velocity)
        squeeze.pressFrom = squeeze.amount
        squeeze.pressElapsed = 0
        squeeze.phase = 'press'
        squeeze.heldFor = 0
      }
      squeezeClicks = 0
    }
    const squeezeSteps = Math.max(1, Math.ceil(dt * 240))
    const squeezeStep = dt / squeezeSteps
    for (let i = 0; i < squeezeSteps; i++) {
      if (squeeze.phase === 'press') {
        squeeze.pressElapsed += squeezeStep
        // Ramp pressure in, then let increasing resistance ease the motion
        // all the way into its compressed target instead of stopping a pulse.
        const target = squeeze.pressFrom + (0.095 - squeeze.pressFrom) * smoothstep(squeeze.pressElapsed / 0.14)
        const resistance = 45 + 25 * (Math.max(0, squeeze.amount) / 0.095) ** 4
        squeeze.velocity += (500 * (target - squeeze.amount) - resistance * squeeze.velocity) * squeezeStep
        squeeze.amount += squeeze.velocity * squeezeStep
        if (squeeze.pressElapsed >= 0.14 && Math.abs(0.095 - squeeze.amount) < 0.0005 && Math.abs(squeeze.velocity) < 0.006) {
          squeeze.velocity = 0
          squeeze.phase = 'hold'
        }
      } else if (squeeze.phase === 'hold') {
        squeeze.heldFor += squeezeStep
        if (!holdingSad && squeeze.heldFor >= 0.16) squeeze.phase = 'recover'
      } else if (squeeze.phase === 'recover') {
        // A softer, heavily damped recovery lets the sponge refill gradually.
        squeeze.velocity += (-32 * squeeze.amount - 12 * squeeze.velocity) * squeezeStep
        squeeze.amount += squeeze.velocity * squeezeStep
        if (squeeze.amount < 0.0002 && Math.abs(squeeze.velocity) < 0.002) {
          squeeze.amount = squeeze.velocity = 0
          squeeze.phase = 'rest'
        }
      }
    }
    while (rainRequests > 0) {
      rainRequests--
      const drop = raindrops[nextRaindrop]
      nextRaindrop = (nextRaindrop + 1) % raindrops.length
      // Alternate spatial bands so the continuous stream stays well spread.
      const band = rainBands[nextRainBand]
      nextRainBand = (nextRainBand + 1) % rainBands.length
      const x = 7 + (band + 0.2 + Math.random() * 0.6) * 10
      const bottom = Math.max(
        35.91 + Math.sqrt(Math.max(0, 19.85 ** 2 - (x - 26.46) ** 2)),
        33.08 + Math.sqrt(Math.max(0, 19.85 ** 2 - (x - 44.42) ** 2)),
      )
      Object.assign(drop, {
        active: true,
        birthPending: true,
        elapsed: 0,
        duration: 0.5 + Math.random() * 0.1,
        x,
        y: bottom,
        drift: (Math.random() - 0.5) * 5,
        radius: 1.7 + Math.random() * 1.1,
        distance: 20 + Math.random() * 9,
      })
    }
    spin.elapsed = Math.min(spin.duration, spin.elapsed + dt)
    spin.rotation = reduced
      ? spin.target
      : spin.from + (spin.target - spin.from) * smoothstep(spin.elapsed / spin.duration)
    const mood = emotion
    if (mood !== previousMood) {
      if (mood === 'loading' && loadingMix.amount < 0.001) loading.reset(lastPose.rotation - spin.rotation)
      if (previousMood === 'loading') star.rotation = lastPose.rotation - spin.rotation
      const faceEmotion = mood === 'sad' || mood === 'happy' ? mood : null
      if (faceEmotion || previousMood === 'sad' || previousMood === 'happy') {
        const from = splitShapes ?? orderHalves(outlines().sparkHalves.map((half) => transformPoints(half, lastPose)))
        const intoFace = faceEmotion !== null
        const core = (faceEmotion === 'happy' ? outlines().happyHalves : outlines().coreHalves).map((half, index) => alignPoints(from[index], half))
        const to = faceEmotion
          ? outlines().faceHalves[faceEmotion].map((half, index) => alignPoints(core[index], half))
          : orderHalves(outlines().sparkHalves.map((half) => transformPoints(half, lastPose))).map((half, index) => inverseTransformPoints(alignPoints(from[index], half), lastPose))
        splitTransition = { from, core, to, elapsed: 0, intoFace, faceEmotion: faceEmotion ?? (previousMood === 'happy' ? 'happy' : 'sad') }
        splitActive = true
      }
      moodTime = 0
      if (mood === 'happy') happyBreathFrom = happyMotion.breath.amount
      thinkingAngle = star.rotation
      errorTime = 0
      errorBurst = -1
      errorAngle = star.rotation
      errorVelocity = 0
      liquid.x = liquid.y = liquid.vx = liquid.vy = 0
      shakenBody.x = shakenBody.velocity = 0
      previousMood = mood
    }
    if (happyReplay) {
      if (mood === 'happy') {
        // Re-attack from the current inhale without resetting spring velocity.
        happyBreathFrom = happyMotion.breath.amount
        moodTime = 0
      }
      happyReplay = false
    }
    if (!reduced) moodTime += dt
    const happyTime = moodTime * happyEntrySpeed
    // A continuous breath arc releases straight into the overlapping dance.
    const happyActive = mood === 'happy' && !reduced
    const breathArc = Math.sin(Math.PI * smoothstep(happyTime / 1.85))
    const happyTargets = {
      breath: happyActive ? breathArc + (1 - breathArc) * happyBreathFrom * (1 - smoothstep(happyTime / 0.925)) : 0,
      shake: happyActive ? smoothstep((happyTime - 0.45) / 0.15) * (1 - smoothstep((happyTime - 1) / 0.35)) : 0,
      dance: happyActive ? smoothstep(happyTime - 0.65) : 0,
    }
    const happySteps = Math.max(1, Math.ceil(dt * 240))
    const happyStep = dt / happySteps
    for (const key of ['breath', 'shake', 'dance'] as const) {
      const motion = happyMotion[key]
      if (reduced) {
        motion.amount = motion.velocity = 0
        continue
      }
      for (let index = 0; index < happySteps; index++) {
        motion.velocity += (240 * (happyTargets[key] - motion.amount) - 32 * motion.velocity) * happyStep
        motion.amount += motion.velocity * happyStep
      }
    }
    const happyBreath = happyMotion.breath.amount
    // Keep oscillation phases running through clicks; only retarget their strength.
    const happyFaceShake = happyBreath * happyMotion.shake.amount * Math.sin(t * 25 * happyEntrySpeed) * 1.1
    if (reduced) {
      loadingMix.amount = mood === 'loading' ? 1 : 0
      loadingMix.velocity = 0
      loadingFrame = LoadingMotion.still()
    } else {
      const steps = Math.max(1, Math.ceil(dt * 240))
      const step = dt / steps
      for (let index = 0; index < steps; index++) {
        loadingMix.velocity += (110 * ((mood === 'loading' ? 1 : 0) - loadingMix.amount) - 21 * loadingMix.velocity) * step
        loadingMix.amount = Math.max(0, Math.min(1, loadingMix.amount + loadingMix.velocity * step))
      }
      if (mood === 'loading' || loadingMix.amount > 0.0001) loadingFrame = loading.step(dt)
    }
    const load = loadingMix.amount
    const rotationReady = moodTime >= 0.3 && splitTransition === null && load < 0.025 && mood !== 'loading'
    const pointerEase = 1 - Math.exp(-dt * 16)
    const bodyResponse = mood === 'thinking' ? 0.6 : 1
    follow.x += ((reduced ? 0 : pointer.x * pointer.influence) - follow.x) * pointerEase
    follow.y += ((reduced ? 0 : pointer.y * pointer.influence) - follow.y) * pointerEase
    for (const lobe of lobes) {
      const dx = pointer.localX - lobe.x
      const dy = pointer.localY - lobe.y
      const distance = Math.hypot(dx, dy)
      const pull = pointer.active && !reduced ? lobe.pull * pointer.influence * bodyResponse / Math.max(24, distance) : 0
      const response = 1 - Math.exp(-dt * lobe.speed)
      lobe.dx += (dx * pull - lobe.dx) * response
      lobe.dy += (dy * pull - lobe.dy) * response
    }
    // Idle or thinking, the body stays where it is and billows: each blob, still the circle it
    // is, wanders a little about its own place and swells and settles as it goes, on slow paths
    // of its own that never line up. What the four have in common is taken out, so that together
    // they go nowhere.
    const billows = mood === 'idle' || mood === 'thinking'
    billow = reduced ? 0 : billow + ((billows ? 1 : 0) - billow) * ease
    billowVigour += ((mood === 'thinking' ? 1.5 : 1) - billowVigour) * ease
    if (!reduced) billowTime += dt * billowVigour
    lobes.forEach((lobe, index) => {
      const pace = billowTime * (1 + index * 0.17)
      const phase = index * 2.4
      lobe.wanderX = Math.sin(pace * 0.62 + phase) * 1.5 + Math.sin(pace * 0.37 + phase * 1.7) * 1.1
      lobe.wanderY = Math.cos(pace * 0.55 + phase * 1.3) * 1.5 + Math.sin(pace * 0.31 + phase * 2.1) * 1.1
      lobe.swell = billow * Math.sin(pace * 0.48 + phase * 0.9) * 0.05
    })
    const commonX = lobes.reduce((sum, lobe) => sum + lobe.wanderX, 0) / lobes.length
    const commonY = lobes.reduce((sum, lobe) => sum + lobe.wanderY, 0) / lobes.length
    for (const lobe of lobes) {
      lobe.wanderX = (lobe.wanderX - commonX) * billow * billowVigour
      lobe.wanderY = (lobe.wanderY - commonY) * billow * billowVigour
    }
    sadness += ((mood === 'sad' ? 1 : 0) - sadness) * ease
    poke *= Math.exp(-dt * 3)
    const boop = reduced ? 0 : Math.sin(poke * 10) * poke

    let x = 42 + Math.sin(t * 0.85) * 3
    let y = 31 + Math.cos(t * 1.1) * 3
    let angle = Math.sin(t * 0.8) * 18
    let scale = 1 + Math.sin(t * 1.4) * 0.055
    let bounce = 0
    let sway = 0
    let tilt = 0
    let morph = 0.55
    let errorShake = 0

    if (mood === 'thinking') {
      x = 33 + Math.sin(t * 2.2) * 9
      y = 26 + Math.cos(t * 2.8) * 6
      if (rotationReady && !reduced) thinkingAngle += dt * 115
      angle = thinkingAngle + Math.sin(moodTime * 2) * 20
      scale = 1.07 + Math.sin(t * 3.5) * 0.14
    } else if (mood === 'happy') {
      const hop = Math.sin(t * 2.3) * happyMotion.dance.amount
      x = 32
      y = 28
      sway = hop * 7
      bounce = -5 - hop * hop * 6 - happyBreath * 14
      tilt = hop * 3
      morph = 0.5
    } else if (mood === 'sad') {
      bounce = 9 + Math.sin(t * 0.8) * 2
      tilt = -5 + Math.sin(t * 0.6)
      morph = 0.35
    } else if (mood === 'error') {
      if (rotationReady && !reduced) errorTime += dt
      const phase = errorTime % 2.6
      const burst = Math.floor(errorTime / 2.6)
      if (burst !== errorBurst) {
        errorBurst = burst
        errorSpinDirection = Math.random() < 0.5 ? -1 : 1
        errorPeakVelocity = 2200 + Math.random() * 400
      }
      // A quick impulse spins it up; friction then dissipates its momentum.
      // Integrating velocity lets it coast for multiple turns without a stop.
      const previousVelocity = errorVelocity
      if (reduced || !rotationReady) {
        errorVelocity = 0
      } else if (phase < 0.24) {
        errorVelocity += (errorSpinDirection * errorPeakVelocity - errorVelocity) * (1 - Math.exp(-dt * 22))
      } else {
        errorVelocity *= Math.exp(-dt * (3.2 + Math.abs(liquid.vx) * 0.005))
      }
      if (!reduced) errorAngle += (previousVelocity + errorVelocity) * 0.5 * dt
      const shaking = smoothstep(phase / 0.12) * (1 - smoothstep((phase - 0.75) / 0.45))
      const disagreement = Math.sin(errorTime * 38) * shaking
      errorShake = reduced ? 0 : disagreement * 0.85
      x = 32
      y = 28 + Math.sin(t * 0.9) * 0.35
      angle = errorAngle
      scale = 0.92
      bounce = Math.sin(t * 1.3) * 2
      tilt = 0
      morph = 0.55
    }

    if (reduced) {
      sway = 0
      bounce = mood === 'sad' ? 9 : 0
      tilt = mood === 'sad' ? -5 : 0
      angle = mood === 'error' ? -12 : 0
      morph = 0
    }
    const horizontalEase = mood === 'error' ? 1 - Math.exp(-dt * 65) : ease
    star.x += (x - star.x) * horizontalEase
    star.y += (y - star.y) * ease
    const rotationEase = mood === 'error' ? 1 : ease
    if (mood === 'idle' || mood === 'sad' || mood === 'happy' || reduced) {
      angle = star.rotation + ((angle - star.rotation + 180) % 360 + 360) % 360 - 180
    }
    if (rotationReady) star.rotation += (angle - star.rotation) * rotationEase
    star.scale += (scale + boop * 0.12 - star.scale) * ease
    const previousBodyVelocity = shakenBody.velocity
    // Shaking drives one underdamped spring. When the driving force fades,
    // its existing position and velocity carry naturally into the settling.
    const bodySteps = Math.max(1, Math.ceil(dt * 240))
    const bodyStep = dt / bodySteps
    for (let i = 0; i < bodySteps; i++) {
      const acceleration = errorShake * 380 - 1444 * shakenBody.x - 10 * shakenBody.velocity
      shakenBody.velocity += acceleration * bodyStep
      shakenBody.x += shakenBody.velocity * bodyStep
    }
    const bodyAcceleration = dt > 0 ? (shakenBody.velocity - previousBodyVelocity) / dt : 0
    const errorWeight = shakenBody.x
    const weightEase = 1 - Math.exp(-dt * (mood === 'error' ? 45 : 14))
    weight.x += (follow.x * 0.55 * bodyResponse - weight.x) * weightEase
    weight.y += (follow.y * 0.5 * bodyResponse - weight.y) * weightEase
    const massWeightX = weight.x + errorWeight
    lift += (bounce - boop * 16 - lift) * ease
    lateral += (sway - lateral) * ease
    joy = reduced ? 0 : joy + (happyBreath - joy) * (1 - Math.exp(-dt * 12))
    rotation += (tilt + massWeightX * 4 - rotation) * (1 - Math.exp(-dt * 12))

    if (mood === 'error' && !reduced) {
      // In the body's frame, acceleration pushes the floating sparkle in
      // the opposite direction. Buoyancy and liquid drag then settle it.
      const steps = Math.max(1, Math.ceil(dt * 240))
      const step = dt / steps
      for (let i = 0; i < steps; i++) {
        const ax = -180 * liquid.x - 2.4 * liquid.vx - bodyAcceleration * 2.6 * 3.1
        const ay = -30 * liquid.y - 8 * liquid.vy - Math.abs(liquid.vx) * 0.18
        liquid.vx += ax * step
        liquid.vy += ay * step
        liquid.x += liquid.vx * step
        liquid.y += liquid.vy * step
      }
    }

    // One deformation field carries the silhouette and its contents together.
    const deformationAt = (px: number, py: number) => {
      const waveX = Math.sin(py * 0.09 + t * 1.1) * morph + (px - 32) * boop * 0.012
      const waveY = Math.cos(px * 0.085 + t * 1.25) * morph - (py - 28) * boop * 0.014
      // The lower body stays anchored while its upper mass leans. The
      // leading side swells and the trailing side tucks inward slightly.
      const nx = (px - 32) / 32
      const ny = (py - 28) / 28
      const massX = reduced ? 0 : massWeightX * (1.2 + (1 - py / 56) * 2.8) + nx * weight.y * 0.7
      const massY = reduced ? 0 : weight.y * (1.2 + (1 - Math.abs(nx)) * 1.4) - ny * massWeightX * nx * 1.1
      const compression = reduced ? 0 : squeeze.amount
      const squeezeX = -(px - 32) * compression
      const squeezeY = -(py - 55) * compression * 0.65
      let localX = 0
      let localY = 0
      let totalInfluence = 0
      for (const lobe of lobes) {
        const influence = Math.exp(-((px - lobe.x) ** 2 + (py - lobe.y) ** 2) / 110)
        // Use the same attraction as a pointer above the cloud: lift the
        // lobes together instead of enlarging the silhouette.
        const joyDX = 32.5 - lobe.x
        const joyDY = -10 - lobe.y
        const joyPull = joy * lobe.pull * 0.6 / Math.max(24, Math.hypot(joyDX, joyDY))
        const shiver = happyFaceShake * (1 - lobe.y / 56) * 0.3
        localX += influence * (lobe.dx + joyDX * joyPull + shiver)
        localY += influence * (lobe.dy + joyDY * joyPull)
        totalInfluence += influence
      }
      return { x: waveX + massX + localX / totalInfluence + squeezeX, y: waveY + massY + localY / totalInfluence + squeezeY }
    }

    raindrops.forEach((drop, index) => {
      if (!drop.active) return
      drop.elapsed += dt
      if (drop.birthPending && drop.elapsed >= 0) {
        const displacement = deformationAt(drop.x, drop.y)
        drop.x += displacement.x
        drop.y += displacement.y - drop.radius * 1.5 - 0.6
        drop.birthPending = false
      }
      const progress = Math.max(0, Math.min(1, drop.elapsed / drop.duration))
      const radius = drop.elapsed < 0 ? 0 : drop.radius * smoothstep(progress / 0.035) * (1 - smoothstep((progress - 0.3) / 0.7))
      const dropX = drop.x + (reduced ? 0 : drop.drift * progress + Math.sin(progress * Math.PI) * 0.5)
      const dropY = reduced ? drop.y : drop.y + drop.distance * (0.75 * progress + 0.25 * progress ** 2)
      drops[index].setAttribute('transform', `translate(${dropX} ${dropY}) rotate(${reduced ? 0 : drop.drift * 3}) scale(${radius})`)
      if (progress === 1) drop.active = false
    })

    // The same four lobes render every state. Interpolating their geometry
    // lets any point of the loading loop gather into any other emotion.
    cloudLobes.forEach((lobe, index) => {
      const target = loadingFrame.circles[index]
      const size = pop((presence - TURN[index] * STAGGER) / GROW)
      // Its billowing moves and sizes the blob as a whole, on top of the field every blob shares,
      // so it stays the circle it is.
      const { wanderX, wanderY, swell } = lobes[index]
      const path = circlePath(lobe.x, lobe.y, lobe.radius, (point) => {
        const displacement = deformationAt(point.x, point.y)
        const normalX = point.x + displacement.x + wanderX + (point.x - lobe.x) * swell
        const normalY = point.y + displacement.y + wanderY + (point.y - lobe.y) * swell
        const loadingX = target.x + (point.x - lobe.x) / lobe.radius * target.radius
        const loadingY = target.y + (point.y - lobe.y) / lobe.radius * target.radius
        const fullX = normalX + (loadingX - normalX) * load
        const fullY = normalY + (loadingY - normalY) * load
        return { x: MIDDLE.x + (fullX - MIDDLE.x) * size, y: MIDDLE.y + (fullY - MIDDLE.y) * size }
      })
      lobePaths[index].setAttribute('d', path)
      lobePaths[index + cloudLobes.length].setAttribute('d', path)
    })
    figure.style.transform = `translate(${lateral * (1 - load) * TRAVEL_X}%, ${lift * (1 - load) * TRAVEL_Y}%) rotate(${rotation * (1 - load)}deg)`
    const starDisplacement = deformationAt(star.x, star.y)
    const sloshX = mood === 'error' && !reduced ? liquid.x : 0
    const sloshY = mood === 'error' && !reduced ? liquid.y : 0
    const normalPose: Pose = { x: star.x + starDisplacement.x + sloshX, y: star.y + starDisplacement.y + sloshY, rotation: star.rotation + spin.rotation, scale: star.scale }
    const targetPose = loadingFrame.sparkle
    const targetRotation = normalPose.rotation + (targetPose.rotation + spin.rotation - normalPose.rotation) * load
    if (load > 0.001) {
      const difference = ((targetRotation - displayRotation + 180) % 360 + 360) % 360 - 180
      displayRotation += difference * (1 - Math.exp(-dt * 22))
    } else {
      displayRotation = normalPose.rotation
    }
    const pose: Pose = {
      x: normalPose.x + (targetPose.x - normalPose.x) * load,
      y: normalPose.y + (targetPose.y - normalPose.y) * load,
      rotation: displayRotation,
      scale: normalPose.scale + (targetPose.scale - normalPose.scale) * load,
    }
    const transform = `translate(${pose.x} ${pose.y}) rotate(${pose.rotation}) scale(${pose.scale * sparkleSize}) translate(-43.5 -32.7)`
    for (const element of sparkles) element.setAttribute('transform', transform)
    const faceTransform = `translate(${MIDDLE.x} ${MIDDLE.y}) scale(${sparkleSize}) translate(${-MIDDLE.x} ${-MIDDLE.y})`
    for (const element of faces) element.setAttribute('transform', faceTransform)

    // Happy eyes float as one pair rather than following separate body lobes.
    const happyDisplacement = deformationAt(32.5, 27)
    const facePosition = (points: Point[], index: number, expression: FaceEmotion) => {
      const displacement = expression === 'happy' ? happyDisplacement : deformationAt(index === 0 ? 23 : 42, 27)
      const eyeScale = expression === 'happy' ? 1.12 * (1 + happyBreath * 0.08) : 1
      const centerX = index === 0 ? 23 : 42
      const eyeX = expression === 'happy' ? 32.5 + (centerX - 32.5) * (1 - happyBreath * 0.1) : centerX
      const faceShake = expression === 'happy' ? happyFaceShake : 0
      const drift = expression === 'sad'
        ? sadness * 1.5 + Math.sin(t * 0.8 + index * 0.35) * 0.5
        : Math.sin(t * 2.3) * 0.25 - boop * 0.8 - happyBreath * 3.5
      return points.map((point) => ({
        x: eyeX + (point.x - centerX) * eyeScale + displacement.x + faceShake,
        y: 28 + (point.y - 28) * eyeScale + displacement.y + drift,
      }))
    }
    const faceSoftness = mood === 'happy' ? 0.95 : 0.65
    let splitSoftness = faceSoftness
    if (splitTransition) {
      const duration = splitTransition.intoFace ? (splitTransition.faceEmotion === 'happy' ? 1.15 / happyEntrySpeed : 1.5) : 0.65
      splitTransition.elapsed = reduced ? duration : Math.min(duration, splitTransition.elapsed + dt)
      const progress = splitTransition.elapsed / duration
      const motion = springEase(progress)
      const separation = Math.sin(Math.min(1, motion) * Math.PI) * 2.5
      splitSoftness = faceSoftness + Math.sin(progress * Math.PI) * 1.55
      splitShapes = splitTransition.from.map((from, index) => {
        const transition = splitTransition!
        const direction = index === 0 ? -1 : 1
        if (!transition.intoFace) {
          const to = transformPoints(transition.to[index], pose)
          const amount = motion
          return from.map((point, vertex) => ({ x: point.x + (to[vertex].x - point.x) * amount, y: point.y + (to[vertex].y - point.y) * amount }))
        }
        const to = facePosition(transition.to[index], index, transition.faceEmotion)
        if (transition.faceEmotion === 'happy') {
          // A direct spring blend preserves overshoot; using the same Happy
          // shape as both core and target would square away the bounce.
          return from.map((point, vertex) => ({
            x: point.x + (to[vertex].x - point.x) * motion + direction * separation,
            y: point.y + (to[vertex].y - point.y) * motion,
          }))
        }
        const core = facePosition(transition.core[index], index, transition.faceEmotion)
        return from.map((point, vertex) => {
          // A single curved trajectory blends separation, rounded arms, and
          // eyelid growth together, rather than handing off between stages.
          const remaining = 1 - motion
          return {
            x: remaining ** 2 * point.x + 2 * remaining * motion * core[vertex].x + motion ** 2 * to[vertex].x + direction * separation,
            y: remaining ** 2 * point.y + 2 * remaining * motion * core[vertex].y + motion ** 2 * to[vertex].y,
          }
        })
      })
      if (progress === 1) {
        splitActive = splitTransition.intoFace
        if (!splitActive) splitShapes = null
        splitTransition = null
      }
    } else if (splitActive) {
      const expression = mood === 'happy' ? 'happy' : 'sad'
      splitShapes = outlines().faceHalves[expression].map((half, index) => facePosition(half, index, expression))
    }
    if (splitShapes) {
      const left = roundedPointsToPath(splitShapes[0], splitSoftness)
      const right = roundedPointsToPath(splitShapes[1], splitSoftness)
      eyes.forEach((eye, index) => eye.setAttribute('d', index % 2 === 0 ? left : right))
    }
    for (const element of sparkles) element.setAttribute('opacity', splitActive ? '0' : '1')
    for (const element of faces) element.setAttribute('opacity', splitActive ? '1' : '0')
    lastPose = pose
    // Gone, it has drawn nothing and there is nothing more to do until it is shown again.
    request = shown || presence > 0 ? requestAnimationFrame(animate) : 0
  }
  const wake = () => {
    if (request || !onScreen || !(shown || presence > 0)) return
    last = 0
    request = requestAnimationFrame(animate)
  }
  animate(performance.now())

  // Off screen there is nothing to draw, so the loop rests until the mascot is back in view.
  const visibility = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting
    if (onScreen) return wake()
    cancelAnimationFrame(request)
    request = 0
  })
  visibility.observe(frame)

  return {
    setShown: (next) => {
      shown = next
      wake()
    },
    setEmotion: (next) => { emotion = next },
    press: () => {
      if (emotion !== 'sad') return
      held = true
      poke = 0
      squeezeClicks++
      rainRequests++
      minimumRain += 4
    },
    release: () => { held = false },
    tap: () => {
      if (emotion === 'sad') return
      if (emotion === 'happy') {
        poke = 0
        happyReplay = true
        return
      }
      poke = 1
      spin.from = spin.rotation
      spin.target = spin.from + (Math.random() < 0.5 ? -360 : 360)
      spin.elapsed = 0
    },
    stop: () => {
      visibility.disconnect()
      cancelAnimationFrame(request)
      window.removeEventListener('pointermove', onPointer)
      document.removeEventListener('pointerleave', resetPointer)
      window.removeEventListener('blur', onWindowBlur)
      media.removeEventListener('change', onMotionChange)
    },
  }
}
