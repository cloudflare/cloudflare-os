import { useState, type ReactNode } from 'react'
import { Select } from '@/components/Select'
import { SettingRow } from './SettingRow'
import { useEditedField, type SaveOutcome } from './useEditedField'

// Chosen for a value of the user's own. No value is this.
const CUSTOM = '::custom'

export type SettingPresetsProps = {
  title: string
  description?: ReactNode
  /** It is not there yet, which is said beside its title (see `SettingRow`). */
  soon?: boolean
  /** The value as it is kept: one of the `presets`' ids, or one of the user's own. */
  value: string
  /** The values offered, by what each is kept as. One kept as nothing (`''`) lets the field be left empty. */
  presets: { id: string; label: string }[]
  /** A value was settled on, different from the one kept: a preset's id, or what was typed. */
  onSave: (value: string) => Promise<SaveOutcome>
  /** What the field for a value of the user's own is for, as it is not said over it: "Monthly limit, in dollars". */
  customLabel: string
  placeholder?: string
  /** The keyboard a touch screen offers for it, such as digits for a number. */
  inputMode?: 'numeric' | 'decimal'
  /** A value as the field shows it, where that is not as it is kept, such as with its thousands set apart. */
  format?: (value: string) => string
}

/**
 * A setting that is one of a few values, or one of the user's own: a menu of the values, ending
 * in Custom, which has the menu written in where it said which. What is typed is kept as a
 * `SettingField`'s is, and starts from the value kept.
 */
export const SettingPresets = ({ title, description, soon, value, presets, onSave, customLabel, placeholder, inputMode, format }: SettingPresetsProps) => {
  // What the menu was set to, where that is not what is kept: Custom, for as long as the page is
  // up, or a preset on its way to being kept.
  const [picked, setPicked] = useState<string>()
  const [refused, setRefused] = useState<string>()
  const { problem: typedProblem, field } = useEditedField({ value: format?.(value) ?? value, onSave, optional: presets.some(({ id }) => id === '') })
  const choice = picked ?? (presets.some(({ id }) => id === value) ? value : CUSTOM)
  const problem = choice === CUSTOM ? typedProblem : refused

  const choose = async (id: string) => {
    setRefused(undefined)
    setPicked(id)
    if (id === CUSTOM || id === value) return
    const outcome = await onSave(id)
    // Kept, the value says it. Not kept, the menu goes back to what is.
    setPicked((current) => (current === id ? undefined : current))
    if (!outcome.saved) setRefused(outcome.problem)
  }

  return (
    <SettingRow title={title} soon={soon} description={problem ? <span role="alert" className="text-kumo-danger">{problem}</span> : description}>
      <Select
        aria-label={title}
        value={choice}
        options={[...presets, { id: CUSTOM, label: 'Custom' }]}
        onValueChange={(id) => void choose(id)}
        typed={choice === CUSTOM ? {
          ...field,
          'aria-label': customLabel,
          inputMode,
          placeholder,
          // Only when Custom was just chosen: one kept from before must not take the focus as the page opens.
          autoFocus: picked === CUSTOM,
        } : undefined}
      />
    </SettingRow>
  )
}
