import { Cancel01Icon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'

export type CapturedLogsChipProps = {
  count: number
  severity: 'error' | 'warning' | 'log'
  /** The logs as they would be added, shown on hover. */
  preview?: string
  onAdd: () => void
  onDiscard: () => void
}

/**
 * Over the composer: what the gadget logged while the chat was shown, to be added to the message
 * for the agent to read, or put away. The dot, not the chip, says how bad, so a noisy gadget does
 * not paint the chat red.
 */
export const CapturedLogsChip = ({ count, severity, preview, onAdd, onDiscard }: CapturedLogsChipProps) => {
  if (count <= 0) return null
  const noun = `${severity}${count === 1 ? '' : 's'}`
  return (
    <div className="flex justify-center">
      <div className="flex max-w-full items-center gap-1 rounded-full bg-kumo-elevated py-1 ps-3 pe-1 text-sm text-kumo-subtle shadow-sm ring ring-kumo-hairline">
        <button type="button" title={preview} onClick={onAdd} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-full outline-offset-2 hover:text-kumo-default">
          <span
            aria-hidden="true"
            className={cn('size-1.5 shrink-0 rounded-full', severity === 'error' ? 'bg-kumo-danger' : severity === 'warning' ? 'bg-kumo-warning' : 'bg-kumo-line')}
          />
          <span className="truncate">Add the gadget’s {count} {noun} to your message</span>
        </button>
        <button
          type="button"
          aria-label={`Put away the gadget’s ${noun}`}
          onClick={onDiscard}
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full hover:bg-kumo-tint hover:text-kumo-default"
        >
          <Cancel01Icon aria-hidden="true" className="size-3" />
        </button>
      </div>
    </div>
  )
}
