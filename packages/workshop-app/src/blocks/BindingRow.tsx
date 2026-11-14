import { useState } from 'react'
import { DotsThreeIcon, LinkBreakIcon, PlugsConnectedIcon } from '@phosphor-icons/react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DropdownMenu } from '@/components/DropdownMenu'
import { ServiceLogo } from '@/components/ServiceLogo'

export type BindingRowProps = {
  /** The name the gadget's code knows it by, as in `env.NAME`. */
  name: string
  /** What it is bound to: a repository, a mailbox. */
  resource: string
  service?: { name: string; logoUrl?: string; color?: string }
  /** Proposed in a chat, and not accepted yet. */
  pending?: boolean
  /** Goes to where the account it goes through is managed. */
  onManage?: () => void
  /** Takes it away from the gadget, once asked; `false` if it was not tried (`ConfirmDialog`). */
  onRemove?: () => Promise<boolean>
}

/**
 * One of a gadget's connections, on one line: the service's logo, what it reaches, and the name
 * the gadget's code has for it, with more at the end: managing the account, and taking it away
 * from the gadget, which asks first.
 */
export const BindingRow = ({ name, resource, service, pending, onManage, onRemove }: BindingRowProps) => {
  const [removing, setRemoving] = useState(false)
  return (
    <div className="group flex items-center gap-3 rounded-2xl py-2.5 pr-1.5 pl-3 text-base hover:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
      <ServiceLogo name={service?.name ?? resource} src={service?.logoUrl} color={service?.color} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-kumo-default">{resource}</span>
        <span className="truncate text-sm text-kumo-subtle">
          <code className="font-mono text-[0.92em]">env.{name}</code>
          {service && ` · ${service.name}`}
          {pending && ' · Waiting to be accepted'}
        </span>
      </span>
      {(onManage || onRemove) && (
        <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${resource}`} triggerVariant="ghost" triggerClassName="text-kumo-subtle" align="end">
          {onManage && <DropdownMenu.Item icon={PlugsConnectedIcon} onSelect={onManage}>Manage connection</DropdownMenu.Item>}
          {onRemove && <DropdownMenu.Item icon={LinkBreakIcon} onSelect={() => setRemoving(true)}>Remove from gadget</DropdownMenu.Item>}
        </DropdownMenu>
      )}
      {onRemove && (
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          destructive
          title={`Remove ${resource}?`}
          description={<>The gadget’s code loses <code className="font-mono">env.{name}</code>. The connection stays in the workspace, for whatever else uses it.</>}
          confirm="Remove"
          onConfirm={onRemove}
        />
      )}
    </div>
  )
}
