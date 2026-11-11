import { Tooltip } from '@cloudflare/kumo'
import { ArrowsClockwise, Gauge } from '@phosphor-icons/react'
import type { SpendLimitHit } from '@gadgets/workshop-shared/api'

const units = [
  { seconds: 86400, name: 'day' },
  { seconds: 3600, name: 'hour' },
  { seconds: 60, name: 'minute' },
  { seconds: 1, name: 'second' },
]

/** A limit's window in words: "hour", "24 hours", "7 days". */
export const formatLimitWindow = (seconds: number) => {
  if (seconds === 86400) return '24 hours'
  const unit = units.find(u => seconds % u.seconds === 0) ?? units[units.length - 1]
  const count = seconds / unit.seconds
  return count === 1 ? unit.name : `${count} ${unit.name}s`
}

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 4,
})

/** The card's sentence: what the limit is and when to try again. */
export const spendLimitDetail = ({ cost, windowSeconds, sliding }: SpendLimitHit) => {
  const limit = dollars.format(cost)
  const window = formatLimitWindow(windowSeconds)
  return sliding
    ? `AI usage is limited to ${limit} over a rolling ${window}. Try again a little later.`
    : `AI usage is limited to ${limit} every ${window}. Try again once the limit resets.`
}

/** Shown in chat when an AI Gateway spend limit refused a turn. */
export const SpendLimitCard = ({ limit, timestamp, retry }: {
  limit: SpendLimitHit
  /** Shown on hover. */
  timestamp: string
  retry?: { onRetry: () => void, disabled: boolean }
}) => (
  <div className="max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
    <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-tint text-kumo-subtle"
        >
          <Gauge size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <Tooltip content={timestamp} asChild>
            <p className="m-0 w-fit font-medium text-kumo-default">AI spending limit reached</p>
          </Tooltip>
          <p className="m-0 mt-1 text-[13px] leading-[18px] text-pretty text-kumo-subtle">
            {spendLimitDetail(limit)}
          </p>
        </div>
        {retry && (
          <button
            type="button"
            onClick={retry.onRetry}
            disabled={retry.disabled}
            className="ml-1 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 self-center rounded-md px-2.5 text-[13px] leading-4 font-medium text-kumo-default transition-[background-color,opacity,transform] duration-150 ease-out enabled:hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowsClockwise size={12} weight="bold" aria-hidden="true" />
            Try again
          </button>
        )}
      </div>
    </div>
  </div>
)
