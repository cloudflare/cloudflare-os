import { Switch, Tooltip } from '@cloudflare/kumo'
import { rpcFailureDescription } from '../rpcErrors'

interface HookToggleProps {
  enabled: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
  size?: 'sm' | 'base' | 'lg'
}

/** Enable/disable toggle for bound hooks. Used in the Connections tab, Activity log, and inline chat. */
export function HookToggle({ enabled, disabled = false, onToggle, size = 'sm' }: HookToggleProps) {
  return (
    <Tooltip content={enabled ? 'Disable this hook.' : 'Enable this hook.'} asChild>
      <span className="inline-flex items-center">
        <Switch
          checked={enabled}
          disabled={disabled}
          size={size}
          onCheckedChange={(checked) => onToggle(checked)}
          aria-label={enabled ? 'Disable hook' : 'Enable hook'}
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
