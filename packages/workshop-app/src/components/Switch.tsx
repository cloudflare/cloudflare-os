import { useId, type ReactNode } from 'react'
import { Switch as BaseSwitch } from '@cloudflare/kumo/primitives/switch'
import { cn } from '@cloudflare/kumo/utils'

type SwitchLabel =
  | { label: ReactNode; 'aria-label'?: undefined }
  // Without a label beside it the switch needs an accessible name.
  | { label?: undefined; 'aria-label': string }

export type SwitchProps = SwitchLabel & {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  /**
   * What it was switched to is under way: it still takes focus, unlike one that is `disabled`,
   * so a keyboard user is not thrown out of it mid-change, but switching it does nothing.
   */
  busy?: boolean
  className?: string
}

/**
 * A switch in the app's shape: fully round, as its buttons are, with a round thumb inset in its
 * track, white in either theme, as a light is. Kumo's is a squircle, and its thumb cannot be given
 * another shape from outside. With a `label` it is beside it, and the label switches it too.
 */
export const Switch = ({ label, checked, onCheckedChange, disabled = false, busy = false, className, ...props }: SwitchProps) => {
  const id = useId()
  const control = (
    <BaseSwitch.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => {
        if (!busy) onCheckedChange(next)
      }}
      aria-label={props['aria-label']}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      nativeButton
      render={<button type="button" />}
      className={cn(
        'relative inline-flex h-5 w-8.5 shrink-0 cursor-pointer items-center rounded-full p-0.5',
        // On in Kumo's own switch's blue, which is its `info`, as the brand here is orange.
        'bg-kumo-contrast/12 data-checked:bg-kumo-info',
        'transition-colors duration-150 ease-out motion-reduce:transition-none',
        'outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-base',
        'data-disabled:cursor-default data-disabled:opacity-50 aria-busy:cursor-progress',
        className,
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          // The light theme's surface in either, so it is white on the track whatever it is on.
          'block size-4 rounded-full bg-kumo-base scheme-light shadow-[0_1px_2px_rgb(0_0_0/0.15)]',
          'transition-transform duration-150 ease-out data-checked:translate-x-3.5 motion-reduce:transition-none',
        )}
      />
    </BaseSwitch.Root>
  )
  if (label === undefined) return control
  return (
    <span className="inline-flex items-center gap-2">
      {control}
      <label htmlFor={id} className={cn('text-base font-medium text-kumo-default', disabled ? 'opacity-50' : 'cursor-pointer')}>{label}</label>
    </span>
  )
}
