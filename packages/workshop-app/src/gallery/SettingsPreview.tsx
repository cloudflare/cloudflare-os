import { useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { ArchiveIcon, TrashIcon } from '@phosphor-icons/react'
import { SettingsGroup, SettingsRow } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { useReport } from './previewState'
import { Section } from './Section'

/** Settings pages' rows, and the dialogs that ask before something is done. */
export const SettingsPreview = () => {
  const { report, after } = useReport()
  const [notify, setNotify] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [failing, setFailing] = useState(false)
  const [dialog, setDialog] = useState(false)

  return (
    <>
      <Section title="SettingsGroup, SettingsRow (a switch, a button, and one that cannot be undone)">
        <div className="flex w-full max-w-3xl flex-col gap-2">
          <SettingsGroup label="Chat">
            <SettingsRow
              title="Notifications"
              description="Get notified when things are happening in this chat."
              control={<Switch aria-label="Notifications" checked={notify} onCheckedChange={setNotify} />}
            />
            <SettingsRow
              title="Archive chat"
              description="It won’t show up in your recents, but can still be found in its workspace."
              control={<Button icon={ArchiveIcon} onClick={after('archive')}>Archive</Button>}
            />
          </SettingsGroup>
          <SettingsGroup label="Danger">
            <SettingsRow
              danger
              title="Delete chat"
              description="Delete the chat for everyone in the workspace. This can’t be undone."
              control={<Button variant="danger" icon={TrashIcon} onClick={() => setConfirming(true)}>Delete</Button>}
            />
          </SettingsGroup>
        </div>
      </Section>
      <Section title="Dialog, ConfirmDialog (asks first; a failure leaves it open under why)">
        <Button onClick={() => setDialog(true)}>Dialog</Button>
        <Button variant="danger" icon={TrashIcon} onClick={() => setConfirming(true)}>Confirm</Button>
        <Button variant="danger" onClick={() => setFailing(true)}>Confirm that fails</Button>
      </Section>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="Publish as blueprint"
        description="Anyone in this deployment can start their own copy of it."
        footer={<><Button onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary" onClick={() => setDialog(false)}>Publish</Button></>}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        destructive
        title="Delete “Launch readiness”?"
        description="It goes for everyone in the workspace, with its messages. This can’t be undone."
        confirm="Delete chat"
        onConfirm={() => new Promise((resolve) => setTimeout(resolve, 600)).then(after('deleted'))}
      />
      <ConfirmDialog
        open={failing}
        onOpenChange={setFailing}
        destructive
        title="Delete “Launch readiness”?"
        confirm="Delete chat"
        onConfirm={() => new Promise((_, reject) => setTimeout(() => reject(new Error('The workspace is offline.')), 600))}
      />
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
