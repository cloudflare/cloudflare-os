import { useState } from 'react'
import { Button, ConfirmMenu, SettingRow, SettingsGroup } from '@gadgets/ui'
import { releaseWords, type MadeTemplate } from './CreateTemplateDialog'
import { EditTemplateDialog } from './EditTemplateDialog'

export type MadeTemplateSettingsProps = {
  template: MadeTemplate
  /** What the group is called: "Template", or "Your template" on the template's own page. */
  title: string
  /** Goes to the template's page, from a button across from the title. Left out on that page. */
  onOpen?: () => void
  /** Releasing an update to it, or deleting it, is under way, which its buttons wait for. */
  busy?: boolean
  /** Keeps a new title and what it is for, rejecting with why it could not. */
  onEdit: (fields: { title: string; description: string }) => Promise<void>
  /** Releases what its gadget has changed since, `template.changes`. Only offered where there is any. */
  onRelease: () => void
  onDelete: () => void
}

/**
 * What its viewer can do about a template they made, as a group of settings with a row for each:
 * editing its title and what it is for, releasing an update (its code as the next version, or
 * only what it is connected to where only that changed), which says it is up to date where there
 * is nothing to release, and deleting it, which asks first; and across from its title, the way to
 * its page.
 */
export const MadeTemplateSettings = ({ template, title, onOpen, busy = false, onEdit, onRelease, onDelete }: MadeTemplateSettingsProps) => {
  const [editing, setEditing] = useState(false)
  const changes = template.changes
  return (
    <>
      <SettingsGroup
        title={title}
        description={`${template.title || 'Untitled template'} · Version ${template.version}`}
        action={onOpen && <Button onClick={onOpen}>View template</Button>}
      >
        <SettingRow title="Edit details" description="Change its title and what it is for. Its code stays as it is.">
          <Button disabled={busy} onClick={() => setEditing(true)}>Edit…</Button>
        </SettingRow>
        <SettingRow
          title={changes ? releaseWords(changes).action : 'Updates'}
          description={!changes
            ? 'The template has the latest of it.'
            : changes.code
              ? 'It has changes since the template’s last version. They go out as its next version, which anyone who made something from it can update to.'
              : 'What it is connected to has changed since the template’s last version: a connection renamed, swapped or given a new note. Updating sends only that; its code and version stay as they are.'}
        >
          {changes
            ? <Button variant="primary" disabled={busy} onClick={onRelease}>{releaseWords(changes).action}</Button>
            : <span className="inline-flex h-(--control-size) items-center px-(--control-pad) text-(length:--control-text) font-medium text-kumo-subtle">Up to date</span>}
        </SettingRow>
        <SettingRow title="Delete template" description="It’s removed for everyone, including anyone with its link. What people already made from it stays as it is.">
          <ConfirmMenu
            label="Delete"
            title="Delete template?"
            description="It’s removed for everyone, including anyone with its link. What people already made from it stays as it is. This can’t be undone."
            confirmLabel="Delete"
            disabled={busy}
            onConfirm={onDelete}
          />
        </SettingRow>
      </SettingsGroup>
      <EditTemplateDialog
        // Keyed, so that what was typed for one opening is not carried to the next.
        key={`${template.id}:${template.title}:${template.description}`}
        open={editing}
        onOpenChange={setEditing}
        template={{ title: template.title, description: template.description }}
        onSave={onEdit}
      />
    </>
  )
}
