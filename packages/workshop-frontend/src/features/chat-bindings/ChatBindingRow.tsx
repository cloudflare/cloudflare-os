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
  const awaitingApproval = binding.created && !binding.resourceUrl
  const subheader = awaitingApproval ? 'Awaiting approval'
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

  const content = expanded ? (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{binding.resourceTitle}</span>
        {subheader && <span className="block truncate text-[11px] leading-[14px] text-kumo-subtle">{subheader}</span>}
      </span>
      {binding.changed && (
        // Kumo rings a badge inside a hovered link, as if the badge were the link.
        <Badge variant="secondary" className="shrink-0 px-1.5 py-0.5 text-[10px] leading-none [a:hover_&]:ring-0">
          Changed
        </Badge>
      )}
    </>
  ) : (
    <>
      {icon}
      {/* Drawn like a draft gadget's dot, which also means not yet accepted. */}
      {awaitingApproval && (
        <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full border border-kumo-base bg-kumo-brand" />
      )}
    </>
  )
  const className = `relative flex items-center rounded-lg text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default ${
    expanded ? 'gap-1 px-2 py-1' : 'h-9 w-9 shrink-0 justify-center self-center'
  }`

  return (
    <Tooltip content={label} asChild>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={label}
          className={`${className} transition-colors hover:bg-kumo-tint`}
        >
          {content}
        </a>
      ) : expanded ? (
        <div className={className}>{content}</div>
      ) : (
        <span role="img" tabIndex={0} aria-label={label} className={className}>{content}</span>
      )}
    </Tooltip>
  )
}
