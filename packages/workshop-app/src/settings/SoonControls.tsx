import { Select, type SelectOption, Switch } from '@gadgets/ui'

// What a setting that is not there yet is set by: it is shown as it will be, at what it would
// start as, and is out of use, which the row or the group it is in sees to (`SettingRow`'s and
// `SettingsGroup`'s `soon`). Replace one with the real control once its setting is there.

const nothing = () => {}

/** A switch for a setting that is not there yet, `on` or off. */
export const SoonSwitch = ({ label, on = false }: { label: string; on?: boolean }) => <Switch aria-label={label} checked={on} onCheckedChange={nothing} />

/** A menu for a setting that is not there yet, on the first of its options, or on `value`. */
export const SoonSelect = ({ label, options, value }: { label: string; options: SelectOption<string>[]; value?: string }) => (
  <Select aria-label={label} value={value ?? options[0]?.id ?? ''} options={options} onValueChange={nothing} />
)
