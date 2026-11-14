import { Switch, Tooltip } from '@cloudflare/kumo'
import { rpcFailureDescription } from '../rpcErrors'

interface HookToggleProps {
  /** The hook's title, which names the switch; whether it is on is the switch's own state. */
  hookTitle: string
  enabled: boolean
  /** While a change is in flight: the switch ignores input and says it is busy. */
  pending?: boolean
  onToggle: (enabled: boolean) => void
  size?: 'sm' | 'base' | 'lg'
}

/** Enable/disable toggle for bound hooks. Used in the Connections tab, Activity log, and inline chat. */
export function HookToggle({ hookTitle, enabled, pending = false, onToggle, size = 'sm' }: HookToggleProps) {
  return (
    <Tooltip content={enabled ? 'Disable this hook.' : 'Enable this hook.'} asChild>
      <span className="inline-flex items-center">
        <Switch
          checked={enabled}
          // Not `disabled`, which would take focus from a keyboard user mid-change: the switch
          // stays focusable, ignores itself while busy, and says so.
          aria-disabled={pending || undefined}
          transitioning={pending}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          size={size}
          onCheckedChange={(checked) => {
            if (!pending) onToggle(checked)
          }}
          aria-label={`Hook: ${hookTitle}`}
        />
      </span>
    </Tooltip>
  )
}

/** The toast for a hook that could not be enabled or disabled, saying why when the error does. */
export const hookToggleFailureToast = (enabled: boolean, error: unknown) => ({
  title: `Failed to ${enabled ? 'enable' : 'disable'} hook`,
  description: rpcFailureDescription(error),
  variant: 'error' as const,
})
