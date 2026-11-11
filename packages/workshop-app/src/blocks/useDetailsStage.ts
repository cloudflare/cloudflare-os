import { useEffect, useState } from 'react'

/**
 * Where a message's details are between away and fully shown. `row` is the one line they arrive as
 * and are folded back to before they leave.
 */
export type DetailsStage = 'gone' | 'row' | 'full' | 'leaving'

// How long each step is given before the next: the line to arrive (most of the way: the spring
// is still settling as it opens), to fold back to the line, and to leave. Keep in step with
// MessageBubble.css.
const ARRIVE = 200
const FOLD = 240
const LEAVE = 240

// What a stage turns into when left alone, and after how long. With nothing more than the line
// there is no folding to wait for. The line is given its time to arrive either way: it has to be
// drawn as the arriving line once for its arrival to play at all.
const next = (stage: DetailsStage, open: boolean, folds: boolean): [DetailsStage, number] | undefined => {
  if (stage === 'row') return open ? ['full', ARRIVE] : ['leaving', folds ? FOLD : 0]
  if (stage === 'leaving') return ['gone', LEAVE]
  return undefined
}

/**
 * Takes a message's details between away and shown in two steps, the way a row that opens does:
 * they arrive as one line, as a message would, and the line then opens to the rest. Putting them
 * away folds them back to the line, which then leaves. `folds` is whether there is more than the
 * line; without it there is nothing to wait for.
 *
 * Details that are already showing when they are first rendered (a row scrolled back to) are
 * simply there.
 */
export const useDetailsStage = (open: boolean, folds: boolean): DetailsStage => {
  const [stage, setStage] = useState<DetailsStage>(open ? 'full' : 'gone')
  // Asked for while away, or on their way out: the line comes (back). Put away while open: fold.
  if (open ? stage === 'gone' || stage === 'leaving' : stage === 'full') setStage('row')

  useEffect(() => {
    const step = next(stage, open, folds)
    if (!step) return
    const [to, wait] = step
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = setTimeout(() => setStage(to), still ? 0 : wait)
    return () => clearTimeout(timer)
  }, [open, stage, folds])

  return stage
}
