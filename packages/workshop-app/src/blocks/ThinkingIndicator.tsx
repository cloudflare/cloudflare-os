import { LogoIcon } from '@/components/LogoIcon'

/** Shown while the assistant is working and has not produced text yet. */
export const ThinkingIndicator = () => (
  <div role="status" className="flex items-center gap-2 px-2 text-base text-kumo-subtle">
    <span className="text-kumo-default [&>svg]:size-5">
      <LogoIcon mono />
    </span>
    Thinking…
  </div>
)
