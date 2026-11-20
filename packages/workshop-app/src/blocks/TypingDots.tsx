import { cn } from '@cloudflare/kumo/utils'
import './TypingDots.css'

/**
 * Three dots hopping in turn, as someone typing: that a chat's agent is at work. In the colour of
 * what they are on (`text-*`): grey, as at work wants nobody, where an unread dot says something to read.
 */
export const TypingDots = ({ className }: { className?: string }) => (
  <span role="img" aria-label="Working" className={cn('flex items-center gap-0.5', className)}>
    {[0, 1, 2].map((dot) => <span key={dot} className="typing-dot size-1 rounded-full bg-current" style={{ animationDelay: `${dot * 140}ms` }} />)}
  </span>
)
