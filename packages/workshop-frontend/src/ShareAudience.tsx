import type { ReactNode } from 'react'
import { Eye, Lightning } from '@phosphor-icons/react'
import type { ObserverBindingNeed } from '@gadgets/workshop-shared/api'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import { WorkshopButton } from './components/WorkshopControls'
import type { VendorBranding } from './useVendorBranding'

type Props = {
  // The connections a recipient must confirm with their own account, never empty; 'failed' when
  // the lookup failed, which only informs, since sharing still works.
  requirements: ObserverBindingNeed[] | 'failed'
  // What people who can't confirm access open instead: a gadget's snapshot. Absent for a
  // workspace, whose members must confirm access to open anything (see
  // Overseer.gadgetRequiresAccounts).
  snapshotPreview?: ReactNode
  // Set when the dialog's user is a collaborator, whose data these are not.
  ownerName?: string
  vendorBranding: Map<string, VendorBranding>
}

const TIER_ICON_CLASS = 'grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-kumo-tint to-kumo-elevated text-kumo-subtle ring-1 ring-inset ring-kumo-line/60'
const TIER_TITLE_CLASS = 'text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default'
const TIER_DETAIL_CLASS = 'mt-0.5 text-[12px] leading-4 tracking-[-0.15px] text-kumo-subtle'

/**
 * Who gets what from a share: for a gadget, a snapshot for everyone and the live gadget for people
 * whose own accounts reach every connection it uses; for a workspace, only the latter. Recipients
 * don't inherit the owner's connections, so sharers should know that cost before they invite.
 */
export const ShareAudienceSection = ({ requirements, snapshotPreview, ownerName, vendorBranding }: Props) => {
  const offersSnapshot = snapshotPreview !== undefined
  return (
    <section aria-labelledby="share-audience-heading" className="mt-4">
      <div className="mb-2 flex min-h-6 items-center justify-between gap-3 px-1">
        <h3 id="share-audience-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
          What people see
        </h3>
        {offersSnapshot && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[12px] leading-4 tracking-[-0.15px] text-kumo-subtle">Snapshot broken?</span>
            {/* Not wired up yet: the agent hand-off is still to be designed. */}
            <WorkshopButton tone="primary" className="!h-6 !rounded-md !px-2 !text-[12px] !leading-4">
              Ask agent to fix
            </WorkshopButton>
          </div>
        )}
      </div>
      {requirements === 'failed' ? (
        <p className="px-1 text-[12px] leading-[16px] tracking-[-0.15px] text-kumo-subtle">
          Couldn’t check which connections recipients will be asked to verify.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
          {snapshotPreview}
          <div className="divide-y divide-dashed divide-kumo-line/70 px-3">
            {offersSnapshot && (
              <div className="flex gap-3 py-3">
                <div className={TIER_ICON_CLASS}><Eye size={15} /></div>
                <div className="min-w-0 flex-1">
                  <p className={TIER_TITLE_CLASS}>Everyone with access</p>
                  <p className={TIER_DETAIL_CLASS}>
                    Can see a read-only snapshot with {ownerName ? `${ownerName}’s` : 'your'} data.
                  </p>
                </div>
              </div>
            )}
            <div className="flex gap-3 py-3">
              <div className={TIER_ICON_CLASS}><Lightning size={15} /></div>
              <div className="min-w-0 flex-1">
                <p className={TIER_TITLE_CLASS}>
                  {offersSnapshot ? 'People with access to these resources' : 'People you invite'}
                </p>
                <p className={TIER_DETAIL_CLASS}>
                  {offersSnapshot ? 'Can use your gadget alongside you with live connections.' : 'Can open it once they confirm access to these.'}
                </p>
                <ul className="mt-2.5 max-h-36 space-y-2 overflow-y-auto">
                  {requirements.map(requirement => {
                    const branding = vendorBranding.get(requirement.vendorId)
                    return (
                      <li key={requirement.gatekeeperId} className="flex min-w-0 items-center gap-2.5">
                        <GatekeeperIcon
                          vendorId={requirement.vendorId}
                          fallbackText={requirement.resourceTitle}
                          logoUrl={branding?.logoUrl}
                          color={branding?.color}
                          size={12}
                          className="h-6 w-6 rounded-md"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] leading-[17px] tracking-[-0.25px] text-kumo-default">
                            {requirement.resourceTitle}
                          </p>
                          {requirement.resourceUrl && (
                            <p className="truncate font-mono text-[11px] leading-4 text-kumo-inactive">
                              {requirement.resourceUrl}
                            </p>
                          )}
                        </div>
                        <span className="shrink-0 text-[12px] leading-4 tracking-[-0.15px] text-kumo-subtle">
                          {branding?.displayName ?? requirement.vendorId}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
