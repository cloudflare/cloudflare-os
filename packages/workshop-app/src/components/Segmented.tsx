import { useId, useRef, type KeyboardEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { cn } from '@cloudflare/kumo/utils'

export type SegmentedProps<Value extends string> = {
  value: Value
  onValueChange: (value: Value) => void
  options: { value: Value; label: string }[]
  /** What it chooses, read out: "Document edits". */
  'aria-label': string
  /** Ties it to the text that says what it is for. */
  'aria-describedby'?: string
  disabled?: boolean
  className?: string
}

const EASE = [0.25, 0.1, 0.25, 1] as const

/**
 * A choice between a few, side by side on a track, the chosen one raised on a pill that slides to
 * whichever is chosen next. A radio group: one tab stop, the arrow keys move the choice.
 */
export const Segmented = <Value extends string>({
  value, onValueChange, options, 'aria-label': label, 'aria-describedby': describedBy, disabled, className,
}: SegmentedProps<Value>) => {
  const reduced = useReducedMotion()
  const id = useId()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const at = Math.max(0, options.findIndex((option) => option.value === value))

  const onKeyDown = (event: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    const next = (at + step + options.length) % options.length
    onValueChange(options[next].value)
    buttons.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      onKeyDown={disabled ? undefined : onKeyDown}
      className={cn('inline-flex shrink-0 rounded-full bg-kumo-contrast/5 p-0.5', disabled && 'opacity-60', className)}
    >
      {options.map((option, index) => {
        const chosen = index === at
        return (
          <button
            key={option.value}
            ref={(button) => { buttons.current[index] = button }}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen ? 0 : -1}
            disabled={disabled}
            onClick={() => !chosen && onValueChange(option.value)}
            className={cn(
              'relative h-7 rounded-full px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
              chosen ? 'text-kumo-default' : 'text-kumo-subtle not-disabled:hover:text-kumo-default',
            )}
          >
            {chosen && (
              <motion.span
                layoutId={`${id}-chosen`}
                transition={reduced ? { duration: 0 } : { duration: 0.22, ease: EASE }}
                className="absolute inset-0 rounded-full bg-kumo-base ring-1 ring-kumo-line shadow-[0_1px_2px_rgb(0_0_0/0.06)]"
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
