import { useEffect, useState } from 'react'

/**
 * Where a message's details are between away and shown. `arriving` and `full` are both all of
 * them: ones that were asked for arrive, and ones that are open when first drawn (a row scrolled
 * back to) are simply there. `row` is the one line they are folded to before they leave.
 */
export type DetailsStage = 'gone' | 'arriving' | 'full' | 'row' | 'leaving'

// How long folding to the line and the line leaving are each given. Keep in step with
// MessageBubble.css.
const FOLD = 240
const LEAVE = 240

/**
 * Takes a message's details between away and shown. They arrive whole, as a message would.
 * Putting them away is in two steps, the way something that was opened is closed: they fold to
 * their first line, which then leaves. `folds` is whether there is more than that line; without
 * it there is no fold to wait for.
 */
export const useDetailsStage = (open: boolean, folds: boolean): DetailsStage => {
  const [stage, setStage] = useState<DetailsStage>(open ? 'full' : 'gone')
  const shown = stage === 'arriving' || stage === 'full'
  // Asked for while away, or on their way out: they come (back). Put away while shown: fold.
  if (open !== shown) setStage(open ? 'arriving' : 'row')

  useEffect(() => {
    if (open || (stage !== 'row' && stage !== 'leaving')) return
    const [to, wait] = stage === 'row' ? ['leaving', folds ? FOLD : 0] as const : ['gone', LEAVE] as const
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = setTimeout(() => setStage(to), still ? 0 : wait)
    return () => clearTimeout(timer)
  }, [open, stage, folds])

  return stage
}
