import { WarningIcon } from '@phosphor-icons/react'

/** The gatekeeper's display-safe reason the last apply attempt stopped at this action. */
export function ActionFailureNote({ failure }: { failure: string }) {
  return (
    <div className="mt-1.5 flex items-start gap-2 rounded-md border border-kumo-warning/20 bg-kumo-warning-tint px-3 py-2 text-[12px] leading-4 text-kumo-warning">
      <WarningIcon size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{failure}</span>
    </div>
  )
}
