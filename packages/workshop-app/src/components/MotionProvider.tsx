import type { ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { useMotionLevel } from '@/hooks/useMotionLevel'

/**
 * Has every `motion` element follow the motion level: with it off, nothing that has no
 * transition of its own is animated, and what has runs for no time.
 */
export const MotionProvider = ({ children }: { children: ReactNode }) => {
  const off = useMotionLevel() === 'off'
  return (
    <MotionConfig reducedMotion={off ? 'always' : 'never'} transition={off ? { duration: 0 } : undefined}>
      {children}
    </MotionConfig>
  )
}
