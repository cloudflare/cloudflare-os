import { useState } from 'react'
import { FileDownIcon } from '@/components/icons'
import { ExportItems, type ExportChoices } from '@/blocks/ExportItems'
import { PaneStatus, type PaneStatusProps } from '@/blocks/PaneStatus'
import { SetUpConnectionDialog } from '@/blocks/SetUpConnectionDialog'
import { UpdateFileDialog } from '@/blocks/UpdateFileDialog'
import { Button, DropdownMenu, TextField } from '@gadgets/ui'
import { useReport } from './previewState'
import { Section } from './Section'

const FORMATS = [{ id: 'pdf', label: 'PDF' }, { id: 'docx', label: 'Word document' }, { id: 'md', label: 'Markdown' }]

const CHOICES = {
  ready: { status: 'ready', formats: FORMATS, saves: [] },
  saves: {
    status: 'ready',
    formats: FORMATS,
    saves: [
      { key: 'doc', title: 'Google Doc', saved: 'Q3 platform review' },
      { key: 'sharepoint', title: 'SharePoint file', iconUrl: '/favicon.svg' },
    ],
  },
  loading: { status: 'loading' },
  failed: { status: 'failed' },
  none: { status: 'ready', formats: [], saves: [] },
} satisfies Record<string, ExportChoices>

const MENUS: Record<keyof typeof CHOICES | 'exporting', string> = {
  saves: 'With saves',
  ready: 'Formats only',
  exporting: 'Exporting',
  loading: 'Loading',
  failed: 'Couldn’t load',
  none: 'No exports',
}

const STATUSES: Record<string, PaneStatusProps> = {
  working: { tone: 'working', title: 'Exporting to PDF…' },
  done: { tone: 'done', title: 'Saved to Google Doc', action: { label: 'Open', onSelect: () => {} }, onDismiss: () => {} },
  failed: { tone: 'failed', title: 'Couldn’t export PDF', description: 'Browser rendering isn’t available on this deployment.', onDismiss: () => {} },
}

// Stands in for the service's own form for where the file goes, which a gatekeeper draws in a frame.
const FakeFolderForm = ({ onReady }: { onReady: (ready: boolean) => void }) => (
  <label className="flex flex-col gap-1.5 rounded-(--surface-radius) bg-kumo-tint p-4 text-base/5">
    <span className="text-sm text-kumo-subtle">The service’s own form, in a frame</span>
    <select className="rounded-lg bg-kumo-base px-2 py-1.5 ring-1 ring-kumo-line" defaultValue="" onChange={(event) => onReady(event.target.value !== '')}>
      <option value="" disabled>Choose a folder</option>
      <option value="root">My Drive</option>
      <option value="reviews">My Drive / Reviews</option>
    </select>
  </label>
)

/** Exporting a gadget from its settings, what became of it, and saving it to an account. */
export const ExportPreview = () => {
  const { report, say, later } = useReport()
  const [menu, setMenu] = useState<keyof typeof MENUS>('saves')
  const [opened, setOpened] = useState(0)
  const [saving, setSaving] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [name, setName] = useState('Q3 platform review')
  const [ready, setReady] = useState(false)
  const choices = CHOICES[menu === 'exporting' ? 'ready' : menu]

  return (
    <>
      <Section title="ExportItems (Export on a gadget’s settings, and in its header’s more, opens to what it can be exported as, read each time it opens; each saves to the device when chosen, and while one exports the others wait. Then the kinds of file it can be saved as in the user’s accounts, with an update of the file the last such save made before its kind. Loading, a failure with Try again, which keeps the menu open, and a gadget with no exports are said in its place)">
        {Object.entries(MENUS).map(([key, label]) => (
          <Button key={key} variant={key === menu ? 'primary' : 'secondary'} onClick={() => setMenu(key as keyof typeof MENUS)}>{label}</Button>
        ))}
        <DropdownMenu icon={FileDownIcon} label="Export" caret keepTrigger align="end">
          <ExportItems
            choices={choices}
            onOpen={() => setOpened((count) => count + 1)}
            exporting={menu === 'exporting' ? 'docx' : undefined}
            onExport={(id) => say(`export as ${id}`)}
            onSave={(key) => { say(`save to ${key}`); setSaving(true) }}
            onUpdate={(key) => { say(`update the ${key}`); setUpdating(true) }}
          />
        </DropdownMenu>
        <p role="status" className="w-full text-sm text-kumo-subtle">{report} Opened {opened} {opened === 1 ? 'time' : 'times'}.</p>
      </Section>
      <Section title="PaneStatus (what became of an export, floated over the foot of the pane: under way, saved with the way to open it, and why it failed, until put away)">
        <div className="flex w-full max-w-xl flex-col gap-3">
          {Object.entries(STATUSES).map(([key, status]) => (
            <div key={key} className="relative h-28 overflow-hidden rounded-3xl bg-kumo-tint ring-1 ring-kumo-line">
              <PaneStatus {...status} />
            </div>
          ))}
        </div>
      </Section>
      <Section title="SetUpConnectionDialog saving a gadget, and UpdateFileDialog (Save to a kind of file: the account, the name, then where, in the service’s form opened for saving; Update asks before saving over the file the last save made, saying what is lost)">
        <Button onClick={() => { setReady(false); setSaving(true) }}>Save to Google Doc</Button>
        <Button onClick={() => setUpdating(true)}>Update a saved file</Button>
        <SetUpConnectionDialog
          open={saving}
          onOpenChange={setSaving}
          name="Google"
          title="Save to Google Doc"
          accept={{ label: 'Save', pending: 'Saving…' }}
          noAccount="Connect your Google account first. It’s saved there."
          accounts={[{ id: 1, name: 'ada@example.com' }]}
          selectedAccountId={1}
          onSelectAccount={() => {}}
          onConnectAccount={async () => true}
          onReconnect={async () => true}
          fields={<TextField label="Name" value={name} onValueChange={setName} />}
          configurator={<FakeFolderForm onReady={setReady} />}
          ready={ready && name.trim() !== ''}
          onAccept={async () => {
            await later()
            say(`saved “${name.trim()}” to Google Docs`)
            setSaving(false)
            return true
          }}
        />
        <UpdateFileDialog
          open={updating}
          onOpenChange={setUpdating}
          name="Q3 platform review"
          onConfirm={async () => {
            await later()
            say('updated “Q3 platform review”')
            setUpdating(false)
          }}
        />
      </Section>
    </>
  )
}
