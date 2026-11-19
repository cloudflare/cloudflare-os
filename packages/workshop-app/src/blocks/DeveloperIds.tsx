import { SettingRow } from '@/blocks/SettingRow'
import { SettingsCard } from '@/blocks/SettingsGroup'
import { CopyValueButton } from './CopyValueButton'

/** One ID a settings page shows in developer mode: what it names, and the ID itself. */
export type DeveloperId = { title: string; value: string }

/** The IDs of what a settings page is about, each copied by pressing it, for looking into it elsewhere. Nothing without any. */
export const DeveloperIds = ({ ids }: { ids: readonly DeveloperId[] }) =>
  ids.length > 0 && (
    <SettingsCard>
      {ids.map(({ title, value }) => (
        <SettingRow key={title} title={title}>
          <CopyValueButton value={value} name={`Copy the ${title}`} />
        </SettingRow>
      ))}
    </SettingsCard>
  )
