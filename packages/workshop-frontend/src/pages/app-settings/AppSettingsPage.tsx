import { useState, type ReactNode } from 'react'
import type { BlueprintOutput } from '@gadgets/workshop-shared/api'
import { useDocumentTitle } from '../../useDocumentTitle'
import { PageTabs } from '../../components/PageHeader'
import { RoundButton } from '../../components/RoundButton'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { FormatGlyph } from '../../components/format/FormatVisuals'
import { ChevronLeftIcon, ManageAccessIcon, PublishIcon, TrashIcon } from '../../components/icons/designIcons'
import { SETTING_BUTTON, Setting, SettingsCard, SettingsDivider } from '../../components/settings/SettingsCard'

/** An app's settings tabs (Figma "Frame 800"). */
export type AppSettingsTab = 'settings' | 'automations' | 'connections'

const TABS: { value: AppSettingsTab; label: string }[] = [
  { value: 'settings', label: 'Settings' },
  { value: 'automations', label: 'Automations' },
  { value: 'connections', label: 'Connections' },
]

/**
 * An app's settings (Figma "MacBook Pro 14\" - 27"): back to the app, its glyph, name and what it
 * is for, then who can use it, publishing it as a blueprint, and deleting it, with what runs it
 * and its connections on tabs of their own.
 */
export function AppSettingsPage({
  title,
  output,
  description,
  canPublish,
  onBack,
  backLabel,
  onManageAccess,
  onPublish,
  onDelete,
  automations,
  connections,
}: {
  title: string
  output?: BlueprintOutput
  /** What the app is for: its blueprint's description, when it came from one. */
  description?: string
  canPublish: boolean
  onBack: () => void
  /** Where back goes, such as "Back to Library". */
  backLabel: string
  onManageAccess: () => void
  onPublish: () => void
  /** Deletes the app; resolves once it is gone, and rejects if it could not be. */
  onDelete: () => Promise<void>
  /** The Automations tab's content: what runs the app's code on a schedule or event. */
  automations: ReactNode
  /** The Connections tab's content. */
  connections: ReactNode
}) {
  useDocumentTitle(`${title} · Settings`)
  const [tab, setTab] = useState<AppSettingsTab>('settings')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const deleteApp = async () => {
    setDeleting(true)
    try {
      await onDelete()
    } finally {
      setDeleting(false)
      setDeleteOpen(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex h-[68px] shrink-0 items-center gap-2.5 p-3 max-md:px-4 md:h-[58px]">
        <RoundButton label={backLabel} shape="pill" onClick={onBack} className="!gap-2 !px-2.5 max-md:h-11">
          <ChevronLeftIcon size={14} className="opacity-50" />
          {backLabel}
        </RoundButton>
      </div>

      <div className="mt-2.5 flex flex-1 flex-col items-center gap-2.5 px-4 pb-24 pt-3 md:px-3 md:pb-8">
        <span className="flex size-9 items-center justify-center rounded-full bg-kumo-tint text-kumo-default" aria-hidden="true">
          <FormatGlyph output={output} size="md" weight="regular" />
        </span>
        <h1 className="min-h-8 max-w-[640px] text-center text-[18px] font-medium leading-[22px] text-kumo-default">{title}</h1>
        {description && (
          <p className="max-w-[347px] text-center text-[14px] leading-[17px] text-kumo-subtle">{description}</p>
        )}
        <div className="flex max-w-full justify-center pb-4">
          <PageTabs label="Gadget settings" tabs={TABS} value={tab} onChange={setTab} />
        </div>

        <div className="flex w-full max-w-[640px] flex-col gap-2.5">
          {tab === 'settings' ? (
            <>
              <SettingsCard>
                <Setting title="Access" description="Choose who can use this gadget and who can edit it.">
                  <button type="button" onClick={onManageAccess} className={`${SETTING_BUTTON} text-kumo-default`}>
                    <ManageAccessIcon size={16} />
                    Manage
                  </button>
                </Setting>
                <SettingsDivider />
                <Setting title="Publish blueprint" description="Let others start their own gadget from this one.">
                  <button type="button" onClick={onPublish} disabled={!canPublish} className={`${SETTING_BUTTON} text-kumo-default`}>
                    <PublishIcon size={16} />
                    Publish
                  </button>
                </Setting>
              </SettingsCard>
              <SettingsCard>
                <Setting
                  title="Delete gadget"
                  danger
                  description={<>Delete this gadget for everyone it is shared with. <span className="text-kumo-default">This is not reversible.</span></>}
                >
                  <button type="button" onClick={() => setDeleteOpen(true)} className={`${SETTING_BUTTON} text-kumo-danger`}>
                    <TrashIcon size={14} />
                    Delete
                  </button>
                </Setting>
              </SettingsCard>
            </>
          ) : tab === 'automations' ? automations : (
            <div className="overflow-hidden rounded-[20px] bg-kumo-contrast/[0.03]">{connections}</div>
          )}
        </div>
      </div>

      <DeleteConfirmationDialog
        open={deleteOpen}
        title="Delete gadget?"
        description={<>This removes <span className="font-medium text-kumo-default">{title}</span> for everyone it is shared with. You can&apos;t undo this.</>}
        isDeleting={deleting}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void deleteApp()}
      />
    </div>
  )
}
