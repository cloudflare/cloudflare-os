import type { ReactNode } from 'react'
import { InputGroup, SensitiveInput } from '@cloudflare/kumo'
import { ArrowCounterClockwise } from '@phosphor-icons/react'

// Shown in place of a secret the server withholds, which the client never has.
const WITHHELD_MASK = '********'

/**
 * An input for a secret that may already be stored on the server, which never sends it back. A
 * `value` of null stands for the stored value, shown masked until the user types a replacement.
 */
export const StoredSecretInput = ({ value, stored, onValueChange, label, 'aria-label': ariaLabel,
                                    description, placeholder, error }: {
  value: string | null
  /** Whether a value is stored, which the user may return to keeping after starting to replace it. */
  stored: boolean
  onValueChange: (value: string | null) => void
  label?: ReactNode
  'aria-label'?: string
  description?: ReactNode
  placeholder?: string
  error?: string
}) => {
  if (!stored) {
    return (
      <SensitiveInput
        label={label}
        aria-label={ariaLabel}
        description={description}
        placeholder={placeholder}
        value={value ?? ''}
        onValueChange={onValueChange}
        error={error}
      />
    )
  }

  // The group's label names the input, but Kumo's Input still warns without an aria-label.
  const inputLabel = ariaLabel ?? (typeof label === 'string' ? label : undefined)
  return (
    <InputGroup
      label={label}
      description={description}
      error={error ? { message: error, match: true } : undefined}
    >
      {/* One input for both states, so it keeps focus when the first keystroke replaces the
          stored value. The mask is a placeholder, so whatever the user types replaces it whole. */}
      <InputGroup.Input
        aria-label={inputLabel}
        type="password"
        placeholder={value === null ? WITHHELD_MASK : placeholder}
        value={value ?? ''}
        onChange={(e) => onValueChange(e.target.value)}
      />
      {value !== null && (
        <InputGroup.Addon align="end">
          <InputGroup.Button
            shape="square"
            icon={ArrowCounterClockwise}
            aria-label="Keep stored value"
            tooltip="Keep stored value"
            onClick={() => onValueChange(null)}
          />
        </InputGroup.Addon>
      )}
    </InputGroup>
  )
}
