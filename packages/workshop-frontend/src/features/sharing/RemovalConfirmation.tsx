import type { Ref } from 'react'
import { Collapsible, Dialog } from '@cloudflare/kumo'
import { CaretDownIcon, InfoIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AffectedCollaborator, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'
import { RelatedRemovalTable } from './RelatedRemovalTable'

type Props = {
  authenticatedApi: RpcStub<AuthenticatedApi>
  name: string
  previewing: boolean
  /** Whether removing the direct grant leaves the person with no access at all. */
  losesAccess: boolean
  /** Other people whose access depends on this person's grant. */
  downstream: AffectedCollaborator[]
  keepSet: Set<string>
  onKeepSetChange: (keepSet: Set<string>) => void
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
  cancelRef: Ref<HTMLButtonElement>
  inviterNames: Map<string, string>
  resource: 'workspace' | 'gadget'
}

/** The body and footer of the dialog's "Remove <person>?" view. */
export const RemovalConfirmation = ({
  authenticatedApi,
  name,
  previewing,
  losesAccess,
  downstream,
  keepSet,
  onKeepSetChange,
  busy,
  onCancel,
  onConfirm,
  cancelRef,
  inviterNames,
  resource,
}: Props) => {
  const removalCount = 1 + downstream.filter(person => !keepSet.has(person.profile.id)).length

  return (
    <>
      <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-none px-4 pb-6 sm:px-6">
        <Dialog.Description className="text-sm text-kumo-subtle">
          {previewing
            ? 'Checking who will be affected…'
            : losesAccess
              ? resource === 'workspace'
                ? `${name} will lose access to this workspace and all its gadgets, including any shared with them directly.`
                : `${name} will lose access to this gadget.`
              : `Your direct grant will be removed. ${name} may still have access through another source.`}
        </Dialog.Description>
        {downstream.length > 0 && (
          <Collapsible.Root className="mt-4">
            <Collapsible.Trigger className="flex w-full text-xs items-start gap-2 rounded-xl bg-kumo-banner-info px-3 py-2.5 text-left text-sm font-medium text-kumo-info hover:bg-kumo-info-tint">
              <InfoIcon size={14} weight="regular" className="mt-[3px] shrink-0" aria-hidden="true" />
              <span className="flex-1">You can also remove {downstream.length === 1 ? 'the person' : 'people'} {name} invited</span>
              <CaretDownIcon size={14} weight="regular" className="mt-[3px] shrink-0 transition-transform [[data-panel-open]_&]:rotate-180" aria-hidden="true" />
            </Collapsible.Trigger>
            <Collapsible.Panel className="pt-2">
              <RelatedRemovalTable name={name} dependents={downstream} keepSet={keepSet} onKeepSetChange={onKeepSetChange} inviterNames={inviterNames} disabled={busy} authenticatedApi={authenticatedApi} />
            </Collapsible.Panel>
          </Collapsible.Root>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-kumo-line px-4 py-4 sm:px-6">
        <WorkshopButton ref={cancelRef} disabled={busy} onClick={onCancel}>
          Cancel
        </WorkshopButton>
        <WorkshopButton tone="danger" disabled={previewing || busy} onClick={onConfirm}>
          {busy ? 'Removing…' : removalCount > 1 ? `Remove (${removalCount})` : 'Remove'}
        </WorkshopButton>
      </div>
    </>
  )
}
