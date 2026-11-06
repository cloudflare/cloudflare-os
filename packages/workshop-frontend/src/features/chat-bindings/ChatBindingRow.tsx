import { Badge, Tooltip } from '@cloudflare/kumo'
import { Toolbox } from '@phosphor-icons/react'
import type { ChatBindingInfo, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { GatekeeperIcon } from '../../components/GatekeeperIcon'
import { safeExternalUrl } from '../../utils/safeExternalUrl'

type ChatBindingRowProps = {
  binding: ChatBindingInfo
  vendor: GatekeeperVendorInfo | undefined
  expanded: boolean
}

/**
 * One of a chat's resources in the output rail, labelled by its type and linked to the resource.
 */
export const ChatBindingRow = ({ binding, vendor, expanded }: ChatBindingRowProps) => {
  const type = vendor?.supportedResources.find(resource => resource.urlPattern === binding.typeUrlPattern)
  const href = safeExternalUrl(binding.resourceUrl)
  const subheader = binding.created && !binding.resourceUrl ? 'Awaiting approval'
    : binding.alwaysAvailable ? 'Built in'
    : type?.title ?? vendor?.description.displayName
  const label = [binding.resourceTitle, subheader, binding.changed && 'Changed'].filter(Boolean).join(' · ')
  const tileClassName = expanded ? 'h-5 w-5 rounded' : 'h-6 w-6 rounded-md'
  // The client's vendor catalog leaves out always-available resources' vendors, so there is no
  // logo to draw for them.
  const icon = binding.alwaysAvailable ? (
    <span className={`flex shrink-0 items-center justify-center bg-kumo-tint text-kumo-subtle ${tileClassName}`}>
      <Toolbox size={expanded ? 13 : 15} />
    </span>
  ) : (
    <GatekeeperIcon
      vendorId={binding.vendorId}
      fallbackText={binding.resourceTitle}
      logoUrl={type?.icon?.url ?? vendor?.description.logo?.url}
      color={vendor?.description.color}
      size={expanded ? 20 : 24}
      className={tileClassName}
    />
  )

  if (!expanded) {
    const className = 'relative flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-lg transition-colors hover:bg-kumo-tint'
    const changedDot = binding.changed && (
      <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-kumo-brand" />
    )
    return (
      <Tooltip content={label} asChild>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} className={className}>
            {icon}{changedDot}
          </a>
        ) : (
          <span role="img" aria-label={label} className={className}>{icon}{changedDot}</span>
        )}
      </Tooltip>
    )
  }

  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:underline">
              {binding.resourceTitle}
            </a>
          ) : (
            <span className="min-w-0 truncate">{binding.resourceTitle}</span>
          )}
          {binding.changed && <Badge variant="neutral" className="shrink-0">Changed</Badge>}
        </div>
        {subheader && <div className="truncate text-[11px] leading-[14px] text-kumo-subtle">{subheader}</div>}
      </div>
    </div>
  )
}
