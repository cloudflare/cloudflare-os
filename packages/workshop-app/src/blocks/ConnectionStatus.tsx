import { Loader } from '@cloudflare/kumo'

/**
 * That the app is connecting to the backend again, small enough to leave everything else as it
 * is. Held back a moment, as most drops are soon over.
 */
export const ConnectionStatus = () => (
  <p
    role="status"
    className="appears-late flex h-9 items-center gap-2 rounded-full bg-kumo-base px-3.5 text-sm text-kumo-subtle ring-1 ring-kumo-line"
  >
    <Loader size="sm" />
    Reconnecting…
  </p>
)
