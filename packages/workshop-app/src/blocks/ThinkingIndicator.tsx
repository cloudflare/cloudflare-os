import { LogoIcon } from '@/components/LogoIcon'

/** Shown while the assistant is working and nothing of what it is doing shows yet. */
export const ThinkingIndicator = ({ children = 'Thinking…' }: { children?: string }) => (
  <div role="status" className="flex items-center gap-2 px-2 text-base text-kumo-subtle">
    <span className="text-kumo-default [&>svg]:size-5">
      <LogoIcon mono />
    </span>
    {children}
  </div>
)
