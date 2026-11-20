import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@cloudflare/kumo/utils'
import { Banner, type BannerProps, Button, useMotionTransition } from '@gadgets/ui'
import { Mascot, type MascotEmotion } from '@/components/mascot/Mascot'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

export type OnboardingFrameProps = {
  emotion: MascotEmotion
  title: string
  subtitle?: string
  /** Which step this is, from 0, of how many: one step alone shows none. */
  step: { at: number; of: number }
  /** What did not work, over the buttons. */
  problem?: BannerProps
  /** To the step of its dot; none while the dots are only to be read. */
  onStep?: (at: number) => void
  /** Back to the step before; none on the first. */
  onBack?: () => void
  /** On to the next step, or to the app from the last; also what Enter does in a field. */
  next: { label: string; busy?: boolean; disabled?: boolean; onSelect: () => void }
  children: ReactNode
}

// One column down the middle of the window, as wide as the sign-in page's, its sides in from the
// window's on a phone. What scrolls is as wide as the window, so its scrollbar is at the edge.
const COLUMN = 'mx-auto w-full max-w-[31rem] px-6'

// About as long as it takes to turn happy and give its squeeze of joy.
const CHEER_MS = 1800

/**
 * The mascot as a step has it: happy as the step opens, then idle, and happy again for as long as
 * it cheers each time it is clicked. Busy or sad, it is that instead.
 */
const StepMascot = ({ emotion }: { emotion: MascotEmotion }) => {
  const resting = emotion === 'happy' || emotion === 'idle'
  const [cheers, setCheers] = useState(emotion === 'happy' ? 1 : 0)
  useEffect(() => {
    if (cheers === 0) return
    const timer = setTimeout(() => setCheers(0), CHEER_MS)
    return () => clearTimeout(timer)
  }, [cheers])
  return (
    // The click is heard on its way out of the mascot's own button, which a key presses too.
    <div onClick={() => resting && setCheers((count) => count + 1)}>
      {/* As on the sign-in page: small on a mostly empty page, so it notices a pointer from well away. */}
      <Mascot emotion={resting ? (cheers > 0 ? 'happy' : 'idle') : emotion} color="brand" interactive reach={4} className="w-12" />
    </div>
  )
}

// Springy, so that a dot pointed at swells and the one for this step stretches into place.
const DOT_SPRING = { type: 'spring', duration: 0.45, bounce: 0.5 } as const

/**
 * Which of the steps this is, a dot for each and a longer one for this, which stretches out as the
 * step opens. Each other dot goes to its step, swelling when pointed at and giving when pressed.
 */
const StepDots = ({ at, of, onStep }: OnboardingFrameProps['step'] & { onStep?: (at: number) => void }) => {
  const transition = useMotionTransition(DOT_SPRING)
  return (
    <ol aria-label={`Step ${at + 1} of ${of}`} className="flex items-center">
      {Array.from({ length: of }, (_, index) => {
        const current = index === at
        const goes = !current && onStep !== undefined
        return (
          <li key={index} className="flex">
            {/* Taller and wider than the dot, so it is pointed at without aiming. */}
            <motion.button
              type="button"
              aria-label={`Step ${index + 1}`}
              aria-current={current ? 'step' : undefined}
              disabled={!goes}
              onClick={() => onStep?.(index)}
              whileHover={goes ? { scale: 1.5 } : undefined}
              whileTap={goes ? { scale: 0.85 } : undefined}
              transition={transition}
              className="group flex cursor-pointer rounded-full px-1 py-2 outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus disabled:cursor-default"
            >
              <motion.span
                initial={{ width: 6 }}
                animate={{ width: current ? 24 : 6 }}
                transition={transition}
                className={cn('h-1.5 rounded-full transition-colors', current ? 'bg-kumo-contrast' : 'bg-kumo-contrast/20 group-hover:group-enabled:bg-kumo-contrast/45')}
              />
            </motion.button>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * A step of setting up, in the middle of the window as the sign-in page is: the mascot over what
 * the step is for and which of the steps it is, what is asked, and the way on in the middle of the
 * foot, or at its end with the way back at its start after the first. The top and the foot stay
 * where they are: where what is asked is taller than the room between them, it alone scrolls,
 * fading out under each. Each step fades in in place of the last (key it by its step).
 */
export const OnboardingFrame = ({ emotion, title, subtitle, step, problem, onStep, onBack, next, children }: OnboardingFrameProps) => {
  useDocumentTitle('Welcome')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!next.busy && !next.disabled) next.onSelect()
  }
  return (
    // Its column no wider than the window, whatever is in it: a service's name is cut short rather
    // than pushing the page out sideways. In the middle while it fits, and as tall as the window once not.
    <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-kumo-canvas">
      <form onSubmit={submit} className="appears my-auto flex max-h-full min-h-0 min-w-0 flex-col">
        <div className={cn(COLUMN, 'relative z-10 flex shrink-0 flex-col items-center gap-5 pt-10 text-center after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-6 after:h-6 after:bg-linear-to-b after:from-kumo-canvas')}>
          <StepMascot emotion={emotion} />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-xl font-semibold text-balance text-kumo-default">{title}</h1>
            {subtitle && <p className="text-base text-balance text-kumo-subtle">{subtitle}</p>}
          </div>
          {step.of > 1 && <StepDots {...step} onStep={onStep} />}
        </div>
        {/* Room at each end as tall as the fade over it, so nothing is faded until it is scrolled. */}
        <div className="min-h-0 overflow-y-auto">
          <div className={cn(COLUMN, 'pt-7 pb-10')}>{children}</div>
        </div>
        <div className={cn(COLUMN, 'relative flex shrink-0 flex-col gap-3 pt-4 pb-8 before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:h-10 before:bg-linear-to-t before:from-kumo-canvas')}>
          {problem && <Banner {...problem} />}
          {/* With no way back, the way on is in the middle, under what is asked. */}
          <div className={cn('flex items-center gap-3', onBack ? 'justify-between' : 'justify-center')}>
            {onBack && <Button variant="ghost" disabled={next.busy} onClick={onBack}>Back</Button>}
            <Button type="submit" variant="primary" disabled={next.busy || next.disabled}>{next.label}</Button>
          </div>
        </div>
      </form>
    </div>
  )
}
