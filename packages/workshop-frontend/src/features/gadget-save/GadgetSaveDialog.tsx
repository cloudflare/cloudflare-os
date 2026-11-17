import { useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import { getResourceTypeId } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from '../../AuthContext'
import { CreationAccountDialog } from '../../components/CreationAccountDialog'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { WorkshopInput } from '../../components/WorkshopControls'
import type { SaveRequest } from './GadgetSaveMenuItems'
import { safeExternalUrl } from '../../utils/safeExternalUrl'
import { writeSavedFile } from './savedFiles'

/**
 * Saves the gadget's export as a file in one of the user's connected accounts: a new file, named
 * and placed here, or after a confirmation the content of the file `request.saved` names.
 */
export const GadgetSaveDialog = ({
  gadget, gadgetTitle, chatId, request: { target, storageKey, saved }, onClose,
}: {
  gadget: RpcStub<GadgetClient>
  gadgetTitle: string
  chatId?: number
  request: SaveRequest
  onClose: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [name, setName] = useState(gadgetTitle)
  const [updating, setUpdating] = useState(false)
  const { resource, format } = target

  const save = async (accountId: number, destination: string, fileName: string) => {
    // The export is passed unawaited, so it is piped to the gatekeeper without coming here.
    const file = gadget.export(format.id, chatId)
    try {
      const { url } = await authenticatedApi.saveFile(accountId, getResourceTypeId(resource),
        destination, fileName, format.contentType, file)
      writeSavedFile(storageKey, { accountId, url, name: fileName })
      const href = safeExternalUrl(url)
      toasts.add({
        title: `Saved to ${resource.title}`,
        variant: 'success',
        actions: href ? [{ children: 'Open', onClick: () => window.open(href, '_blank', 'noopener') }] : undefined,
      })
      onClose()
    } catch (err) {
      console.error(`Failed to save Gadget to ${resource.title}:`, err)
      toasts.add({
        title: err instanceof Error && err.message ? err.message : `Failed to save to ${resource.title}`,
        variant: 'error',
      })
    } finally {
      file[Symbol.dispose]()
    }
  }

  if (saved) {
    return (
      <DeleteConfirmationDialog
        open
        title={`Update “${saved.name}”?`}
        description="This replaces its content with the current version of this gadget. Suggestions that are pending in it are discarded, and comments may lose their place."
        isDeleting={updating}
        confirmLabel="Update"
        confirmingLabel="Updating…"
        onOpenChange={open => { if (!open) onClose() }}
        onConfirm={async () => {
          setUpdating(true)
          await save(saved.accountId, saved.url, saved.name)
          setUpdating(false)
        }}
      />
    )
  }

  return (
    <CreationAccountDialog
      title={`Save to ${resource.title}`}
      target={target}
      purpose="save"
      submitLabel="Save"
      submitDisabled={!name.trim()}
      // A savable type has a configurator, whose choice is where the file goes.
      onSubmit={({ accountId, configuration }) => save(accountId, configuration!, name.trim())}
      onCancel={onClose}
    >
      <WorkshopInput label="Name" value={name} onChange={event => setName(event.target.value)} />
    </CreationAccountDialog>
  )
}
