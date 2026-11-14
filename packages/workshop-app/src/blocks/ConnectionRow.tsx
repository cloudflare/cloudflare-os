import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { ServiceLogo } from '@/components/ServiceLogo'

export type ConnectionRowProps = {
  /** The service's name. */
  name: string
  logo?: { src?: string; color?: string }
  /** Which account it is, or what the service does. */
  detail?: string
  /** The detail is something wrong, said in the colour of danger: "Sign-in expired". */
  problem?: boolean
  /** What selecting the row does, as a word at its end while it is pointed at: "Manage", "Connect". */
  verb: string
  onSelect: () => void
  /** A button of its own at the end, in place of the verb: "Reconnect". */
  action?: ReactNode
}

/**
 * A service on the Connections page, on one line: its logo and name, then which account it is or
 * what it does, and what selecting it does at the end, shown while it is pointed at or has focus
 * (always to a finger, which cannot point).
 */
export const ConnectionRow = ({ name, logo, detail, problem, verb, onSelect, action }: ConnectionRowProps) => (
  <div className="group relative flex items-center gap-2 rounded-2xl pr-3 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5">
    <button
      type="button"
      aria-label={detail ? `${verb} ${name}, ${detail}` : `${verb} ${name}`}
      onClick={onSelect}
      // The whole row is the button, apart from the one over its end.
      className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-2.5 pl-3 text-left text-base after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
    >
      <ServiceLogo name={name} src={logo?.src} color={logo?.color} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="max-w-full shrink-0 truncate font-medium text-kumo-default">{name}</span>
        {detail && <span className={cn('min-w-0 truncate', problem ? 'text-kumo-danger' : 'text-kumo-subtle')}>{detail}</span>}
      </span>
    </button>
    {action ? (
      <span className="relative flex shrink-0">{action}</span>
    ) : (
      <span
        aria-hidden="true"
        className="shrink-0 text-kumo-subtle opacity-0 transition-opacity duration-75 group-hover:opacity-100 group-has-focus-visible:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100"
      >
        {verb}
      </span>
    )}
  </div>
)
