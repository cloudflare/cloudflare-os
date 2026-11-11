import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { RAINDROPS, startMascotMotion, type MascotEmotion, type MascotMotion } from './mascotMotion'
import { raindrop, sparkle } from './shapes'

export type { MascotEmotion }

export type MascotProps = {
  emotion: MascotEmotion
  /**
   * Whether it is there. It grows in blob by blob, the sparkle last, and shrinks away the same
   * way backwards; while not shown it draws nothing, does no work and cannot be played with, but
   * keeps its place in the layout. Shown unless told otherwise.
   */
  shown?: boolean
  /**
   * Let it be played with: a click spins its sparkle or cheers a happy one again, and holding a
   * sad one wrings rain out of it. Leave out where it only shows a state; it is then decorative,
   * and whoever places it says what the state is.
   */
  interactive?: boolean
  /** Give it a width; its height follows. Its motion scales with it. */
  className?: string
}

const HOLD_KEYS = [' ', 'Enter']
const LOBES = [0, 1, 2, 3]

const describe = (emotion: MascotEmotion) =>
  emotion === 'sad'
    ? 'Sad mascot. Hold to squeeze out rain'
    : emotion === 'happy'
      ? 'Happy mascot. Click for a squeeze of joy'
      : `Mascot is ${emotion}. Make the sparkle spin`

/**
 * The Workshop cloud, alive: it drifts when idle, bounces while thinking, and has a face for
 * happy and sad. It leans towards a pointer that comes near, stays still for people who ask for
 * reduced motion, and rests while off screen. Its colours are the brand asset's own, not UI tokens.
 */
export const Mascot = ({ emotion, shown = true, interactive, className }: MascotProps) => {
  const frame = useRef<HTMLDivElement>(null)
  const motion = useRef<MascotMotion>(undefined)
  const interior = useId()

  // Before the first paint, so the drawing is never seen as React left it: the motion draws every
  // frame, the first as it starts. Restarted with `interactive`, which changes the element that moves.
  useLayoutEffect(() => {
    const started = startMascotMotion(frame.current!)
    motion.current = started
    return started.stop
  }, [interactive])
  useLayoutEffect(() => motion.current?.setShown(shown), [shown, interactive])
  useEffect(() => motion.current?.setEmotion(emotion), [emotion, interactive])

  const drawing = (
    <svg viewBox="-4 -4 73 64" fill="none" className="block w-full overflow-visible" aria-hidden="true">
      <defs>
        <clipPath id={interior}>
          {LOBES.map((lobe) => <path key={lobe} data-part="lobe" />)}
        </clipPath>
      </defs>
      <g fill="#FF5C2E">
        {Array.from({ length: RAINDROPS }, (_, index) => <path key={index} data-part="drop" d={raindrop} transform="scale(0)" />)}
      </g>
      {/* Whatever of the sparkle or the face reaches past the body is drawn in the body's colour. */}
      <g fill="#FF5C2E">
        {LOBES.map((lobe) => <path key={lobe} data-part="lobe" />)}
        <g data-part="sparkle"><path d={sparkle} /></g>
        <g data-part="face" opacity="0">
          <path data-part="eye" />
          <path data-part="eye" />
        </g>
      </g>
      <g clipPath={`url(#${interior})`} fill="#fffaf5">
        <g data-part="sparkle"><path d={sparkle} /></g>
        <g data-part="face" opacity="0">
          <path data-part="eye" />
          <path data-part="eye" />
        </g>
      </g>
    </svg>
  )

  if (!interactive) {
    return (
      <div ref={frame} aria-hidden="true" className={cn('pointer-events-none', className)}>
        <div data-part="figure" className="origin-[50%_85%]">{drawing}</div>
      </div>
    )
  }

  const sad = emotion === 'sad'
  return (
    <div ref={frame} inert={!shown} className={className}>
      <button
        data-part="figure"
        type="button"
        aria-label={describe(emotion)}
        className="block w-full origin-[50%_85%] cursor-pointer rounded-[45%] outline-none select-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
        onPointerDown={(event) => {
          if (!sad || event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          motion.current?.press()
        }}
        onPointerUp={() => motion.current?.release()}
        onPointerCancel={() => motion.current?.release()}
        onLostPointerCapture={() => motion.current?.release()}
        onBlur={() => motion.current?.release()}
        onKeyDown={(event) => {
          if (!sad || !HOLD_KEYS.includes(event.key)) return
          event.preventDefault()
          if (!event.repeat) motion.current?.press()
        }}
        onKeyUp={(event) => {
          if (!HOLD_KEYS.includes(event.key)) return
          motion.current?.release()
          if (sad) event.preventDefault()
        }}
        onClick={(event) => {
          if (!sad) return motion.current?.tap()
          // Pressing already squeezed it. A click with no press behind it comes from assistive
          // technology, which gets one squeeze.
          if (event.detail !== 0) return
          motion.current?.press()
          motion.current?.release()
        }}
      >
        {drawing}
      </button>
    </div>
  )
}
