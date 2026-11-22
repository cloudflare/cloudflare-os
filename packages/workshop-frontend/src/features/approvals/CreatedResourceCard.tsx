import { Badge, Tooltip } from '@cloudflare/kumo'
import { ArrowUpRight } from '@phosphor-icons/react'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { GatekeeperIcon } from '../../components/GatekeeperIcon'
import { ResolveButton } from '../../components/ResolveButton'
import { WorkshopButton } from '../../components/WorkshopControls'
import type { VendorBranding } from '../../useVendorBranding'
import { safeExternalUrl } from '../../utils/safeExternalUrl'

/** What a created resource is, as far as the client can tell: its type and its vendor. */
export interface CreatedResourceKind {
  vendorId: string
  /** The vendor's name (VendorDescription.displayName), once the vendors have loaded. */
  vendorName?: string
  /** The resource type's title (SupportedResource.title), e.g. "Google Doc". */
  typeTitle?: string
}

/**
 * The transcript's card for a resource the agent created (ActionLogEntry.creation).
 *
 * Until it is saved the resource exists only in the workspace. Saving is enabled once the
 * creation is accepted with the rest of the chat's changes, which puts one question to the user
 * at a time; discarding it denies the creation. Once saved, the card links to it.
 */
export const CreatedResourceCard = ({
  creation,
  kind,
  branding,
  processing,
  onSave,
  onDeny,
}: {
  creation: ActionLogEntry & { type: 'action' }
  kind?: CreatedResourceKind
  branding?: VendorBranding
  processing: boolean
  onSave: () => void
  onDeny: () => void
}) => {
  const pending = creation.state === 'pending'
  const saved = creation.state === 'approved'
  const accepted = pending && creation.accepted !== undefined
  const resourceUrl = saved ? safeExternalUrl(creation.resourceUrl) : undefined
  const title = creation.resourceTitle || 'Untitled'
  const caption = [kind?.typeTitle, kind?.vendorName].filter(Boolean).join(' · ') || 'New resource'
  const save = (
    <WorkshopButton className="!h-7 text-[12px]" disabled={processing || !accepted} onClick={onSave}>
      Save to account
    </WorkshopButton>
  )

  return (
    <div className="w-full max-w-[440px] overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base">
      <div className="flex items-stretch">
        <span
          className="grid w-[88px] flex-shrink-0 place-items-center border-r border-kumo-line bg-kumo-tint/40"
          aria-hidden="true"
        >
          <GatekeeperIcon
            vendorId={kind?.vendorId}
            fallbackText={title}
            logoUrl={branding?.logoUrl}
            color={branding?.color}
            size={20}
            className="h-10 w-10 rounded-lg"
          />
        </span>
        <div className="min-w-0 flex-1 px-3.5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {resourceUrl ? (
              <a
                href={resourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 items-center gap-1 text-[14px] font-medium tracking-[-0.2px] text-kumo-default hover:underline"
              >
                <span className="truncate">{title}</span>
                <ArrowUpRight size={13} weight="bold" className="flex-shrink-0 text-kumo-inactive" aria-hidden="true" />
              </a>
            ) : (
              <span className="truncate text-[14px] font-medium tracking-[-0.2px] text-kumo-default">
                {title}
              </span>
            )}
            {pending && <Badge variant="neutral" className="flex-shrink-0">Unsaved</Badge>}
            {saved && <Badge variant="success" className="flex-shrink-0">Saved</Badge>}
          </div>
          <p className="m-0 mt-0.5 truncate text-[12px] text-kumo-subtle">{caption}</p>
          {creation.state === 'rejected' && (
            <p className="m-0 mt-1.5 text-[12px] leading-4 text-kumo-inactive">Discarded.</p>
          )}
          {pending && creation.applyError && (
            <p role="alert" className="m-0 mt-1.5 text-[12px] leading-4 break-words text-kumo-danger">
              Could not save: {creation.applyError.message}
            </p>
          )}
          {pending && (
            <div className="mt-2 flex items-center gap-1">
              {accepted ? save : <Tooltip content="Accept changes first" asChild>{save}</Tooltip>}
              <ResolveButton tone="deny" label="Discard" disabled={processing} onClick={onDeny} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
