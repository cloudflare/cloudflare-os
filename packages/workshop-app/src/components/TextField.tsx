import type { ComponentProps } from 'react'
import { cn } from '@cloudflare/kumo/utils'

type FieldLabel =
  | { label: string; 'aria-label'?: undefined }
  // Without a label over it the field needs an accessible name.
  | { label?: undefined; 'aria-label': string }

export type TextFieldProps = FieldLabel &
  Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'className' | 'aria-label' | 'rows'> & {
    value: string
    onValueChange: (value: string) => void
    /** What is in it cannot be kept as it is. */
    invalid?: boolean
    /** Several lines of it, this many showing: for something written at length. */
    rows?: number
    className?: string
  }

// Its text is a button's, which is 16px on a narrow screen: less, and iOS zooms the page in on it.
// Its corners are a field's, not a button's: what is typed in is not what is pressed.
const FIELD =
  'w-full min-w-0 appearance-none rounded-xl border-0 bg-kumo-base px-3 text-(length:--control-text) text-kumo-default ring-1 ring-kumo-line outline-none ' +
  'placeholder:text-kumo-subtle focus-visible:ring-2 focus-visible:ring-kumo-focus aria-invalid:ring-kumo-danger disabled:opacity-50'

/**
 * A field for a line of text: as tall as a button, with corners rounded a little, which tells it
 * from one. With `rows` it is for several lines. With a `label` that is over it, from its edge.
 */
export const TextField = ({ label, value, onValueChange, invalid, rows, className, ...props }: TextFieldProps) => {
  const field = rows === undefined ? (
    <input
      type="text"
      {...props}
      value={value}
      aria-invalid={invalid || undefined}
      onChange={(event) => onValueChange(event.target.value)}
      className={cn(FIELD, 'h-(--control-size)', className)}
    />
  ) : (
    <textarea
      aria-label={props['aria-label']}
      placeholder={props.placeholder}
      disabled={props.disabled}
      rows={rows}
      value={value}
      aria-invalid={invalid || undefined}
      onChange={(event) => onValueChange(event.target.value)}
      className={cn(FIELD, 'resize-none py-2.5 leading-normal', className)}
    />
  )
  if (label === undefined) return field
  return (
    <label className="flex w-full flex-col gap-1.5">
      <span className="text-sm font-medium text-kumo-default">{label}</span>
      {field}
    </label>
  )
}
