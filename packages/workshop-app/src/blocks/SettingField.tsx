import type { ReactNode } from 'react'
import { TextField } from '@/components/TextField'
import { SettingRow } from './SettingRow'
import { useEditedField, type SaveOutcome } from './useEditedField'

export type { SaveOutcome }

export type SettingFieldProps = {
  title: string
  description?: ReactNode
  /** The value as it is kept. */
  value: string
  /** A new value was settled on, different from the one kept. */
  onSave: (value: string) => Promise<SaveOutcome>
  /** It may be left empty, which is then what is kept. Otherwise an empty field puts the value back. */
  optional?: boolean
  placeholder?: string
  type?: 'text' | 'email'
  autoComplete?: string
}

/**
 * A setting that is a line of text, edited where it is: Enter or leaving the field keeps what was
 * typed, and Escape puts the value back. What could not be kept stays in the field, under why, to
 * be put right or given up.
 */
export const SettingField = ({ title, description, value, onSave, optional = false, placeholder, type = 'text', autoComplete }: SettingFieldProps) => {
  const { problem, field } = useEditedField({ value, onSave, optional })
  return (
    <SettingRow title={title} description={problem ? <span role="alert" className="text-kumo-danger">{problem}</span> : description}>
      <TextField
        {...field}
        aria-label={title}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        // The row's column where it has one; a width of its own where it is under what is said.
        className="w-72 @lg:w-full"
      />
    </SettingRow>
  )
}
