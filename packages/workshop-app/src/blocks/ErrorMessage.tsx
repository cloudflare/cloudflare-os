import { ArrowClockwiseIcon, LightningIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { usePending, type ActionResult } from './usePending'

export type ErrorMessageProps = {
  children: string
  /** `usageLimit` is not a failure to retry: the account ran out of credits. */
  variant?: 'error' | 'usageLimit'
  /** Run the turn again. Offered on an error. */
  onRetry?: () => ActionResult
  /** Get more credits and carry on. Offered when the limit was reached. */
  onContinue?: () => ActionResult
}

/** A turn that ended badly, and the way forward when there is one. */
export const ErrorMessage = ({ children, variant = 'error', onRetry, onContinue }: ErrorMessageProps) => {
  const [pending, run] = usePending()
  const limit = variant === 'usageLimit'
  const StateIcon = limit ? LightningIcon : WarningCircleIcon

  return (
    <div className="flex flex-col items-start gap-2">
      <div
        className={cn(
          'flex max-w-[min(70%,65ch)] items-start gap-2 rounded-[21px] px-5 py-[11px] text-base/5 break-words',
          limit ? 'bg-kumo-warning-tint text-kumo-default' : 'bg-kumo-danger-tint text-kumo-danger',
        )}
      >
        <StateIcon aria-hidden="true" className={cn('size-5 shrink-0', limit && 'text-kumo-warning')} />
        <span className="min-w-0">{children}</span>
      </div>
      {limit
        ? onContinue && <Button variant="primary" icon={LightningIcon} disabled={pending} onClick={() => run(onContinue)}>Continue</Button>
        : onRetry && <Button icon={ArrowClockwiseIcon} disabled={pending} onClick={() => run(onRetry)}>Retry</Button>}
    </div>
  )
}
