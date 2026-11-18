import { cn } from '@cloudflare/kumo/utils'
import { Mascot, type MascotEmotion } from '@/components/mascot/Mascot'

export type AgentMarkProps = {
  /** How it is: one of its runs at work, its latest run failed, or neither. */
  state?: 'idle' | 'working' | 'failed'
  /** Pointed at or focused, as the row it is on is: it turns to look, its sparkle a smile. */
  greeting?: boolean
  /** Played with as the home page's mascot is, leaning to a pointer: on the agent's own page. */
  interactive?: boolean
  size?: 'small' | 'medium' | 'large'
  className?: string
}

const SIZES = {
  small: { tile: 'size-5', mascot: 'w-4.5' },
  medium: { tile: 'size-10 rounded-xl', mascot: 'w-7' },
  large: { tile: 'size-16 rounded-2xl', mascot: 'w-11' },
}

const emotionOf = (state: AgentMarkProps['state'], greeting: boolean): MascotEmotion =>
  state === 'working' ? 'thinking' : state === 'failed' ? 'sad' : greeting ? 'happy' : 'idle'

/**
 * An agent, as the Workshop's cloud: one of its own, a worker, in the colours of the user's
 * messages rather than the logo's orange. It billows busily while a run is at work, is sad when
 * the latest failed, and otherwise rests with its sparkle, which turns to a smile when its row is
 * pointed at, as a greeting.
 */
export const AgentMark = ({ state = 'idle', greeting = false, interactive = false, size = 'medium', className }: AgentMarkProps) => {
  const { tile, mascot } = SIZES[size]
  const figure = <Mascot emotion={emotionOf(state, greeting)} interactive={interactive} reach={interactive ? 3 : 0.4} className={mascot} />
  if (size === 'small') return <span className={cn('grid shrink-0 place-items-center', tile, className)}>{figure}</span>
  return <span className={cn('grid shrink-0 place-items-center bg-kumo-fill', tile, className)}>{figure}</span>
}
