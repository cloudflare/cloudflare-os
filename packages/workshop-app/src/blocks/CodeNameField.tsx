import { useEffect, useRef } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type CodeNameFieldProps = {
  /** The name it started from, whose extension is left out of what is selected to type over. */
  initial: string
  value: string
  /** What it says while nothing is typed. */
  placeholder?: string
  onValueChange: (value: string) => void
  onEnter: () => void
  onEscape: () => void
  onBlur: () => void
  invalid: boolean
  describedBy?: string
  label: string
  /** It takes the room it is given, as in a list, where otherwise it is about as wide as what is typed or its placeholder. */
  fill?: boolean
}

/**
 * A file's name typed where the file is, in its tab or its row: taken hold of as it appears, with
 * its name, but for the extension, selected to type over, and brought into view. Enter, Escape and
 * leaving it are the host's to answer; the keys are not passed on to what it is in.
 */
export const CodeNameField = ({ initial, value, placeholder, onValueChange, onEnter, onEscape, onBlur, invalid, describedBy, label, fill = false }: CodeNameFieldProps) => {
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const input = field.current
    if (!input) return
    input.focus()
    const dot = initial.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : initial.length)
    input.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [initial])
  return (
    <input
      ref={field}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      style={fill ? undefined : { width: `${Math.max(value.length, placeholder?.length ?? 6) + 1}ch` }}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onEscape()
        } else if (event.key === 'Enter') {
          event.preventDefault()
          onEnter()
        }
      }}
      onBlur={onBlur}
      className={cn(
        'h-7 min-w-0 rounded-md bg-transparent px-1 text-(length:--control-text) text-kumo-default outline-none placeholder:text-kumo-subtle',
        fill && 'flex-1',
        invalid && 'text-kumo-danger',
      )}
    />
  )
}
