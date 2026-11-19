import { SettingRow } from '@/blocks/SettingRow'
import { Select } from '@/components/Select'
import { Switch } from '@/components/Switch'
import type { ChoiceSetting, ToggleSetting } from './settingDefinition'

type SettingDefinitionRowProps = {
  setting: ToggleSetting | ChoiceSetting
  /**
   * Changes it through the section's `useAttempt`, which says why one was refused, for a setting
   * that the server keeps. Left out for one that is only this device's.
   */
  attempt?: (what: string, action: () => Promise<unknown>) => Promise<boolean>
}

/** A row of the Settings page for a setting that is a switch or a choice, set by what its definition says. */
export const SettingDefinitionRow = ({ setting, attempt }: SettingDefinitionRowProps) => {
  const change = (value: boolean | string) => {
    const set = async () => (setting.kind === 'toggle' ? setting.set(value as boolean) : setting.set(value as string))
    if (attempt) void attempt(`change the ${setting.title.toLowerCase()}`, set)
    else void set()
  }
  return (
    <SettingRow title={setting.title} description={setting.description} soon={setting.soon}>
      {setting.kind === 'toggle'
        ? <Switch aria-label={setting.title} checked={setting.checked} onCheckedChange={change} />
        : (
            <Select
              aria-label={setting.title}
              value={setting.value}
              options={[...setting.options]}
              placeholder={setting.placeholder}
              searchable={setting.searchable}
              onValueChange={change}
            />
          )}
    </SettingRow>
  )
}
