import { useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { ArchiveIcon, CirclesFourIcon, FolderIcon, MagnifyingGlassIcon, NotePencilIcon, TrashIcon } from '@phosphor-icons/react'
import { SearchDialog, type SearchEntry } from '@/blocks/SearchDialog'
import { SettingsGroup, SettingsRow } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useReport } from './previewState'
import { Section } from './Section'

const workspace = (title: string, label: string, detail: string) => ({ title, group: 'Workspaces', detail, icon: <WorkspaceIcon label={label} small /> })

/** Settings pages' rows, the dialogs that ask before something is done, and search. */
export const SettingsPreview = () => {
  const { report, say, after } = useReport()
  const [searching, setSearching] = useState(false)
  const entries: SearchEntry[] = [
    { title: 'New chat', group: 'Go to', icon: <NotePencilIcon /> },
    { title: 'Workspaces', group: 'Go to', icon: <FolderIcon /> },
    { title: 'Library', group: 'Go to', keywords: ['gadgets', 'files'], icon: <CirclesFourIcon /> },
    workspace('Garden planning', 'GP', 'Just now'),
    workspace('Launch readiness', 'LR', 'Yesterday'),
    workspace('Weekly digest', 'WD', 'Monday'),
  ].map((entry) => ({ ...entry, key: entry.title, onSelect: () => say(`went to ${entry.title}`) }))
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
      <Section title="SearchDialog (type to narrow it; arrows and Enter, or a click, to go)">
        <Button icon={MagnifyingGlassIcon} onClick={() => setSearching(true)}>Search</Button>
      </Section>
      <SearchDialog
        open={searching}
        onOpenChange={setSearching}
        entries={entries}
        suggested={[...entries.slice(3, 5), ...entries.slice(0, 3)]}
        placeholder="Search workspaces and pages"
      />
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
