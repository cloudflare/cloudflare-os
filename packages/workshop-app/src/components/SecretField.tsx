import { UndoIcon } from './icons'
import { Button, TextField } from '@gadgets/ui'

export type SecretFieldProps = (
  | { label: string; 'aria-label'?: undefined }
  // Without a label over it the field needs an accessible name.
  | { label?: undefined; 'aria-label': string }
) & {
  /** What is typed, or `null` for the saved one, which is never shown or had. */
  value: string | null
  onValueChange: (value: string | null) => void
  /** One is saved and can be kept, which it can be gone back to once something is typed over it. */
  saved: boolean
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
  'aria-describedby'?: string
}

/**
 * A field for a key or a password that may already be saved where it is used, which never sends it
 * back: while it is kept, the field is empty and says "Saved", and what is typed replaces it whole.
 * Once something is, a button at its end keeps the saved one again. The field is the same input
 * throughout, so that it keeps the focus as the first key typed replaces the saved one.
 */
export const SecretField = ({ value, onValueChange, saved, placeholder, label, 'aria-label': ariaLabel, ...props }: SecretFieldProps) => {
  const kept = saved && value === null
  const named = label === undefined ? { 'aria-label': ariaLabel! } : { label }
  return (
    <span className="flex items-end gap-2">
      <span className="min-w-0 flex-1">
        <TextField
          {...named}
          {...props}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value ?? ''}
          placeholder={kept ? 'Saved' : placeholder}
          onValueChange={onValueChange}
        />
      </span>
      {saved && value !== null && (
        <Button variant="ghost" icon={UndoIcon} aria-label="Keep the saved one" disabled={props.disabled} onClick={() => onValueChange(null)} className="text-kumo-subtle" />
      )}
    </span>
  )
}
