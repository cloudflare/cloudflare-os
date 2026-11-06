import { useRef, useState } from 'react'
import { Tooltip } from '@cloudflare/kumo'
import { Toolbox, Trash } from '@phosphor-icons/react'
import type { WorkspaceConnectionInfo, GatekeeperVendorInfo, WorkpieceId } from '@gadgets/workshop-shared/api'
import { GatekeeperIcon } from '../../components/GatekeeperIcon'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { WorkshopIconButton } from '../../components/WorkshopControls'
import { safeExternalUrl } from '../../utils/safeExternalUrl'
import { reportIssue } from '../../errorReporting'

type WorkspaceConnectionRowProps = {
  connection: WorkspaceConnectionInfo
  vendor: GatekeeperVendorInfo | undefined
  expanded: boolean
  onRemoveConnection: (id: WorkpieceId) => Promise<void>
}

export const WorkspaceConnectionRow = ({ connection, vendor, expanded, onRemoveConnection }: WorkspaceConnectionRowProps) => {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const removing = useRef(false)
  const type = vendor?.supportedResources.find(resource => resource.urlPattern === connection.typeUrlPattern)
  const href = safeExternalUrl(connection.resourceUrl)
  const subheader = connection.alwaysAvailable ? 'Built in'
    : connection.awaitingApproval ? 'Awaiting approval'
    : type?.title ?? vendor?.description.displayName
  const label = [connection.resourceTitle, subheader].filter(Boolean).join(' · ')
  const tileClassName = expanded ? 'h-5 w-5 rounded' : 'h-6 w-6 rounded-md'
  const icon = connection.alwaysAvailable ? (
    <span className={`flex shrink-0 items-center justify-center bg-kumo-tint text-kumo-subtle ${tileClassName}`}>
      <Toolbox size={expanded ? 13 : 15} />
    </span>
  ) : (
    <GatekeeperIcon
      vendorId={connection.vendorId}
      fallbackText={connection.resourceTitle}
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
        <span className="block truncate">{connection.resourceTitle}</span>
        {subheader && <span className="block truncate text-[11px] leading-[14px] text-kumo-subtle">{subheader}</span>}
      </span>
    </>
  ) : (
    <>
      {icon}
      {connection.awaitingApproval && (
        <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full border border-kumo-base bg-kumo-brand" />
      )}
    </>
  )
  const className = `relative flex min-w-0 items-center rounded-lg text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default ${
    expanded ? 'flex-1 gap-1 px-2 py-1' : 'h-9 w-9 shrink-0 justify-center self-center'
  }`
  const remove = async () => {
    if (removing.current) return
    removing.current = true
    setBusy(true)
    setError(null)
    try {
      await onRemoveConnection(connection.target)
      setConfirming(false)
    } catch (cause) {
      reportIssue('workspace-connections.remove', cause)
      setError('Couldn’t confirm removal. Check the connection and try again.')
    } finally {
      removing.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <div className={`flex min-w-0 items-center ${expanded ? '' : 'self-center'}`}>
        <Tooltip content={label} asChild>
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}
              className={`${className} transition-colors hover:bg-kumo-tint`}>
              {content}
            </a>
          ) : expanded ? (
            <div className={className}>{content}</div>
          ) : (
            <span role="img" tabIndex={0} aria-label={label} className={className}>{content}</span>
          )}
        </Tooltip>
        {expanded && !connection.alwaysAvailable && (
          <WorkshopIconButton
            danger
            aria-label={`Remove ${connection.resourceTitle} from workspace`}
            title="Remove from workspace"
            className="!h-6 !w-6 shrink-0"
            disabled={busy}
            onClick={() => { setError(null); setConfirming(true) }}
          >
            <Trash size={13} />
          </WorkshopIconButton>
        )}
      </div>
      <DeleteConfirmationDialog
        open={confirming}
        title="Remove from workspace?"
        description={<>
          All gadgets and chats in this workspace will lose access to {connection.resourceTitle}.
          Previously read data and history remain. Before removing this sharing check, ensure any sensitive
          data retained in gadgets or chat history is safe.
          {error && <span role="alert" className="mt-2 block text-kumo-danger">{error}</span>}
        </>}
        confirmLabel="Remove from workspace"
        confirmingLabel="Removing…"
        isDeleting={busy}
        onOpenChange={open => { if (!removing.current) setConfirming(open) }}
        onConfirm={remove}
      />
    </>
  )
}
