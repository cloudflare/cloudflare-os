import { useState } from 'react'
import { Select, type SelectOption } from '@/components/Select'
import { Switch } from '@/components/Switch'

// What a setting that is not there yet is set by. It works, to show what the setting will be
// like, but what it is set to is only its own, for as long as the page is up: nothing is kept,
// and nothing goes by it. Replace one with the real control once its setting is there.

/** A switch for a setting that is not there yet, `on` to start with or off. */
export const SoonSwitch = ({ label, on = false }: { label: string; on?: boolean }) => {
  const [checked, setChecked] = useState(on)
  return <Switch aria-label={label} checked={checked} onCheckedChange={setChecked} />
}

/** A menu for a setting that is not there yet, on the first of its options to start with, or on `value`. */
export const SoonSelect = ({ label, options, value }: { label: string; options: SelectOption<string>[]; value?: string }) => {
  const [chosen, setChosen] = useState(value ?? options[0]?.id ?? '')
  return <Select aria-label={label} value={chosen} options={options} onValueChange={setChosen} />
}
