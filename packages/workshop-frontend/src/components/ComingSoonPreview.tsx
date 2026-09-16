import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'

/**
 * Wraps a non-functional design mock: renders the (frosted, non-interactive) mock as `children`
 * and lays a centered "coming soon" card on top. Used by Outputs and Context & Skills
 * so every not-yet-built destination gets the same treatment.
 */
export default function ComingSoonPreview({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: PhosphorIcon
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div aria-hidden className="pointer-events-none flex min-h-0 flex-1 select-none flex-col">
        {children}
      </div>

      <div className="absolute inset-0 z-10 flex items-start justify-center bg-kumo-base/55 px-6 pt-16 backdrop-blur-[3px] sm:pt-20">
        <div className="themed-compact-shadow flex flex-col items-center gap-3 rounded-2xl border border-kumo-line bg-kumo-base px-6 py-5 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-fill text-kumo-subtle">
            <Icon size={18} />
          </div>
          <div>
            <p className="text-[15px] font-semibold tracking-[-0.25px] text-kumo-default">{title}</p>
            <p className="mx-auto mt-1 max-w-xs text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              {description}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
