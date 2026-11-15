import { Switch } from '@cloudflare/kumo'
import { ServiceLogo } from '@/components/ServiceLogo'
import type { ConnectionDialogResource } from './ConnectionDialog'

export type ResourceReachListProps = {
  resources: ConnectionDialogResource[]
  /** The service's logo, for a kind of thing that has no icon of its own. */
  logoUrl?: string
  /** Its switch is on. */
  isOn: (urlPattern: string) => boolean
  /** Its switch cannot be changed, as one the service has granted, which only it can take back. */
  isLocked?: (urlPattern: string) => boolean
  onToggle: (urlPattern: string, on: boolean) => void
  /** What a switch does, read out before the kind's name: "Allow", "Grant". */
  verb: string
  disabled?: boolean
}

/**
 * The kinds of thing on a service a gadget can be connected to, on a tinted surface: each one's
 * icon, name and what it is, and a switch for each that is granted on its own.
 */
export const ResourceReachList = ({ resources, logoUrl, isOn, isLocked, onToggle, verb, disabled }: ResourceReachListProps) => (
  <ul className="flex flex-col rounded-2xl bg-kumo-tint p-1.5">
    {resources.map((resource) => (
      <li key={resource.urlPattern} className="flex items-center gap-3 rounded-xl px-2.5 py-2">
        <ServiceLogo name={resource.title} src={resource.iconUrl ?? logoUrl} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-kumo-default">{resource.title}</span>
          <span title={resource.description} className="line-clamp-2 text-sm/5 text-kumo-subtle">{resource.description}</span>
        </div>
        {resource.grantable && (
          <Switch
            size="sm"
            aria-label={`${verb} ${resource.title}`}
            checked={isOn(resource.urlPattern)}
            disabled={isLocked?.(resource.urlPattern) || disabled}
            onCheckedChange={(on) => onToggle(resource.urlPattern, on)}
          />
        )}
      </li>
    ))}
  </ul>
)
